import { AgentTaskRepository } from './task-repository';
import type { AgentTask } from '../shared/schema';
import { buildCamelSystemMessages } from './camel/camel-prompt-builder';
import { buildLegacyProviderMessages, buildProviderMessages } from './task-message-builder';
import { commitMaterialInjection } from './material-injector';
import {
  getToolExecutionPolicy,
  type ProviderToolArgs,
  ProviderMessage,
  type ProviderImagePart,
  type ProviderRequestMetrics,
  ProviderRunResult,
  ProviderStepResult,
  type ProviderToolDefinition,
  ProviderToolName,
  ProviderToolCall,
  type ProviderUsage,
} from '../providers/provider-adapter';
import { ProviderError, ProviderInvalidToolArgumentsError, ProviderUnknownToolError } from '../providers/provider-errors';
import { ProviderRegistry } from '../providers/provider-registry';
import { SessionRepository } from '../sessions/session-repository';
import { createHash, randomUUID } from 'node:crypto';
import type { InputAttachmentManifest, PromptAsset } from '../shared/schema';
import { withSourceAttribution } from '../shared/result';
import { ToolService } from '../tools/tool-service';
import {
  ExecuteTurnInput as CamelExecuteTurnInput,
  ExecuteTurnOutput as CamelExecuteTurnOutput,
} from './camel/camel-types';
import { appLogger } from '../utils/logger';
import { amberLog } from '../utils/perf-logger';
import type { ToolExecutionResult } from '../tools/glob-tool';
import type { TaskContext } from './task-context';
import fs from 'node:fs';
import path from 'node:path';
import { isTaskCancellationError, throwIfTaskCancelled } from '../shared/task-cancellation';
import {
  getDefaultMaxAgentSteps,
  getIntentLoopLimit,
  getLatestAssistantReferenceBoost,
  getPerToolPreviewChars,
  getPerToolRawChars,
  getPromptToolResultBudgetChars,
  getRepeatedToolLoopLimit,
  getStepBudgetFinalizationBuffer,
  getTierCHintEnabled,
  getToolResultSummaryCharLimit,
  isLegacyCompactMode,
} from './task-runner-config';

export interface RunAgentTaskInput {
  readonly goal: string;
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputContextSummary: string;
  readonly taskContext?: TaskContext;
  readonly prompts?: PromptAsset[];
  readonly memoryIds?: string[];
  readonly uploadedAttachments?: InputAttachmentManifest[];
  readonly signal?: AbortSignal;
}

export interface AgentTaskRunnerOptions {
  readonly maxSteps?: number;
  readonly requestToolApproval?: ToolApprovalHandler;
  readonly requestToolApprovalBatch?: ToolApprovalBatchHandler;
  readonly reportProgress?: (message: string) => void;
  readonly reportAssistantDelta?: (text: string) => void;
  readonly reportRequestMetrics?: (metrics: ProviderRequestMetrics) => void;
}

export interface ToolApprovalRequest {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly toolName: ProviderToolName;
  readonly args: ProviderToolArgs;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
}

export type ToolApprovalDecision = 'allow-once' | 'allow-all' | 'deny';

/**
 * Determines whether a tool operation is considered non-destructive and safe for
 * batch-allow workflows. Destructive operations (e.g., `delete`, or shell commands
 * that perform deletion) return `false` and should still require explicit approval.
 *
 * Currently all built-in tools (`read`, `edit`, `write`, `exec`, `shell_exec`,
 * `glob`, `grep`) are treated as non-destructive. This function exists as an
 * extension point for future tools that may need destructive classification.
 */
export function isNonDestructive(toolName: string, _toolParams: Record<string, unknown>): boolean {
    switch (toolName) {
        case 'read':
        case 'edit':
        case 'write':
        case 'exec':
        case 'shell_exec':
        case 'glob':
        case 'grep':
            return true;
        default:
            return false;
    }
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

export type ToolApprovalBatchHandler = (requests: readonly ToolApprovalRequest[]) => Promise<readonly ToolApprovalDecision[]>;

const CLARIFICATION_FALLBACK_PROMPT = [
  '你已经花费了很多推理步骤，但仍未能得出可靠的最终答案。',
  '你需要跟用户进行需求澄清：首先承认当前目标过于宽泛或模糊，无法可靠地完成。',
  '然后提供几个具体选项，帮助用户进一步明确需求。',
  '每个选项尽量具体且可操作。',
  '保持回应简洁且可直接使用。',
].join(' ');
const STEP_BUDGET_HANDOFF_PROMPT = [
  '你已经达到了本轮任务步骤的预算。',
  '停止调用工具。',
  '写一个简洁的进度报告：本轮完成、剩余工作、推荐的下一步请求。',
  '在本轮完成部分，仅总结本轮已完成或已验证的工作。',
  '在剩余工作部分，列出最重要的未完成任务，这些任务应在后续回合中继续进行。',
  '在推荐的下一步请求部分，建议用户发送一个具体的下一回合请求，以便在不重复已完成工作的情况下继续。',
  '对未完成的工作保持诚实，并保持回应简洁且可操作。',
].join(' ');
const EMPTY_FINAL_RESPONSE_RECOVERY_PROMPT = [
  '上一次响应没有包含可展示给用户的最终内容。',
  '不要调用任何工具。',
  '根据已经完成的工作，只输出面向用户的最终答复。',
  '答复应说明结论、已完成或已验证的事项，以及仍未完成的事项（如有）。',
].join(' ');

interface AgentStepTraceEntry {
  readonly stepNumber: number;
  readonly type: 'tool-call' | 'tool-result' | 'empty-final' | 'final';
  readonly summary: string;
  readonly toolName?: ProviderToolName;
  readonly toolCallId?: string;
}

export interface ModelMessageImageTraceEntry {
  /** Local provenance label when known (workspace-relative path or file name). */
  readonly sourcePath?: string;
  readonly mimeType?: string;
  /** Decoded image size in bytes (0 for non data-URL sources). */
  readonly bytes: number;
  /** First 8 hex chars of the image sha256; a stable, cheap image identity. */
  readonly sha256Prefix: string;
}

export interface ModelMessageTraceMessage {
  readonly role: ProviderMessage['role'];
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: ProviderToolName;
  readonly toolArgs?: ProviderToolArgs;
  /** Number of image parts actually attached to this message (0 when none). */
  readonly imageCount: number;
  /** Per-image fingerprints for observability; never contains base64 payloads. */
  readonly images?: readonly ModelMessageImageTraceEntry[];
}

interface ModelMessageTraceEntry {
  readonly stepNumber: number;
  readonly messages: ModelMessageTraceMessage[];
}

const imageTraceCache = new WeakMap<ProviderImagePart, ModelMessageImageTraceEntry>();

function describeImagePart(part: ProviderImagePart): ModelMessageImageTraceEntry {
  const cached = imageTraceCache.get(part);
  if (cached) {
    return cached;
  }
  const entry = computeImagePartTrace(part);
  imageTraceCache.set(part, entry);
  return entry;
}

function computeImagePartTrace(part: ProviderImagePart): ModelMessageImageTraceEntry {
  const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(part.dataUrl);
  let bytes: Buffer;
  let mimeType = part.mimeType;
  if (!match) {
    bytes = Buffer.from(part.dataUrl, 'utf8');
  } else if (match[2] === ';base64') {
    bytes = Buffer.from(match[3] ?? '', 'base64');
    mimeType = mimeType ?? (match[1] || undefined);
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(match[3] ?? ''), 'utf8');
    } catch {
      bytes = Buffer.from(part.dataUrl, 'utf8');
    }
    mimeType = mimeType ?? (match[1] || undefined);
  }
  return {
    ...(part.sourcePath ? { sourcePath: part.sourcePath } : {}),
    ...(mimeType ? { mimeType } : {}),
    bytes: bytes.byteLength,
    sha256Prefix: createHash('sha256').update(bytes).digest('hex').slice(0, 8),
  };
}

/** Build a base64-free, image-aware trace projection of the exact request messages. */
export function summarizeTraceMessages(messages: readonly ProviderMessage[]): ModelMessageTraceMessage[] {
  return messages.map((message) => {
    const imageParts = message.role === 'user' ? message.imageParts ?? [] : [];
    return {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolArgs: message.toolArgs,
      imageCount: imageParts.length,
      ...(imageParts.length > 0 ? { images: imageParts.map(describeImagePart) } : {}),
    };
  });
}

