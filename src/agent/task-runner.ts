import { AgentTaskRepository } from './task-repository';
import type { AgentTask } from '../shared/schema';
import { buildCamelSystemMessages } from './camel/camel-prompt-builder';
import { buildLegacyProviderMessages, buildProviderMessages } from './task-message-builder';
import {
  getToolExecutionPolicy,
  type ProviderToolArgs,
  ProviderMessage,
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
import type { InputAttachmentManifest, PromptAsset } from '../shared/schema';
import { withSourceAttribution } from '../shared/result';
import { ToolService } from '../tools/tool-service';
import {
  ExecuteTurnInput as CamelExecuteTurnInput,
  ExecuteTurnOutput as CamelExecuteTurnOutput,
} from './camel/camel-types';
import { amberLog } from '../utils/perf-logger';
import type { ToolExecutionResult } from '../tools/glob-tool';
import type { TaskContext } from './task-context';
import fs from 'node:fs';
import path from 'node:path';
import { throwIfTaskCancelled } from '../shared/task-cancellation';

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

const TOOL_RESULT_SUMMARY_CHAR_LIMIT = 640;
const DEFAULT_MAX_AGENT_STEPS = 48;
const DEFAULT_TOOL_PREVIEW_ITEM_LIMIT = 12;
const READ_TOOL_PREVIEW_ITEM_LIMIT = 24;
const REPEATED_TOOL_LOOP_LIMIT = 6;
const STEP_BUDGET_FINALIZATION_BUFFER = 6;
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

interface AgentStepTraceEntry {
  readonly stepNumber: number;
  readonly type: 'tool-call' | 'tool-result' | 'final';
  readonly summary: string;
  readonly toolName?: ProviderToolName;
  readonly toolCallId?: string;
}

interface ModelMessageTraceEntry {
  readonly stepNumber: number;
  readonly messages: ProviderMessage[];
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

    try {
      this.emitProgress(`Started task: ${truncateProgressMessage(input.goal)}`);
      response = await this.runAgentLoop({
        adapter,
        modelId: input.modelId,
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
        console.log(`[task-runner] Context trace dumped: ${dumpPath}`);
      } catch (dumpErr) {
        console.warn('[task-runner] Failed to dump context trace:', dumpErr);
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
        error,
      );
      throw error;
    }
  }

  public async executeTurn(input: CamelExecuteTurnInput): Promise<CamelExecuteTurnOutput> {
    const { context, providerId, modelId, signal } = input;

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

    // Step 1: Initial run
    let result = await adapter.runStep({
      modelId,
      messages: turnMessages,
      availableTools,
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
      for (const tc of toolCalls) {
        const { output } = await this.executeToolCall(
          /* taskId */ '',
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
      }

      // Feed tool results back for final response
      const updatedMessages: ProviderMessage[] = [
        ...turnMessages,
        {
          role: 'assistant',
          content: '',
          toolCalls,
        },
        ...toolResults,
      ];

      result = await adapter.runStep({
        modelId,
        messages: updatedMessages,
        availableTools,
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
    readonly signal?: AbortSignal;
  }): Promise<ProviderRunResult> {
    const messages = [...args.executionMessages];
    let previousToolLoopFingerprint: string | null = null;
    let repeatedToolLoopCount = 0;

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
            messages: [{
              role: 'system',
              content: _summary,
              toolCallId: undefined,
              toolName: undefined,
              toolArgs: undefined,
            }],
          });
          return { outputSummary: _summary };
        }
      }
    }

    // Log turn-start context (step 0) for diagnostic analysis
    args.modelMessageTrace.push({
      stepNumber: 0,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        toolArgs: message.toolArgs,
      })),
    });

    for (let stepIndex = 0; stepIndex < this.maxSteps; stepIndex += 1) {
      throwIfTaskCancelled(args.signal, 'Task cancelled during agent execution.');
      const stepMessages = prepareMessagesForModel(messages);
      args.modelMessageTrace.push({
        stepNumber: stepIndex + 1,
        messages: stepMessages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
        })),
      });

      let result: ProviderStepResult;
      try {
        result = await args.adapter.runStep({
          modelId: args.modelId,
          messages: stepMessages,
          availableTools: args.availableTools,
          signal: args.signal,
          onTextDelta: this.reportAssistantDelta
            ? (text) => {
              this.reportAssistantDelta?.(text);
            }
            : undefined,
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
        this.emitProgress(`Step ${stepIndex + 1}: final response ready`);
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'final',
          summary: result.outputSummary,
        });
        return {
          outputSummary: result.outputSummary,
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
      }

      const currentToolLoopFingerprint = createToolLoopFingerprint(requestedToolCalls, toolExecutions);
      if (currentToolLoopFingerprint === previousToolLoopFingerprint) {
        repeatedToolLoopCount += 1;
      } else {
        previousToolLoopFingerprint = currentToolLoopFingerprint;
        repeatedToolLoopCount = 1;
      }

      if (repeatedToolLoopCount >= REPEATED_TOOL_LOOP_LIMIT) {
        throwIfTaskCancelled(args.signal, 'Task cancelled during repeated tool loop handling.');
        const clarificationResult = await this.createClarificationFallbackResult({
          adapter: args.adapter,
          modelId: args.modelId,
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

  private async createStepBudgetHandoffResult(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
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
      messages: stepMessages.map((message) => ({
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        toolArgs: message.toolArgs,
      })),
    });

    try {
      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages: stepMessages,
        availableTools: [],
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
      messages: stepMessages.map((message) => ({
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        toolArgs: message.toolArgs,
      })),
    });

    try {
      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages: stepMessages,
        availableTools: [],
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
        console.log(`tool call ${toolCall.toolName} with command "${command}".is approvalling: ${isShellExec && this.isMustApproval(command)}`);
        if (isShellExec && this.isMustApproval(command)) {
          mustApprovalRequests.push(pr); // Still needs user approval
          console.log(`tool call ${toolCall.toolName} with command "${command}".must approval`);
        } else {
          approvals.set(pr.request.toolCallId, 'allow-once'); // Auto-approve
          console.log(`tool call ${toolCall.toolName} with command "${command}".auto-approved`);
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
        });
      case 'shell_exec':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'shell_exec',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
          signal: args.signal,
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
    error: unknown,
  ): void {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);
    const failureOutput = withSourceAttribution(
      {
        outputSummary: `Task failed: ${this.getErrorMessage(error)}`,
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
        modelOutput: response?.outputSummary,
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

function createToolLoopFingerprint(
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
  const finalizationThreshold = Math.max(1, maxSteps - STEP_BUDGET_FINALIZATION_BUFFER);
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
/*
function prepareMessagesForModel(messages: ProviderMessage[]): ProviderMessage[] {
  let firstTrailingToolIndex = messages.length;
  while (firstTrailingToolIndex > 0 && messages[firstTrailingToolIndex - 1]?.role === 'tool') {
    firstTrailingToolIndex -= 1;
  }

  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= firstTrailingToolIndex) {
      return message;
    }

    return {
      ...message,
      content: compactSerializedToolMessage(message),
    };
  });
}
*/
function prepareMessagesForModel(messages: ProviderMessage[]): ProviderMessage[] {
  let firstTrailingToolIndex = messages.length;
  while (firstTrailingToolIndex > 0 && messages[firstTrailingToolIndex - 1]?.role === 'tool') {
    firstTrailingToolIndex -= 1;
  }

  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= firstTrailingToolIndex) {
      return message;
    }

    return {
      ...message,
      content: compactSerializedToolMessage(message),
    };
  });
}

function serializeToolResultForModel(output: ToolExecutionResult): string {
  return JSON.stringify({
    status: output.status,
    summary: truncateToolSummaryForModel(output.summary),
    output: output.output,
  });
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

function compactSerializedToolMessage(message: ProviderMessage): string {
  const parsed = parseSerializedToolContent(message.content);
  if (!parsed) {
    return message.content;
  }

  const previewLimit = message.toolName === 'read' ? READ_TOOL_PREVIEW_ITEM_LIMIT : DEFAULT_TOOL_PREVIEW_ITEM_LIMIT;
  const preview = parsed.output.slice(0, previewLimit);

  return '执行结果已压缩：'+truncateToolSummaryForModel(parsed.summary);
  /*JSON.stringify({
    status: parsed.status,
    summary: truncateToolSummaryForModel(parsed.summary),
    outputPreview: '执行结果已压缩：' + preview.join('\n'),
   // outputCount: parsed.output.length,
    //outputTruncated: preview.length < parsed.output.length,
   // compression: 'older-tool-result-compacted',
   // guidance: 'Older tool result was compacted to reduce prompt size. Re-run the tool with narrower arguments if exact full output is needed again.',
  });
   */
}

function parseSerializedToolContent(content: string): { status: string; summary: string; output: string[] } | null {
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
  if (summary.length <= TOOL_RESULT_SUMMARY_CHAR_LIMIT) {
    return summary;
  }

  return `${summary.slice(0, TOOL_RESULT_SUMMARY_CHAR_LIMIT - 3)}...`;
}

function resolveAgentTaskStepLimit(maxSteps?: number): number {
  if (typeof maxSteps !== 'number' || !Number.isFinite(maxSteps)) {
    return DEFAULT_MAX_AGENT_STEPS;
  }

  return Math.max(1, Math.floor(maxSteps));
}