export class AgentTaskRunner {
  private readonly maxSteps: number;
  private readonly requestToolApproval?: ToolApprovalHandler;
  private readonly requestToolApprovalBatch?: ToolApprovalBatchHandler;
  private readonly reportProgress?: (message: string) => void;
  private readonly reportAssistantDelta?: (text: string) => void;
  private readonly reportRequestMetrics?: (metrics: ProviderRequestMetrics) => void;
  private readonly approvalCache = new Set<string>();
  private isAllowALL:boolean=false;//default is false, if user choose allow-all for a tool, set it to true, then all tools will be allowed without approval
  public setAllowAll(value: boolean): void {
    this.isAllowALL = value;
  }

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly repository: AgentTaskRepository,
    private readonly toolService?: ToolService,
    private readonly sessionRepository?: SessionRepository,
    options: AgentTaskRunnerOptions = {},
  ) {
    this.maxSteps = resolveAgentTaskStepLimit(options.maxSteps);
    this.requestToolApproval = options.requestToolApproval;
    this.requestToolApprovalBatch = options.requestToolApprovalBatch;
    this.reportProgress = options.reportProgress;
    this.reportAssistantDelta = options.reportAssistantDelta;
    this.reportRequestMetrics = options.reportRequestMetrics;
  }

  async run(input: RunAgentTaskInput): Promise<AgentTask> {
    throwIfTaskCancelled(input.signal, 'Task cancelled before execution started.');
    const inputSummary = this.buildInputSummary(input);
    this.providerRegistry.ensureModel(input.providerId, input.modelId);
    const adapter = this.providerRegistry.getAdapter(input.providerId);
    const executionMessages = this.buildExecutionMessages(input);
    this.commitPendingMaterialInjection(input);
    const availableTools = this.toolService?.describeTools() ?? [];
    let task = this.repository.create({
      goal: input.goal,
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      inputContextSummary: inputSummary,
      status: 'pending',
      outputSummary: null,
      toolInvocationIds: [],
    });

    if (input.sessionId) {
      task = this.repository.update(task.id, {
        goal: input.goal,
        sessionId: input.sessionId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputContextSummary: inputSummary,
        status: 'running',
        outputSummary: null,
        toolInvocationIds: [],
      });
    }

    let response: ProviderRunResult | null = null;
    const toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'] = [];
    const toolInvocationIds: string[] = [];
    const stepTrace: AgentStepTraceEntry[] = [];
    const modelMessageTrace: ModelMessageTraceEntry[] = [];
    const providerUsageRef: { current?: ProviderUsage } = {};
    const providerRequestMetricsRef: { current?: ProviderRequestMetrics } = {};
    const streamedAssistantTextRef: { current: string } = { current: '' };

    try {
      this.emitProgress(`Started task: ${truncateProgressMessage(input.goal)}`);
      response = await this.runAgentLoop({
        adapter,
        modelId: input.modelId,
        supportsVision: this.modelSupportsVision(input.providerId, input.modelId),
        taskId: task.id,
        executionCwd: input.taskContext?.targetDirectory ?? undefined,
        availableTools,
        executionMessages,
        toolOutputs,
        toolInvocationIds,
        stepTrace,
        modelMessageTrace,
        providerUsageRef,
        providerRequestMetricsRef,
        streamedAssistantTextRef,
        signal: input.signal,
      });

      // Dump modelMessageTrace and stepTrace to logs/ for debugging context issues
      try {
        const logsDir = path.resolve(process.cwd(), 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const taskId = task.id;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dumpPath = path.join(logsDir, `task-${taskId}-${ts}.json`);
        fs.writeFileSync(
          dumpPath,
          JSON.stringify({ taskId, modelMessageTrace, stepTrace }, null, 2),
          'utf-8',
        );
        appLogger.info(`Context trace dumped: ${dumpPath}`);
      } catch (dumpErr) {
        appLogger.warn('Failed to dump context trace:', dumpErr);
      }

      const enrichedOutput = this.createCompletedOutputSummary(
        input,
        response,
        toolOutputs,
        toolInvocationIds,
        stepTrace,
        modelMessageTrace,
        providerUsageRef.current,
        providerRequestMetricsRef.current,
      );

      return this.repository.update(task.id, {
        goal: input.goal,
        sessionId: input.sessionId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputContextSummary: inputSummary,
        status: 'completed',
        outputSummary: JSON.stringify(enrichedOutput),
        toolInvocationIds,
      });
    } catch (error) {
      if (error instanceof ProviderError && error.requestMetrics) {
        providerRequestMetricsRef.current = mergeProviderRequestMetrics(
          providerRequestMetricsRef.current,
          error.requestMetrics,
        );
        this.reportRequestMetrics?.(error.requestMetrics);
      }

      this.tryPersistFailure(
        task,
        input,
        inputSummary,
        response,
        toolOutputs,
        toolInvocationIds,
        stepTrace,
        modelMessageTrace,
        providerUsageRef.current,
        providerRequestMetricsRef.current,
        streamedAssistantTextRef.current,
        error,
      );
      throw error;
    }
  }

  public async executeTurn(input: CamelExecuteTurnInput): Promise<CamelExecuteTurnOutput> {
    const { context, providerId, modelId, signal } = input;

    // Generate taskId and create a session named 'amber-<taskId>' for FK consistency
    const taskId = randomUUID();
    const session = this.sessionRepository
      ? await this.sessionRepository.create(`amber-${taskId}`)
      : null;

    // Create agent_tasks record to satisfy tool_invocations FK constraint
    const task = this.repository.create({
      id: taskId,
      goal: context.taskLog || 'Camel agent turn execution',
      sessionId: session?.id ?? null,
      providerId,
      modelId,
      inputContextSummary: JSON.stringify(context.contextSummary),
      status: 'running',
    });

    // Build system messages using the camel prompt builder for rich prompts
    const systemMessages = buildCamelSystemMessages(context);
    let turnMessages: ProviderMessage[] = [
      ...systemMessages,
      ...context.turns.flatMap(t => t.messages),
    ];

    const adapter = this.providerRegistry.getAdapter(providerId);
    const availableTools: ProviderToolDefinition[] =
      this.toolService?.describeTools?.() ?? [];
    const executionCwd = this.toolService?.getDefaultExecutionCwd?.();
    const supportsVision = this.modelSupportsVision(providerId, modelId);

    // Step 1: Initial run
    let result = await adapter.runStep({
      modelId,
      messages: turnMessages,
      availableTools,
      supportsVision,
      signal,
    });

    // Handle tool-calls with 'allow-once' strategy
    if (result.type === 'tool-call' || result.type === 'tool-calls') {
      const toolCalls: ProviderToolCall[] =
        result.type === 'tool-calls'
          ? [...result.toolCalls]
          : [this.toProviderToolCall(result)];

      // Execute all tool calls once (allow-once: allow all, no further tool calls)
      const toolResults: ProviderMessage[] = [];
      const toolImageParts: ProviderImagePart[] = [];
      for (const tc of toolCalls) {
        const { output } = await this.executeToolCall(
          /* taskId */ task.id,
          tc,
          executionCwd,
          signal,
          'allow-once',
        );
        toolResults.push({
          role: 'tool',
          content: serializeToolResultForModel(output),
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
        });
        if (output.imageParts && output.imageParts.length > 0) {
          toolImageParts.push(...output.imageParts);
        }
      }

      // Feed tool results back for final response. Images read by tools can only
      // ride on a user message, so append one carrier message when vision is on.
      const updatedMessages: ProviderMessage[] = [
        ...turnMessages,
        {
          role: 'assistant',
          content: '',
          toolCalls,
        },
        ...toolResults,
        ...this.buildToolImageCarrierMessages(supportsVision, toolImageParts),
      ];

      result = await adapter.runStep({
        modelId,
        messages: updatedMessages,
        availableTools,
        supportsVision,
        signal,
      });

      turnMessages = updatedMessages;
    }

    const suggestion =
      result.type === 'final' ? (result.outputSummary ?? '') : '';

    return {
      suggestion,
      context: {
        ...context,
        turns: [...context.turns, { messages: turnMessages, suggestion }],
      },
      turn: { messages: turnMessages, suggestion },
    };
  }

  /** 解析 provider 注册模型中该模型是否支持图片输入（缺省不支持）。 */
  private modelSupportsVision(providerId: string, modelId: string): boolean {
    try {
      const profile = this.providerRegistry.getProfile(providerId);
      const model = profile.models.find((candidate) => candidate.id === modelId);
      return model?.supportsVision === true;
    } catch {
      // Profile 不可解析（如认证缺失）时按不支持处理：收到图片消息会被 adapter 拒绝，属安全缺省。
      return false;
    }
  }

  /**
   * 把工具读取到的图片部件折叠成一条 `user` 消息（Chat Completions 规定图片只能挂在
   * user 消息上，不能塞进 tool 结果）。当模型不支持图片输入时返回空数组，避免 adapter
   * 因消息含图但 `supportsVision=false` 而拒绝整个请求。
   */
  private buildToolImageCarrierMessages(
    supportsVision: boolean,
    imageParts: readonly ProviderImagePart[],
  ): ProviderMessage[] {
    if (!supportsVision || imageParts.length === 0) {
      return [];
    }
    return [
      {
        role: 'user',
        content: '以下是由工具读取到的图片，已作为图像输入提供，请结合图像内容理解上述工具结果。',
        imageParts: [...imageParts],
      },
    ];
  }



  private buildInputSummary(input: RunAgentTaskInput): string {
    return JSON.stringify({
      inputContextSummary: input.inputContextSummary,
      promptIds: this.getPrompts(input).map((prompt) => prompt.id),
      memoryIds: this.getMemoryIds(input),
      uploadedAttachmentIds: input.uploadedAttachments?.map((attachment) => attachment.attachmentId) ?? [],
      workflow: this.getWorkflowMetadata(input),
    });
  }

  private async runAgentLoop(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
    readonly supportsVision: boolean;
    readonly taskId: string;
    readonly executionCwd?: string;
    readonly availableTools: ReturnType<ToolService['describeTools']>;
    readonly executionMessages: ProviderMessage[];
    readonly toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'];
    readonly toolInvocationIds: string[];
    readonly stepTrace: AgentStepTraceEntry[];
    readonly modelMessageTrace: ModelMessageTraceEntry[];
    readonly providerUsageRef: { current?: ProviderUsage };
    readonly providerRequestMetricsRef: { current?: ProviderRequestMetrics };
    readonly streamedAssistantTextRef: { current: string };
    readonly signal?: AbortSignal;
  }): Promise<ProviderRunResult> {
    const messages = [...args.executionMessages];
    let previousToolLoopFingerprint: string | null = null;
    let repeatedToolLoopCount = 0;
    let previousIntentFingerprint: string | null = null;
    let repeatedIntentCount = 0;
    let intentPromptInjected = false;

    // Manual isAllowALL command: "set isAllowALL='true'" or "set isAllowALL='false'"
    {
      const _lastMsg = args.executionMessages[args.executionMessages.length - 1];
      if (_lastMsg?.role === 'user' && typeof _lastMsg.content === 'string') {
        const _cmdMatch = _lastMsg.content.match(/^set\s*isAllowALL\s*=\s*['"]?(true|false)['"]?\s*$/i);
        if (_cmdMatch) {
          const _newVal = _cmdMatch[1] === 'true';
          this.isAllowALL = _newVal;
          const _summary = `isAllowALL 已设置为 ${_newVal}`;
          args.modelMessageTrace.push({
            stepNumber: 1,
            messages: summarizeTraceMessages([{ role: 'system', content: _summary }]),
          });
          return { outputSummary: _summary };
        }
      }
    }

    // Log turn-start context (step 0) for diagnostic analysis
    args.modelMessageTrace.push({
      stepNumber: 0,
      messages: summarizeTraceMessages(messages),
    });

    for (let stepIndex = 0; stepIndex < this.maxSteps; stepIndex += 1) {
      throwIfTaskCancelled(args.signal, 'Task cancelled during agent execution.');
      const stepMessages = prepareMessagesForModel(messages);
      args.modelMessageTrace.push({
        stepNumber: stepIndex + 1,
        messages: summarizeTraceMessages(stepMessages),
      });

      let result: ProviderStepResult;
      let streamedStepText = '';
      try {
        result = await args.adapter.runStep({
          modelId: args.modelId,
          messages: stepMessages,
          availableTools: args.availableTools,
          supportsVision: args.supportsVision,
          signal: args.signal,
          onTextDelta: (text) => {
            streamedStepText += text;
            args.streamedAssistantTextRef.current += text;
            this.reportAssistantDelta?.(text);
          },
        });
      } catch (error) {
        if (error instanceof ProviderUnknownToolError) {
          this.emitProgress(`Step ${stepIndex + 1}: unavailable tool requested - ${error.requestedToolName}`);
          messages.push({
            role: 'user',
            content: this.createUnknownToolRetryPrompt(error, args.availableTools),
          });
          continue;
        }

        if (error instanceof ProviderInvalidToolArgumentsError) {
          this.emitProgress(`Step ${stepIndex + 1}: invalid ${error.toolName} arguments requested`);
          messages.push({
            role: 'user',
            content: this.createInvalidToolArgumentsRetryPrompt(error, args.availableTools),
          });
          continue;
        }

        throw error;
      }

      throwIfTaskCancelled(args.signal, 'Task cancelled during agent execution.');

      args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, result.usage);
      args.providerRequestMetricsRef.current = mergeProviderRequestMetrics(
        args.providerRequestMetricsRef.current,
        result.requestMetrics,
      );

      if (result.requestMetrics) {
        this.reportRequestMetrics?.(result.requestMetrics);
      }

      if (result.type === 'final') {
        const outputSummary = getNonEmptyFinalText(result.outputSummary, streamedStepText);
        if (outputSummary) {
          const source = getNonEmptyFinalText(result.outputSummary)
            ? 'final response ready'
            : 'final response recovered from streamed text';
          this.emitProgress(`Step ${stepIndex + 1}: ${source}`);
          args.stepTrace.push({
            stepNumber: stepIndex + 1,
            type: 'final',
            summary: outputSummary,
          });
          return {
            outputSummary,
            usage: args.providerUsageRef.current,
            requestMetrics: args.providerRequestMetricsRef.current,
          };
        }

        const reason = 'Provider returned an empty terminal response.';
        this.emitProgress(`Step ${stepIndex + 1}: empty final response; requesting recovery`);
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'empty-final',
          summary: reason,
        });
        const recoveryResult = await this.createEmptyFinalResponseRecoveryResult({
          adapter: args.adapter,
          modelId: args.modelId,
          supportsVision: args.supportsVision,
          messages,
          modelMessageTrace: args.modelMessageTrace,
          stepTrace: args.stepTrace,
          stepNumber: stepIndex + 2,
          streamedAssistantTextRef: args.streamedAssistantTextRef,
          signal: args.signal,
        });
        args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, recoveryResult.usage);
        args.providerRequestMetricsRef.current = mergeProviderRequestMetrics(
          args.providerRequestMetricsRef.current,
          recoveryResult.requestMetrics,
        );
        if (recoveryResult.requestMetrics) {
          this.reportRequestMetrics?.(recoveryResult.requestMetrics);
        }
        return {
          outputSummary: recoveryResult.outputSummary,
          usage: args.providerUsageRef.current,
          requestMetrics: args.providerRequestMetricsRef.current,
        };
      }

      const requestedToolCalls = result.type === 'tool-calls'
        ? result.toolCalls
        : [this.toProviderToolCall(result)];

      for (const toolCall of requestedToolCalls) {
        this.emitProgress(`Step ${stepIndex + 1}: running ${formatProgressToolCall(toolCall)}`);
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'tool-call',
          summary: result.rationale ?? `Model requested tool ${toolCall.toolName}`,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
      }

      const approvalDecisions = await this.resolveToolApprovalDecisions(args.taskId, requestedToolCalls);
      const toolExecutions = [] as Array<Awaited<ReturnType<typeof this.executeToolCall>>>;
      for (const toolCall of requestedToolCalls) {
        throwIfTaskCancelled(args.signal, 'Task cancelled before running the next tool.');
        const toolExecution = await this.executeToolCall(
          args.taskId,
          toolCall,
          args.executionCwd,
          args.signal,
          approvalDecisions.get(toolCall.toolCallId) ?? null,
        );
        if (!toolExecution) {
          throw new Error('Tool execution returned undefined');
        }
        args.toolInvocationIds.push(toolExecution.invocation.id);
        args.toolOutputs.push(toolExecution.output);
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'tool-result',
          summary: toolExecution.output.summary,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
        this.emitProgress(`Step ${stepIndex + 1}: ${toolCall.toolName} ${toolExecution.output.status} - ${truncateProgressMessage(toolExecution.output.summary)}`);
        toolExecutions.push(toolExecution);
      }

      if (result.type === 'tool-calls') {
        messages.push({
          role: 'assistant',
          content: result.rationale ?? `Requesting ${requestedToolCalls.length} tools`,
          toolCalls: requestedToolCalls,
          reasoningContent: result.reasoningContent,
        });
      } else {
        messages.push({
          role: 'assistant',
          content: result.rationale ?? `Requesting tool ${result.toolName}`,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          toolArgs: result.args,
          reasoningContent: result.reasoningContent,
        });
      }

      const toolImageParts: ProviderImagePart[] = [];
      for (let toolIndex = 0; toolIndex < requestedToolCalls.length; toolIndex += 1) {
        const toolCall = requestedToolCalls[toolIndex];
        const toolExecution = toolExecutions[toolIndex];
        if (!toolExecution) {
          throw new Error(`Missing tool execution result for ${toolCall.toolName}:${toolCall.toolCallId}`);
        }
        messages.push({
          role: 'tool',
          content: serializeToolResultForModel(toolExecution.output),
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        });
        if (toolExecution.output.imageParts && toolExecution.output.imageParts.length > 0) {
          toolImageParts.push(...toolExecution.output.imageParts);
        }
      }

      messages.push(...this.buildToolImageCarrierMessages(args.supportsVision, toolImageParts));

      const currentToolLoopFingerprint = createToolLoopFingerprint(requestedToolCalls, toolExecutions);
      if (currentToolLoopFingerprint === previousToolLoopFingerprint) {
        repeatedToolLoopCount += 1;
      } else {
        previousToolLoopFingerprint = currentToolLoopFingerprint;
        repeatedToolLoopCount = 1;
      }

      // Intent-based loop detection: same tool + same normalized intent
      // (e.g. reading the same file at different line ranges) counts as a
      // repeat even though the strict fingerprint differs.
      const currentIntentFingerprint = createIntentFingerprint(requestedToolCalls);
      if (currentIntentFingerprint === previousIntentFingerprint) {
        repeatedIntentCount += 1;
      } else {
        previousIntentFingerprint = currentIntentFingerprint;
        repeatedIntentCount = 1;
        intentPromptInjected = false;
      }

      if (repeatedIntentCount >= getIntentLoopLimit() && !intentPromptInjected) {
        intentPromptInjected = true;
        messages.push({
          role: 'system',
          content: INTENT_LOOP_SYSTEM_PROMPT,
        });
      }

      if (repeatedToolLoopCount >= getRepeatedToolLoopLimit()) {
        throwIfTaskCancelled(args.signal, 'Task cancelled during repeated tool loop handling.');
        const clarificationResult = await this.createClarificationFallbackResult({
          adapter: args.adapter,
          modelId: args.modelId,
          supportsVision: args.supportsVision,
          messages,
          modelMessageTrace: args.modelMessageTrace,
          stepTrace: args.stepTrace,
          stepNumber: stepIndex + 2,
          reason: `Agent task entered a repeated ${requestedToolCalls[0]?.toolName ?? 'tool'} loop for ${repeatedToolLoopCount} consecutive steps without making progress`,
          signal: args.signal,
        });
        args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, clarificationResult.usage);
        return {
          outputSummary: clarificationResult.outputSummary,
          usage: args.providerUsageRef.current,
          requestMetrics: clarificationResult.requestMetrics ?? args.providerRequestMetricsRef.current,
        };
      }

      // isAllowALL persists across rounds — use /set isAllowALL=false to disable
    }

    throwIfTaskCancelled(args.signal, 'Task cancelled before step budget handoff.');
    const handoffResult = await this.createStepBudgetHandoffResult({
      adapter: args.adapter,
      modelId: args.modelId,
      supportsVision: args.supportsVision,
      messages,
      modelMessageTrace: args.modelMessageTrace,
      stepTrace: args.stepTrace,
      stepNumber: this.maxSteps + 1,
      reason: `Agent task exceeded ${this.maxSteps} steps without producing a final response`,
      signal: args.signal,
    });
    args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, handoffResult.usage);
    return {
      outputSummary: handoffResult.outputSummary,
      usage: args.providerUsageRef.current,
      requestMetrics: handoffResult.requestMetrics ?? args.providerRequestMetricsRef.current,
    };
  }

  private async createEmptyFinalResponseRecoveryResult(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
    readonly supportsVision: boolean;
    readonly messages: ProviderMessage[];
    readonly modelMessageTrace: ModelMessageTraceEntry[];
    readonly stepTrace: AgentStepTraceEntry[];
    readonly stepNumber: number;
    readonly streamedAssistantTextRef: { current: string };
    readonly signal?: AbortSignal;
  }): Promise<ProviderRunResult> {
    const recoveryMessages = [
      ...args.messages,
      {
        role: 'user' as const,
        content: EMPTY_FINAL_RESPONSE_RECOVERY_PROMPT,
      },
    ];
    const stepMessages = prepareMessagesForModel(recoveryMessages);
    args.modelMessageTrace.push({
      stepNumber: args.stepNumber,
      messages: summarizeTraceMessages(stepMessages),
    });

    let streamedStepText = '';
    const result = await args.adapter.runStep({
      modelId: args.modelId,
      messages: stepMessages,
      availableTools: [],
      supportsVision: args.supportsVision,
      signal: args.signal,
      onTextDelta: (text) => {
        streamedStepText += text;
        args.streamedAssistantTextRef.current += text;
        this.reportAssistantDelta?.(text);
      },
    });

    if (result.type !== 'final') {
      throw new ProviderError('Provider requested tools while recovering an empty final response.', {
        requestMetrics: result.requestMetrics,
      });
    }

    const outputSummary = getNonEmptyFinalText(result.outputSummary, streamedStepText);
    if (!outputSummary) {
      throw new ProviderError('Provider returned no user-facing final response after recovery.', {
        requestMetrics: result.requestMetrics,
      });
    }

    this.emitProgress(`Step ${args.stepNumber}: final response recovery ready`);
    args.stepTrace.push({
      stepNumber: args.stepNumber,
      type: 'final',
      summary: outputSummary,
    });
    return {
      outputSummary,
      usage: result.usage,
      requestMetrics: result.requestMetrics,
    };
  }

  private async createStepBudgetHandoffResult(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
    readonly supportsVision: boolean;
    readonly messages: ProviderMessage[];
    readonly modelMessageTrace: ModelMessageTraceEntry[];
    readonly stepTrace: AgentStepTraceEntry[];
    readonly stepNumber: number;
    readonly reason: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderRunResult> {
    this.emitProgress(`Preparing step budget handoff: ${truncateProgressMessage(args.reason)}`);
    const handoffMessages = [
      ...args.messages,
      {
        role: 'user' as const,
        content: `${STEP_BUDGET_HANDOFF_PROMPT}\nReason: ${args.reason}`,
      },
    ];

    const stepMessages = prepareMessagesForModel(handoffMessages);
    args.modelMessageTrace.push({
      stepNumber: args.stepNumber,
      messages: summarizeTraceMessages(stepMessages),
    });

    try {
      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages: stepMessages,
        availableTools: [],
        supportsVision: args.supportsVision,
        signal: args.signal,
      });

      if (result.type === 'final') {
        this.emitProgress(`Step ${args.stepNumber}: step budget handoff ready`);
        args.stepTrace.push({
          stepNumber: args.stepNumber,
          type: 'final',
          summary: result.outputSummary,
        });
        return {
          outputSummary: result.outputSummary,
          usage: result.usage,
          requestMetrics: result.requestMetrics,
        };
      }
    } catch {
      // Fall through to the local handoff response.
    }

    const fallbackOutputSummary = createLocalStepBudgetHandoff(args.reason, args.stepTrace);
    this.emitProgress(`Step ${args.stepNumber}: local step budget handoff ready`);
    args.stepTrace.push({
      stepNumber: args.stepNumber,
      type: 'final',
      summary: fallbackOutputSummary,
    });
    return { outputSummary: fallbackOutputSummary };
  }

  private async createClarificationFallbackResult(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
    readonly supportsVision: boolean;
    readonly messages: ProviderMessage[];
    readonly modelMessageTrace: ModelMessageTraceEntry[];
    readonly stepTrace: AgentStepTraceEntry[];
    readonly stepNumber: number;
    readonly reason: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderRunResult> {
    this.emitProgress(`Preparing clarification fallback: ${truncateProgressMessage(args.reason)}`);
    const clarificationMessages = [
      ...args.messages,
      {
        role: 'user' as const,
        content: `${CLARIFICATION_FALLBACK_PROMPT}\nReason: ${args.reason}`,
      },
    ];

    const stepMessages = prepareMessagesForModel(clarificationMessages);//
    args.modelMessageTrace.push({
      stepNumber: args.stepNumber,
      messages: summarizeTraceMessages(stepMessages),
    });

    try {
      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages: stepMessages,
        availableTools: [],
        supportsVision: args.supportsVision,
        signal: args.signal,
      });

      if (result.type === 'final') {
        this.emitProgress(`Step ${args.stepNumber}: clarification response ready`);
        args.stepTrace.push({
          stepNumber: args.stepNumber,
          type: 'final',
          summary: result.outputSummary,
        });
        return {
          outputSummary: result.outputSummary,
          usage: result.usage,
          requestMetrics: result.requestMetrics,
        };
      }
    } catch {
      // Fall through to the local clarification response.
    }

    const fallbackOutputSummary = createLocalClarificationFallback(args.reason);
    this.emitProgress(`Step ${args.stepNumber}: local clarification response ready`);
    args.stepTrace.push({
      stepNumber: args.stepNumber,
      type: 'final',
      summary: fallbackOutputSummary,
    });
    return { outputSummary: fallbackOutputSummary };
  }

  private emitProgress(message: string): void {
    this.reportProgress?.(message);
  }

  private createUnknownToolRetryPrompt(
    error: ProviderUnknownToolError,
    availableTools: readonly ProviderToolDefinition[],
  ): string {
    const toolCatalog = availableTools.length > 0
      ? availableTools.map((tool) => this.describeAvailableTool(tool)).join('\n')
      : 'No tools are available in this runtime. Continue without tool calls and answer directly.';

    return [
      `这个工具 "${error.requestedToolName}" 在此运行时不可用。请勿再次调用。`,
      '仅使用下列工具名称，或者如果不需要工具，请直接回复最终答案。',
      '可用工具:',
      toolCatalog,
    ].join('\n');
  }

  private createInvalidToolArgumentsRetryPrompt(
    error: ProviderInvalidToolArgumentsError,
    availableTools: readonly ProviderToolDefinition[],
  ): string {
    const toolCatalog = availableTools.length > 0
      ? availableTools.map((tool) => this.describeAvailableTool(tool)).join('\n')
      : 'No tools are available in this runtime. Continue without tool calls and answer directly.';
    const validationDetails = error.issues.length > 0
      ? error.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')
      : '- Invalid tool arguments.';

    return [
      `工具 "${error.toolName}" 的参数无效。请勿再次调用相同的无效工具。`,
      '验证错误:',
      validationDetails,
      '修正参数并仅使用下列工具名称和模式，或者如果不需要工具，请直接回复最终答案。',
      '可用工具:',
      toolCatalog,
    ].join('\n');
  }

  private describeAvailableTool(tool: ProviderToolDefinition): string {
    const requiredFieldsList = tool.inputSchema.required ?? [];
    const executionPolicy = tool.executionPolicy ?? 'free';
    const requiredFields = requiredFieldsList.length > 0
      ? requiredFieldsList.join(', ')
      : 'none';
    const optionalFields = Object.keys(tool.inputSchema.properties ?? {}).filter((propertyName) => !requiredFieldsList.includes(propertyName));

    return [
      `- ${tool.name} (${executionPolicy})`,
      `  ${tool.description}`,
      `  Required fields: ${requiredFields}`,
      `  Optional fields: ${optionalFields.length > 0 ? optionalFields.join(', ') : 'none'}`,
    ].join('\n');
  }

  private executeToolCall(
    taskId: string,
    result: ProviderToolCall,
    executionCwd?: string,
    signal?: AbortSignal,
    approvalDecision?: ToolApprovalDecision | null,
  ) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${result.toolName}`);
    }

    const inputSummary = JSON.stringify({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: result.args,
    });

    return this.executeToolCallWithApproval({
      taskId,
      result,
      inputSummary,
      executionCwd,
      signal,
      approvalDecision,
    });
  }

  private async resolveToolApprovalDecisions(
    taskId: string,
    toolCalls: readonly ProviderToolCall[],
  ): Promise<Map<string, ToolApprovalDecision>> {
    if (!this.toolService) {
      throw new Error('Tool service is required to resolve tool approvals');
    }

    const pendingRequests = toolCalls
      .map((toolCall) => ({
        toolCall,
        approvalCacheKey: createApprovalCacheKey(toolCall),
      }))
      .filter(({ toolCall, approvalCacheKey }) => (
        getToolExecutionPolicy(toolCall.toolName) === 'approval-required'
        && requiresInteractiveApproval(toolCall)
        && (!approvalCacheKey || !this.approvalCache.has(approvalCacheKey))
      ))
      .map(({ toolCall, approvalCacheKey }) => ({
        toolCall,
        approvalCacheKey,
        request: this.buildToolApprovalRequest(taskId, toolCall),
      }));

    if (pendingRequests.length === 0) {
      return new Map<string, ToolApprovalDecision>();
    }
    // isAllowALL: auto-approve non-mustApproval tools, prompt only for dangerous commands
    if (this.isAllowALL) {
      const approvals = new Map<string, ToolApprovalDecision>();
      const mustApprovalRequests: typeof pendingRequests = [];

      for (const pr of pendingRequests) {
        const { toolCall } = pr;
        const isShellExec = toolCall.toolName === 'shell_exec' || toolCall.toolName === 'exec';
        const command = isShellExec ? String((toolCall.args as { command?: string }).command ?? '') : '';
        appLogger.debug(`tool call ${toolCall.toolName} with command "${command}".is approvalling: ${isShellExec && this.isMustApproval(command)}`);
        if (isShellExec && this.isMustApproval(command)) {
          mustApprovalRequests.push(pr); // Still needs user approval
          appLogger.debug(`tool call ${toolCall.toolName} with command "${command}".must approval`);
        } else {
          approvals.set(pr.request.toolCallId, 'allow-once'); // Auto-approve
          appLogger.debug(`tool call ${toolCall.toolName} with command "${command}".auto-approved`);
        }
      }

      if (mustApprovalRequests.length > 0) {
        const approvalDecisions = this.requestToolApprovalBatch
          ? await this.requestToolApprovalBatch(mustApprovalRequests.map((entry) => entry.request))
          : await Promise.all(
            mustApprovalRequests.map(async ({ request }) => this.requestToolApproval?.(request) ?? 'deny'),
          );

        for (let index = 0; index < mustApprovalRequests.length; index += 1) {
          const decision = approvalDecisions[index] ?? 'deny';
          const pendingRequest = mustApprovalRequests[index];

          approvals.set(pendingRequest.request.toolCallId, decision);

          // Only cache allow-all decisions
          if (decision === 'allow-all' && pendingRequest.approvalCacheKey) {
            this.approvalCache.add(pendingRequest.approvalCacheKey);
          //  this.isAllowALL = true;
          }
        }
      }

      return approvals;
    }
    const approvalDecisions = this.requestToolApprovalBatch
      ? await this.requestToolApprovalBatch(pendingRequests.map((entry) => entry.request))
      : await Promise.all(
        pendingRequests.map(async ({ request }) => this.requestToolApproval?.(request) ?? 'deny'),
      );

    if (approvalDecisions.length !== pendingRequests.length) {
      throw new Error(`Expected ${pendingRequests.length} tool approval decisions but received ${approvalDecisions.length}`);
    }

    const approvals = new Map<string, ToolApprovalDecision>();

    for (let index = 0; index < pendingRequests.length; index += 1) {
      const decision = approvalDecisions[index] ?? 'deny';
      const pendingRequest = pendingRequests[index];

      approvals.set(pendingRequest.request.toolCallId, decision);

      if (decision === 'allow-all' && pendingRequest.approvalCacheKey) {
        this.approvalCache.add(pendingRequest.approvalCacheKey);
      }
    }

    return approvals;
  }
  private isMustApproval(command:string):boolean{
    const mustApprovalCommands=['rm','del','format','shutdown','reboot'];
    const pattern = new RegExp(
    `(?:^|[|&;>\n\`(\\s])(${mustApprovalCommands.join('|')})(?:$|[\\s|&;>\n\`)])`,
    'i'
    );
    return pattern.test(command);
    }
  private buildToolApprovalRequest(taskId: string, toolCall: ProviderToolCall): ToolApprovalRequest {
    if (!this.toolService) {
      throw new Error(`Tool service is required to describe tool approval: ${toolCall.toolName}`);
    }

    const approvalDescription = this.toolService.describeApproval(toolCall);

    return {
      taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      args: toolCall.args,
      title: approvalDescription.title,
      summary: approvalDescription.summary,
      detail: approvalDescription.detail,
    };
  }

  private async executeToolCallWithApproval(args: {
    readonly taskId: string;
    readonly result: ProviderToolCall;
    readonly inputSummary: string;
    readonly executionCwd?: string;
    readonly signal?: AbortSignal;
    readonly approvalDecision?: ToolApprovalDecision | null;
  }) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${args.result.toolName}`);
    }
    // Build approval cache key for this specific tool invocation
    const approvalCacheKey = createApprovalCacheKey(args.result);

    // Case 1: Pre-resolved approval decision from resolveToolApprovalDecisions
    if (args.approvalDecision !== undefined && args.approvalDecision !== null) {
      if (args.approvalDecision === 'deny') {
        // Pre-resolved deny - return failure
        const output: ToolExecutionResult = {
          toolName: args.result.toolName,
          status: 'failed',
          summary: `Execution denied: user approval is required before running ${args.result.toolName}`,
          output: [
            `tool: ${args.result.toolName}`,
            'approvalRequired: true',
            `decision: ${args.approvalDecision}`,
          ],
        };
        const invocation = this.toolService.recordInvocation({
          toolName: args.result.toolName,
          taskId: args.taskId,
          inputSummary: args.inputSummary,
          resultStatus: output.status,
          resultSummary: output.summary,
        });
        return { invocation, output };
      }
      // allow-once or allow-all - proceed to execute
      // Only cache allow-all for future calls
      if (args.approvalDecision === 'allow-all' && approvalCacheKey) {
        this.approvalCache.add(approvalCacheKey);
      }
    } else {
      // Case 2: No pre-resolved decision - determine if approval is needed now
      if (getToolExecutionPolicy(args.result.toolName) === 'approval-required' && requiresInteractiveApproval(args.result)) {
        // Tool requires approval - check cache first
        if (approvalCacheKey && this.approvalCache.has(approvalCacheKey)) {
          // Cached approval from previous allow-all - proceed to execute
        } else {
          // Not cached - need user approval
          const approvalDecision = await this.requestToolApproval?.(
            this.buildToolApprovalRequest(args.taskId, args.result)
          ) ?? 'deny';

          if (approvalDecision === 'deny') {
            // Denied by user - return failure
            const output: ToolExecutionResult = {
              toolName: args.result.toolName,
              status: 'failed',
              summary: `Execution denied: user approval is required before running ${args.result.toolName}`,
              output: [
                `tool: ${args.result.toolName}`,
                'approvalRequired: true',
                `decision: ${approvalDecision}`,
              ],
            };
            const invocation = this.toolService.recordInvocation({
              toolName: args.result.toolName,
              taskId: args.taskId,
              inputSummary: args.inputSummary,
              resultStatus: output.status,
              resultSummary: output.summary,
            });
            return { invocation, output };
          }

          // Only cache allow-all decisions; allow-once runs once without caching
          if (approvalDecision === 'allow-all' && approvalCacheKey) {
            this.approvalCache.add(approvalCacheKey);
          }
        }
      }
      // Tool does not require approval - proceed to execute directly
    }
    //如果传入的approvalDecision为allow-once或allow-all，或者之前已经批准过（存在于缓存中），则继续执行工具调用
   /*  
    if (
    //  getToolExecutionPolicy(args.result.toolName) === 'approval-required'
    //  && requiresInteractiveApproval(args.result) &&
       (!approvalCacheKey || !this.approvalCache.has(approvalCacheKey))
    ) {
      const approvalDecision = args.approvalDecision
        ?? await this.requestToolApproval?.(this.buildToolApprovalRequest(args.taskId, args.result))
        ?? 'deny';

      if (approvalDecision === 'allow-all' && approvalCacheKey) {
        this.approvalCache.add(approvalCacheKey);
      //  this.isAllowALL = true;
      }

      if (approvalDecision === 'deny') {
        const output: ToolExecutionResult = {
          toolName: args.result.toolName,
          status: 'failed',
          summary: `Execution denied: user approval is required before running ${args.result.toolName}`,
          output: [
            `tool: ${args.result.toolName}`,
            'approvalRequired: true',
            `decision: ${approvalDecision}`,
          ],
        };
        const invocation = this.toolService.recordInvocation({
          toolName: args.result.toolName,
          taskId: args.taskId,
          inputSummary: args.inputSummary,
          resultStatus: output.status,
          resultSummary: output.summary,
        });

        return { invocation, output };
      }
    }
      */

    switch (args.result.toolName) {
      case 'glob':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'glob',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'grep':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'grep',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'exec':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'exec',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
          onOutput: (data: string) => { this.reportProgress?.(data); },
        });
      case 'shell_exec':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'shell_exec',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
          onOutput: (data: string) => { this.reportProgress?.(data); },
        });
      case 'read':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'read',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'edit':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'edit',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'write':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'write',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'undo_edit':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'undo_edit',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
      case 'memo_recall':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'memo_recall',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });

      default:
        // MCP tool calls (mcp__<server>__<tool>)
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: (args.result as any).toolName,
          args: (args.result as any).args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
        });
    }
  }

  private toProviderToolCall(result: Extract<ProviderStepResult, { type: 'tool-call' }>): ProviderToolCall {
    switch (result.toolName) {
      case 'glob':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'grep':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'exec':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'shell_exec':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'read':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'edit':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'write':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'undo_edit':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };
      case 'memo_recall':
        return {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: result.args,
        };

      default:
        // MCP tool calls (mcp__<server>__<tool>) — pass through as-is
        return {
          toolCallId: (result as any).toolCallId,
          toolName: (result as any).toolName,
          args: (result as any).args,
        };
    }
  }

  /**
   * P0: commit the planned material injection only once the request messages are
   * actually built. Reaching this point means the images were attached to the user
   * message about to be sent; a failure before it leaves the manifest untouched so
   * the next turn can retry the delivery.
   */
  private commitPendingMaterialInjection(input: RunAgentTaskInput): void {
    const plan = input.taskContext?.materialCommit;
    if (plan && plan.images.length > 0) {
      commitMaterialInjection(plan);
    }
  }

  private buildExecutionMessages(input: RunAgentTaskInput): ProviderMessage[] {
    const baseMessages = input.taskContext
      ? buildProviderMessages(input.taskContext, input.goal)
      : buildLegacyProviderMessages(input.goal, input.inputContextSummary);

    return insertSystemMessageBeforeLatestUser(baseMessages, createStepBudgetExecutionMessage(this.maxSteps));
  }

  private getPrompts(input: RunAgentTaskInput): PromptAsset[] {
    return input.taskContext?.prompts ?? input.prompts ?? [];
  }

  private getMemoryIds(input: RunAgentTaskInput): string[] {
    const resultItemMemoryIds = input.taskContext?.resultItems.map((item) => item.memoryId) ?? input.memoryIds ?? [];
    const workflowContext = input.taskContext?.workflowContext;

    return uniqueValues([
      ...resultItemMemoryIds,
      workflowContext?.planMemoryId ?? null,
      workflowContext?.todoMemoryId ?? null,
    ].filter((memoryId): memoryId is string => Boolean(memoryId)));
  }

  private getWorkflowMetadata(input: RunAgentTaskInput) {
    const workflowContext = input.taskContext?.workflowContext;
    if (!workflowContext) {
      return null;
    }

    return {
      workflowId: workflowContext.workflowId,
      workflowType: workflowContext.workflowType,
      status: workflowContext.status,
      activeRoundNumber: workflowContext.activeRoundNumber,
      planMemoryId: workflowContext.planMemoryId,
      todoMemoryId: workflowContext.todoMemoryId,
    };
  }

  private createCompletedOutputSummary(
    input: RunAgentTaskInput,
    response: ProviderRunResult,
    toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'],
    toolInvocationIds: string[],
    stepTrace: AgentStepTraceEntry[],
    modelMessageTrace: ModelMessageTraceEntry[],
    providerUsage: ProviderUsage | undefined,
    providerRequestMetrics: ProviderRequestMetrics | undefined,
  ) {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);

    return withSourceAttribution(
      {
        outputSummary: response.outputSummary,
        providerUsage,
        providerRequestMetrics,
        targetDirectory,
        toolExecutionCwd,
        workflow: this.getWorkflowMetadata(input),
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemoryIds(input),
        toolInvocationIds,
        toolNames: toolOutputs.map((output) => output.toolName),
        modelMessageTrace,
        stepTrace,
        toolResults: toolOutputs.map((output) => ({
          toolName: output.toolName,
          status: output.status,
          summary: output.summary,
          executionCwd: toolExecutionCwd,
        })),
        fileChanges: aggregateFileChanges(toolOutputs),
      },
      {
        modelOutput: response.outputSummary,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemoryIds(input),
        toolNames: toolOutputs.map((output) => output.toolName),
      },
    );
  }

  private tryPersistFailure(
    task: AgentTask,
    input: RunAgentTaskInput,
    inputSummary: string,
    response: ProviderRunResult | null,
    toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'],
    toolInvocationIds: string[],
    stepTrace: AgentStepTraceEntry[],
    modelMessageTrace: ModelMessageTraceEntry[],
    providerUsage: ProviderUsage | undefined,
    providerRequestMetrics: ProviderRequestMetrics | undefined,
    streamedAssistantText: string,
    error: unknown,
  ): void {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);
    const cancelledOutputSummary = isTaskCancellationError(error)
      ? getNonEmptyFinalText(response?.outputSummary ?? '', streamedAssistantText)
      : null;
    const resolvedFailureOutputSummary = cancelledOutputSummary
      ?? `Task failed: ${this.getErrorMessage(error)}`;
    const failureOutput = withSourceAttribution(
      {
        outputSummary: resolvedFailureOutputSummary,
        providerUsage,
        providerRequestMetrics,
        targetDirectory,
        toolExecutionCwd,
        workflow: this.getWorkflowMetadata(input),
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemoryIds(input),
        toolInvocationIds,
        toolNames: toolOutputs.map((output) => output.toolName),
        modelMessageTrace,
        stepTrace,
        toolResults: toolOutputs.map((output) => ({
          toolName: output.toolName,
          status: output.status,
          summary: output.summary,
          executionCwd: toolExecutionCwd,
        })),
        fileChanges: aggregateFileChanges(toolOutputs),
      },
      {
        modelOutput: cancelledOutputSummary ?? response?.outputSummary,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemoryIds(input),
        toolNames: toolOutputs.map((output) => output.toolName),
      },
    );

    try {
      this.repository.update(task.id, {
        goal: input.goal,
        sessionId: input.sessionId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputContextSummary: inputSummary,
        status: 'failed',
        outputSummary: JSON.stringify(failureOutput),
        toolInvocationIds,
      });
    } catch {
      // Preserve the original task failure when persistence of the failure state also fails.
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private resolveTaskExecutionCwd(input: RunAgentTaskInput): string | null {
    if (input.taskContext?.targetDirectory) {
      return input.taskContext.targetDirectory;
    }

    const toolServiceWithDefaultCwd = this.toolService as { getDefaultExecutionCwd?: () => string } | undefined;
    return toolServiceWithDefaultCwd?.getDefaultExecutionCwd?.() ?? null;
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function getNonEmptyFinalText(...candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function mergeProviderUsage(current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!current) {
    return next ? cloneProviderUsage(next) : undefined;
  }

  if (!next) {
    return cloneProviderUsage(current);
  }

  return {
    promptTokens: sumProviderUsageNumber(current.promptTokens, next.promptTokens),
    completionTokens: sumProviderUsageNumber(current.completionTokens, next.completionTokens),
    totalTokens: sumProviderUsageNumber(current.totalTokens, next.totalTokens),
    promptCacheHitTokens: sumProviderUsageNumber(current.promptCacheHitTokens, next.promptCacheHitTokens),
    promptCacheMissTokens: sumProviderUsageNumber(current.promptCacheMissTokens, next.promptCacheMissTokens),
    promptTokensDetails: mergePromptUsageDetails(current, next),
    completionTokensDetails: mergeCompletionUsageDetails(current, next),
  };
}

function mergeProviderRequestMetrics(
  current: ProviderRequestMetrics | undefined,
  next: ProviderRequestMetrics | undefined,
): ProviderRequestMetrics | undefined {
  if (!next) {
    return current ? { ...current, roleCounts: { ...current.roleCounts } } : undefined;
  }

  return {
    ...next,
    roleCounts: { ...next.roleCounts },
  };
}

function cloneProviderUsage(usage: ProviderUsage): ProviderUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    promptCacheHitTokens: usage.promptCacheHitTokens,
    promptCacheMissTokens: usage.promptCacheMissTokens,
    promptTokensDetails: usage.promptTokensDetails
      ? { cachedTokens: usage.promptTokensDetails.cachedTokens }
      : undefined,
    completionTokensDetails: usage.completionTokensDetails
      ? { reasoningTokens: usage.completionTokensDetails.reasoningTokens }
      : undefined,
  };
}

function mergePromptUsageDetails(current: ProviderUsage, next: ProviderUsage): ProviderUsage['promptTokensDetails'] {
  const cachedTokens = sumProviderUsageNumber(current.promptTokensDetails?.cachedTokens, next.promptTokensDetails?.cachedTokens);
  return cachedTokens === undefined ? undefined : { cachedTokens };
}

function mergeCompletionUsageDetails(current: ProviderUsage, next: ProviderUsage): ProviderUsage['completionTokensDetails'] {
  const reasoningTokens = sumProviderUsageNumber(
    current.completionTokensDetails?.reasoningTokens,
    next.completionTokensDetails?.reasoningTokens,
  );
  return reasoningTokens === undefined ? undefined : { reasoningTokens };
}

function sumProviderUsageNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}

/**
 * Strict fingerprint: identical toolName + args + output. Used to detect
 * true "repeater" loops where the model re-issues the exact same request.
 */
export function createToolLoopFingerprint(
  toolCalls: readonly ProviderToolCall[],
  toolExecutions: Array<Awaited<ReturnType<AgentTaskRunner['executeToolCall']>>>,
): string {
  return JSON.stringify({
    toolCalls: toolCalls.map((toolCall) => ({
      toolName: toolCall.toolName,
      args: toolCall.args,
    })),
    toolResults: toolExecutions.filter((e): e is NonNullable<typeof e> => e != null).map((execution) => ({
      toolName: execution.output.toolName,
      status: execution.output.status,
      output: execution.output.output,
    })),
  });
}

/**
 * Intent fingerprint: normalizes tool arguments so "same intent, different
 * line range" loops (e.g. reading the same file at different offsets) are
 * detected. For `read` the startLine/endLine are dropped; for `grep`/`glob`
 * only the pattern+include is kept; for `exec`/`shell_exec` only the first
 * command token is used.
 */
export function createIntentFingerprint(toolCalls: readonly ProviderToolCall[]): string {
  return JSON.stringify({
    intents: toolCalls.map((toolCall) => normalizeToolCallIntent(toolCall)),
  });
}

function normalizeToolCallIntent(toolCall: ProviderToolCall): { toolName: string; key: string } {
  switch (toolCall.toolName) {
    case 'read':
    case 'edit':
    case 'write':
    case 'undo_edit':
      return { toolName: toolCall.toolName, key: normalizeReferenceToken(toolCall.args.path) };
    case 'grep':
      return {
        toolName: toolCall.toolName,
        key: `${normalizeReferenceToken(toolCall.args.pattern)}:${toolCall.args.include ?? ''}`,
      };
    case 'glob':
      return { toolName: toolCall.toolName, key: normalizeReferenceToken(toolCall.args.pattern) };
    case 'exec':
    case 'shell_exec': {
      const firstToken = splitExecCommand(toolCall.args.command)[0] ?? '';
      return { toolName: toolCall.toolName, key: normalizeReferenceToken(firstToken) };
    }
    default:
      return { toolName: toolCall.toolName as string, key: '' };
  }
}

const INTENT_LOOP_SYSTEM_PROMPT = '你已经对相同的文件或目标反复调用同一工具，但未取得进展。请直接基于已读到的内容作答，或改用 grep 精确定位，不要继续重复读取相同范围。';

function createLocalClarificationFallback(reason: string): string {
  return [
    '本次任务复杂，已经分析了较长时间。我们最好聚焦完成眼前的几件事。',
    `当前状态：${reason}`,
    '你可以任选一种方式继续：',
    '1. 指定要分析的文件、模块或失败命令。',
    '2. 指定要回答的问题类型，例如“根因定位”、“风险评审”或“修改方案”。',
    '3. 指定期望产物，例如“给出 3 条结论”或“直接修改并验证”。',
  ].join('\n');
}

function createLocalStepBudgetHandoff(reason: string, stepTrace: readonly AgentStepTraceEntry[]): string {
  const completedSummaries = stepTrace
    .filter((entry) => entry.type === 'tool-result' || entry.type === 'final')
    .slice(-5)
    .map((entry) => `- 第 ${entry.stepNumber} 步：${entry.summary}`);

  const completedSection = completedSummaries.length > 0
    ? completedSummaries
    : ['- 本轮已经完成部分分析与执行，但未能在当前步数预算内收尾。'];

  return [
    'Completed this round',
    ...completedSection,
    '',
    'Remaining work',
    `- ${reason}`,
    '- 请在下一轮继续剩余文件检查、修改或验证，而不是重复本轮已经完成的步骤。',
    '',
    'Recommended next request',
    '- 请继续当前任务，但只处理最重要的前 1 到 3 个剩余子任务，并在完成后继续汇报已完成与剩余工作。',
  ].join('\n');
}

function createStepBudgetExecutionMessage(maxSteps: number): string {
  const finalizationThreshold = Math.max(1, maxSteps - getStepBudgetFinalizationBuffer());
  return [
    '执行预算政策：',
    `- 每轮交互有 ${maxSteps} 步的硬性模型调用限制。`,
    `- 在任务开始前，先评估请求能否在 ${maxSteps} 步内完成。`,
    '- 如果超过步数限制，就对工作进行切分，划分为多个子任务，进行任务排序并列出计划。',
    `- 按照顺序选择几个能在 ${finalizationThreshold} 步内完成的子任务。先完成这些子任务，并把剩余的工作留到后续轮次继续。`,
    '- 每当你把工作交给后续轮次时，反馈：（本轮已完成、剩余工作、推荐下一步）。',
    `- 如果在 ${finalizationThreshold} 步数内仍无法得到对工作的有效评估或规划，则先引导用户进一步明确其目标。`,
  ].join('\n');
}

function insertSystemMessageBeforeLatestUser(messages: readonly ProviderMessage[], content: string): ProviderMessage[] {
  if (messages.length === 0) {
    return [{ role: 'system', content }];
  }

  let userMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      userMessageIndex = index;
      break;
    }
  }

  if (userMessageIndex === -1) {
    return [...messages, { role: 'system', content }];
  }

  return [
    ...messages.slice(0, userMessageIndex),
    { role: 'system', content },
    ...messages.slice(userMessageIndex),
  ];
}

function requiresInteractiveApproval(toolCall: ProviderToolCall): boolean {
  if (toolCall.toolName === 'shell_exec') {
    return true;
  }

  if (toolCall.toolName !== 'exec') {
    return true;
  }

  return classifyExecCommandRisk(toolCall.args.command) !== 'read-only';
}

function createApprovalCacheKey(toolCall: ProviderToolCall): string | null {
  const toolName: string = toolCall.toolName;

  switch (toolCall.toolName) {
    case 'edit':
      return `edit:${normalizeApprovalCacheToken(toolCall.args.path)}`;
    case 'write':
      return `write:${normalizeApprovalCacheToken(toolCall.args.path)}`;
    case 'exec':
      return `exec:${normalizeApprovalCacheToken(toolCall.args.command)}`;
    case 'shell_exec':
      return `shell_exec:${toolCall.args.mode}:${normalizeApprovalCacheToken(toolCall.args.command)}`;
    case 'glob':
    case 'grep':
    case 'read':
      return null;
  }

  // Unknown tools (e.g. provider-specific extensions): use the tool
  // name as the cache key so "Allow All" can cover subsequent
  // invocations of the same tool throughout the task.
  return toolName;
}

function normalizeApprovalCacheToken(value: string): string {
  return value.trim().replace(/\\/g, '/').toLowerCase();
}

function classifyExecCommandRisk(command: string): 'read-only' | 'mutating' {
  const parts = splitExecCommand(command);
  const executable = normalizeExecutableName(parts[0] ?? '');
  const subcommand = (parts[1] ?? '').trim().toLowerCase();

  if (!executable) {
    return 'mutating';
  }

  if (READ_ONLY_EXEC_COMMANDS.has(executable)) {
    return 'read-only';
  }

  if (executable === 'git' && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return 'read-only';
  }

  return 'mutating';
}

function splitExecCommand(commandText: string): string[] {
  const matches = commandText.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

function normalizeExecutableName(command: string): string {
  return command.split(/[\\/]/).at(-1)?.trim().toLowerCase() ?? '';
}

const READ_ONLY_EXEC_COMMANDS = new Set([
  'dir',
  'ls',
  'findstr',
  'rg',
  'type',
  'cat',
  'more',
  'where',
  'which',
  'pwd',
  'get-childitem',
  'select-string',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'grep',
  'rev-parse',
]);
/**
 * Compose the message list shown to the model for a single step.
 *
 * Tier A (the trailing tool messages produced by the most recent step) is
 * kept verbatim so the model always sees its latest tool results. Every
 * earlier tool message is compacted through a character-budgeted tiered
 * strategy (`budgetedPrepareToolMessages`) instead of being flattened to a
 * one-line summary, which previously caused the model to re-read the same
 * files repeatedly. Set `PUEBLO_COMPACT_MODE=legacy` to restore the old
 * one-line behaviour.
 */
export function prepareMessagesForModel(messages: ProviderMessage[]): ProviderMessage[] {
  if (isLegacyCompactMode()) {
    return prepareLegacyCompactMessages(messages);
  }
  return budgetedPrepareToolMessages(messages);
}

function prepareLegacyCompactMessages(messages: ProviderMessage[]): ProviderMessage[] {
  const firstTrailingToolIndex = resolveFirstTrailingToolIndex(messages);

  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= firstTrailingToolIndex) {
      return message;
    }

    return {
      ...message,
      content: compactToLegacy(message),
    };
  });
}

/**
 * Find the index of the first message in the trailing `role=tool` run. All
 * tool messages at or after this index form Tier A and are kept verbatim.
 */
function resolveFirstTrailingToolIndex(messages: readonly ProviderMessage[]): number {
  let firstTrailingToolIndex = messages.length;
  while (firstTrailingToolIndex > 0 && messages[firstTrailingToolIndex - 1]?.role === 'tool') {
    firstTrailingToolIndex -= 1;
  }
  return firstTrailingToolIndex;
}

interface ToolMessageWithIndex {
  readonly message: ProviderMessage;
  readonly index: number;
}

/**
 * Tiered, budget-aware replacement for the legacy "compact everything older
 * than the trailing tool run" behaviour.
 *
 * 1. Determine Tier A (trailing tool run) — kept verbatim.
 * 2. Collect every earlier tool message, newest first.
 * 3. Boost messages whose tool result references the same path/pattern as the
 *    latest assistant tool request (`LATEST_ASSISTANT_REFERENCE_BOOST`).
 * 4. Walk newest→oldest, accumulating Tier B preview characters against
 *    `PROMPT_TOOL_RESULT_BUDGET_CHARS`. Messages that fit become Tier B;
 *    everything beyond the budget becomes Tier C.
 */
function budgetedPrepareToolMessages(messages: ProviderMessage[]): ProviderMessage[] {
  const firstTrailingToolIndex = resolveFirstTrailingToolIndex(messages);

  const olderToolMessages: ToolMessageWithIndex[] = [];
  for (let index = 0; index < firstTrailingToolIndex; index += 1) {
    const message = messages[index];
    if (message?.role === 'tool') {
      olderToolMessages.push({ message, index });
    }
  }

  if (olderToolMessages.length === 0) {
    return messages.slice();
  }

  // Boost keys derived from the most recent assistant tool request.
  const boostKeys = getLatestAssistantReferenceBoost()
    ? collectLatestAssistantReferenceKeys(messages)
    : new Set<string>();

  // Walk newest → oldest. Tier B budget is shared across all older messages.
  const tierAssignments = new Map<number, 'B' | 'C'>();
  const budgetChars = getPromptToolResultBudgetChars();
  const previewChars = getPerToolPreviewChars();
  let remainingBudget = budgetChars;

  for (let cursor = olderToolMessages.length - 1; cursor >= 0; cursor -= 1) {
    const entry = olderToolMessages[cursor];
    if (!entry) {
      continue;
    }

    const parsed = parseSerializedToolContent(entry.message.content);
    const entryPreviewChars = parsed
      ? estimateTierBPreviewChars(parsed)
      : entry.message.content.length;

    const boosted = parsed !== null && matchesBoostKeys(parsed, entry.message, boostKeys);
    if (boosted && remainingBudget < previewChars) {
      // Guarantee boosted messages at least one Tier B slot by reclaiming
      // budget from the oldest non-boosted Tier B assignments if needed.
      reclaimBudgetForBoost(tierAssignments, olderToolMessages, remainingBudget, entryPreviewChars);
      remainingBudget = Math.max(remainingBudget, previewChars);
    }

    if (remainingBudget >= entryPreviewChars) {
      tierAssignments.set(entry.index, 'B');
      remainingBudget -= entryPreviewChars;
    } else {
      tierAssignments.set(entry.index, 'C');
    }
  }

  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= firstTrailingToolIndex) {
      return message;
    }

    const tier = tierAssignments.get(index);
    const parsed = parseSerializedToolContent(message.content);
    if (!parsed) {
      return message;
    }

    if (tier === 'B') {
      return { ...message, content: compactToTierB(parsed) };
    }

    return { ...message, content: compactToTierC(parsed, message.toolName) };
  });
}

function reclaimBudgetForBoost(
  assignments: Map<number, 'B' | 'C'>,
  olderToolMessages: readonly ToolMessageWithIndex[],
  remainingBudget: number,
  _requiredChars: number,
): void {
  const previewChars = getPerToolPreviewChars();
  const shortfall = previewChars - remainingBudget;
  if (shortfall <= 0) {
    return;
  }

  let reclaimed = 0;
  for (let cursor = 0; cursor < olderToolMessages.length && reclaimed < shortfall; cursor += 1) {
    const entry = olderToolMessages[cursor];
    if (!entry) {
      continue;
    }
    const current = assignments.get(entry.index);
    if (current !== 'B') {
      continue;
    }
    const parsed = parseSerializedToolContent(entry.message.content);
    const freed = parsed ? estimateTierBPreviewChars(parsed) : entry.message.content.length;
    assignments.set(entry.index, 'C');
    reclaimed += freed;
  }
}

/**
 * Keys extracted from the most recent assistant tool request. Historical tool
 * messages referencing the same path/pattern/command are boosted into Tier B
 * so the model can re-use them instead of re-reading the same file.
 */
function collectLatestAssistantReferenceKeys(messages: readonly ProviderMessage[]): Set<string> {
  const keys = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    const toolCalls = collectAssistantToolCalls(message);
    for (const toolCall of toolCalls) {
      for (const key of extractReferenceKeys(toolCall)) {
        keys.add(key);
      }
    }
    break;
  }
  return keys;
}

function collectAssistantToolCalls(message: ProviderMessage): ProviderToolCall[] {
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return [...message.toolCalls];
  }
  if (message.toolName && message.toolArgs) {
    return [{ toolCallId: message.toolCallId ?? 'inline', toolName: message.toolName, args: message.toolArgs } as ProviderToolCall];
  }
  return [];
}

function extractReferenceKeys(toolCall: ProviderToolCall): string[] {
  switch (toolCall.toolName) {
    case 'read':
    case 'edit':
    case 'write':
    case 'undo_edit':
      return [normalizeReferenceToken(toolCall.args.path)];
    case 'grep':
    case 'glob':
      return [normalizeReferenceToken(toolCall.args.pattern)];
    case 'exec':
    case 'shell_exec':
      return [normalizeReferenceToken(splitExecCommand(toolCall.args.command)[0] ?? '')];
    default:
      return [];
  }
}

function normalizeReferenceToken(value: string): string {
  return value.trim().replace(/\\/g, '/').toLowerCase();
}

function matchesBoostKeys(
  parsed: { status: string; summary: string; output: string[] },
  message: ProviderMessage,
  boostKeys: Set<string>,
): boolean {
  if (boostKeys.size === 0) {
    return false;
  }

  for (const key of boostKeys) {
    if (key && (parsed.summary.toLowerCase().includes(key) || parsed.output.some((line) => line.toLowerCase().includes(key)))) {
      return true;
    }
  }

  return false;
}

/**
 * Estimate the character cost of a Tier B preview for a parsed tool result.
 * The actual Tier B output is `head + tail + omitted marker`, so this uses
 * the same head/tail slice lengths.
 */
function estimateTierBPreviewChars(parsed: { status: string; summary: string; output: string[] }): number {
  const slices = sliceOutputForPreview(parsed.output, getPerToolPreviewChars());
  const body = slices.join('\n');
  const summary = truncateToolSummaryForModel(parsed.summary);
  // JSON envelope overhead is small and stable; approximate with a constant.
  return body.length + summary.length + 80;
}

function sliceOutputForPreview(output: readonly string[], budgetChars: number): string[] {
  if (output.length === 0) {
    return [];
  }

  let headChars = 0;
  let headCount = 0;
  for (let index = 0; index < output.length; index += 1) {
    const line = output[index] ?? '';
    if (headChars + line.length > budgetChars / 2 && headCount > 0) {
      break;
    }
    headChars += line.length;
    headCount += 1;
  }

  if (headCount >= output.length) {
    return output.slice(0, headCount);
  }

  const tailBudget = budgetChars - headChars;
  let tailChars = 0;
  let tailCount = 0;
  for (let index = output.length - 1; index >= headCount; index -= 1) {
    const line = output[index] ?? '';
    if (tailChars + line.length > tailBudget && tailCount > 0) {
      break;
    }
    tailChars += line.length;
    tailCount += 1;
  }

  const head = output.slice(0, headCount);
  const tail = output.slice(output.length - tailCount);
  const omitted = output.length - headCount - tailCount;
  if (omitted > 0) {
    return [...head, `... [omitted ${omitted} line(s)] ...`, ...tail];
  }
  return [...head, ...tail];
}

/**
 * Tier B compaction: keeps a bounded preview (head + tail) of the output so
 * the model can still reference previously read content without re-reading.
 */
export function compactToTierB(parsed: { status: string; summary: string; output: string[] }): string {
  const preview = sliceOutputForPreview(parsed.output, getPerToolPreviewChars());
  return JSON.stringify({
    status: parsed.status,
    summary: truncateToolSummaryForModel(parsed.summary),
    outputPreview: preview.join('\n'),
    outputCount: parsed.output.length,
    outputTruncated: preview.length < parsed.output.length,
    compression: 'tier-b',
  });
}

/**
 * Tier C compaction: structured minimal summary so the model knows a previous
 * tool call happened and can re-invoke it with narrower arguments if needed.
 */
export function compactToTierC(parsed: { status: string; summary: string; output: string[] }, toolName: string | undefined): string {
  const hint = getTierCHintEnabled() ? buildTierCHint(toolName) : undefined;
  const payload: Record<string, unknown> = {
    status: parsed.status,
    summary: truncateToolSummaryForModel(parsed.summary),
    outputCount: parsed.output.length,
    compacted: 'tier-c',
  };
  if (hint) {
    payload.hint = hint;
  }
  return JSON.stringify(payload);
}

function buildTierCHint(toolName: string | undefined): string | undefined {
  switch (toolName) {
    case 'read':
      return '再次调用 read 并附带 startLine/endLine 可拿到原文';
    case 'grep':
      return '再次调用 grep 并附带更窄的 include 可拿到完整命中';
    case 'glob':
      return '再次调用 glob 可拿到完整路径列表';
    case 'exec':
    case 'shell_exec':
      return '再次调用 exec/shell_exec 可拿到完整命令输出';
    default:
      return undefined;
  }
}

/**
 * Legacy compaction used when `PUEBLO_COMPACT_MODE=legacy`. Preserves the
 * previous one-line `执行结果已压缩：<summary>` behaviour for rollbacks.
 */
function compactToLegacy(message: ProviderMessage): string {
  const parsed = parseSerializedToolContent(message.content);
  if (!parsed) {
    return message.content;
  }
  return '执行结果已压缩：' + truncateToolSummaryForModel(parsed.summary);
}

export function serializeToolResultForModel(output: ToolExecutionResult): string {
  return JSON.stringify({
    status: output.status,
    summary: truncateToolSummaryForModel(output.summary),
    output: truncateOutputForSerialization(output.output, getPerToolRawChars()),
  });
}

/**
 * Cap the serialized `output` array so a single long `shell_exec` result
 * cannot consume the entire Tier A budget. Keeps the JSON array shape intact
 * by emitting head items + an omitted marker + tail items.
 */
export function truncateOutputForSerialization(output: readonly string[], maxChars: number): string[] {
  if (output.length === 0) {
    return [];
  }

  let totalChars = 0;
  for (const line of output) {
    totalChars += line.length;
  }

  if (totalChars <= maxChars) {
    return [...output];
  }

  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;

  const head: string[] = [];
  let headChars = 0;
  for (let index = 0; index < output.length; index += 1) {
    const line = output[index] ?? '';
    if (headChars + line.length > headBudget && head.length > 0) {
      break;
    }
    head.push(line);
    headChars += line.length;
  }

  const tail: string[] = [];
  let tailChars = 0;
  for (let index = output.length - 1; index >= head.length; index -= 1) {
    const line = output[index] ?? '';
    if (tailChars + line.length > tailBudget && tail.length > 0) {
      break;
    }
    tail.unshift(line);
    tailChars += line.length;
  }

  const omitted = output.length - head.length - tail.length;
  if (omitted > 0) {
    return [...head, `... [omitted ${omitted} item(s), ${totalChars - headChars - tailChars} chars] ...`, ...tail];
  }
  return [...head, ...tail];
}

function formatProgressToolCall(toolCall: ProviderToolCall): string {
  switch (toolCall.toolName) {
    case 'read':
    case 'edit':
    case 'write': {
      const path = 'path' in toolCall.args ? String(toolCall.args.path) : toolCall.toolName;
      return `${toolCall.toolName} ${truncateProgressMessage(path)}`;
    }
    case 'grep': {
      const pattern = 'pattern' in toolCall.args ? String(toolCall.args.pattern) : toolCall.toolName;
      return `${toolCall.toolName} ${truncateProgressMessage(pattern)}`;
    }
    case 'glob': {
      const pattern = 'pattern' in toolCall.args ? String(toolCall.args.pattern) : toolCall.toolName;
      return `${toolCall.toolName} ${truncateProgressMessage(pattern)}`;
    }
    case 'exec': {
      const command = 'command' in toolCall.args ? String(toolCall.args.command) : toolCall.toolName;
      return `${toolCall.toolName} ${truncateProgressMessage(command)}`;
    }
    case 'shell_exec': {
      const mode = 'mode' in toolCall.args ? String(toolCall.args.mode) : 'shell';
      const command = 'command' in toolCall.args ? String(toolCall.args.command) : toolCall.toolName;
      return `${toolCall.toolName} ${truncateProgressMessage(`${mode}: ${command}`)}`;
    }
    case 'undo_edit': {
      const path = 'path' in toolCall.args ? String(toolCall.args.path) : 'undo edit';
      return `${toolCall.toolName} ${truncateProgressMessage(path)}`;
    }
    case 'memo_recall': {
      const keyword = 'keyword' in toolCall.args ? String(toolCall.args.keyword) : 'memo recall';
      return `${toolCall.toolName} ${truncateProgressMessage(keyword)}`;
    }
    default:
      // MCP tool calls (mcp__<server>__<tool>)
      return `${(toolCall as any).toolName} ${truncateProgressMessage(JSON.stringify((toolCall as any).args))}`;
  }
}

function truncateProgressMessage(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function aggregateFileChanges(
  toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'],
) {
  const mergedChanges = new Map<string, NonNullable<(typeof toolOutputs)[number]['fileChanges']>[number]>();

  for (const output of toolOutputs) {
    for (const fileChange of output.fileChanges ?? []) {
      const existing = mergedChanges.get(fileChange.absolutePath);
      if (!existing) {
        mergedChanges.set(fileChange.absolutePath, fileChange);
        continue;
      }

      mergedChanges.set(fileChange.absolutePath, {
        ...fileChange,
        changeType: existing.changeType === 'created' ? 'created' : fileChange.changeType,
        previousContent: existing.previousContent,
      });
    }
  }

  return [...mergedChanges.values()];
}

export function parseSerializedToolContent(content: string): { status: string; summary: string; output: string[] } | null {
  try {
    const parsed = JSON.parse(content) as {
      status?: unknown;
      summary?: unknown;
      output?: unknown;
    };

    if (typeof parsed.status !== 'string' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.output)) {
      return null;
    }

    const output = parsed.output.filter((entry): entry is string => typeof entry === 'string');
    return {
      status: parsed.status,
      summary: parsed.summary,
      output,
    };
  } catch {
    return null;
  }
}



function truncateToolSummaryForModel(summary: string): string {
  const charLimit = getToolResultSummaryCharLimit();
  if (summary.length <= charLimit) {
    return summary;
  }

  return `${summary.slice(0, charLimit - 3)}...`;
}

function resolveAgentTaskStepLimit(maxSteps?: number): number {
  if (typeof maxSteps !== 'number' || !Number.isFinite(maxSteps)) {
    return getDefaultMaxAgentSteps();
  }

  return Math.max(1, Math.floor(maxSteps));
}
