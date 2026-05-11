import { AgentTaskRepository } from './task-repository';
import type { AgentTask } from '../shared/schema';
import { buildLegacyProviderMessages, buildProviderMessages } from './task-message-builder';
import {
  getToolExecutionPolicy,
  type ProviderToolArgs,
  ProviderMessage,
  ProviderRunResult,
  ProviderStepResult,
  ProviderToolName,
  ProviderToolCall,
  type ProviderUsage,
} from '../providers/provider-adapter';
import { ProviderRegistry } from '../providers/provider-registry';
import type { PromptAsset } from '../shared/schema';
import { withSourceAttribution } from '../shared/result';
import { ToolService } from '../tools/tool-service';
import type { ToolExecutionResult } from '../tools/glob-tool';
import type { TaskContext } from './task-context';

export interface RunAgentTaskInput {
  readonly goal: string;
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputContextSummary: string;
  readonly taskContext?: TaskContext;
  readonly prompts?: PromptAsset[];
  readonly memoryIds?: string[];
}

export interface AgentTaskRunnerOptions {
  readonly maxSteps?: number;
  readonly requestToolApproval?: ToolApprovalHandler;
  readonly requestToolApprovalBatch?: ToolApprovalBatchHandler;
  readonly reportProgress?: (message: string) => void;
  readonly reportAssistantDelta?: (text: string) => void;
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

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

export type ToolApprovalBatchHandler = (requests: readonly ToolApprovalRequest[]) => Promise<readonly ToolApprovalDecision[]>;

const DEFAULT_MAX_AGENT_STEPS = 48;
const DEFAULT_TOOL_PREVIEW_ITEM_LIMIT = 12;
const READ_TOOL_PREVIEW_ITEM_LIMIT = 24;
const REPEATED_TOOL_LOOP_LIMIT = 6;
const STEP_BUDGET_FINALIZATION_BUFFER = 6;
const CLARIFICATION_FALLBACK_PROMPT = [
  'You have spent many reasoning steps on this task without reaching a reliable final answer.',
  'Do not call any more tools.',
  'Write a short clarification request to the user in the same language as the latest user message.',
  'First acknowledge that the current goal is still too broad or ambiguous to finish reliably.',
  'Then provide 1 to 3 concrete options that help the user restate the task with a narrower, executable scope.',
  'Each option must be specific and action-oriented, such as narrowing to a file, module, bug, expected output, or validation target.',
  'Keep the response concise and directly usable.',
].join(' ');
const STEP_BUDGET_HANDOFF_PROMPT = [
  'You have reached the task step budget for this round.',
  'Do not call any more tools.',
  'Write a concise progress handoff in the same language as the latest user message.',
  'Use exactly these three section headings: Completed this round, Remaining work, Recommended next request.',
  'Under Completed this round, summarize only the work already completed or verified in this round.',
  'Under Remaining work, list the most important unfinished tasks that should be continued in later turns.',
  'Under Recommended next request, suggest one concrete next-turn request the user can send to continue without repeating finished work.',
  'Be honest about what is incomplete and keep the response concise and actionable.',
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
  private readonly approvalCache = new Set<string>();

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
  }

  async run(input: RunAgentTaskInput): Promise<AgentTask> {
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
      });
      const enrichedOutput = this.createCompletedOutputSummary(
        input,
        response,
        toolOutputs,
        toolInvocationIds,
        stepTrace,
        modelMessageTrace,
        providerUsageRef.current,
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
        error,
      );
      throw error;
    }
  }

  private buildInputSummary(input: RunAgentTaskInput): string {
    return JSON.stringify({
      inputContextSummary: input.inputContextSummary,
      promptIds: this.getPrompts(input).map((prompt) => prompt.id),
      memoryIds: this.getMemoryIds(input),
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
  }): Promise<ProviderRunResult> {
    const messages = [...args.executionMessages];
    let previousToolLoopFingerprint: string | null = null;
    let repeatedToolLoopCount = 0;

    for (let stepIndex = 0; stepIndex < this.maxSteps; stepIndex += 1) {
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

      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages: stepMessages,
        availableTools: args.availableTools,
        onTextDelta: (text) => {
          this.reportAssistantDelta?.(text);
        },
      });

      args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, result.usage);

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
        const toolExecution = await this.executeToolCall(
          args.taskId,
          toolCall,
          args.executionCwd,
          approvalDecisions.get(toolCall.toolCallId) ?? null,
        );
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
      }AgentTaskRunner

      if (repeatedToolLoopCount >= REPEATED_TOOL_LOOP_LIMIT) {
        const clarificationResult = await this.createClarificationFallbackResult({
          adapter: args.adapter,
          modelId: args.modelId,
          messages,
          modelMessageTrace: args.modelMessageTrace,
          stepTrace: args.stepTrace,
          stepNumber: stepIndex + 2,
          reason: `Agent task entered a repeated ${requestedToolCalls[0]?.toolName ?? 'tool'} loop for ${repeatedToolLoopCount} consecutive steps without making progress`,
        });
        args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, clarificationResult.usage);
        return {
          outputSummary: clarificationResult.outputSummary,
          usage: args.providerUsageRef.current,
        };
      }
    }

    const handoffResult = await this.createStepBudgetHandoffResult({
      adapter: args.adapter,
      modelId: args.modelId,
      messages,
      modelMessageTrace: args.modelMessageTrace,
      stepTrace: args.stepTrace,
      stepNumber: this.maxSteps + 1,
      reason: `Agent task exceeded ${this.maxSteps} steps without producing a final response`,
    });
    args.providerUsageRef.current = mergeProviderUsage(args.providerUsageRef.current, handoffResult.usage);
    return {
      outputSummary: handoffResult.outputSummary,
      usage: args.providerUsageRef.current,
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
  }): Promise<ProviderRunResult> {
    this.emitProgress(`Preparing clarification fallback: ${truncateProgressMessage(args.reason)}`);
    const clarificationMessages = [
      ...args.messages,
      {
        role: 'user' as const,
        content: `${CLARIFICATION_FALLBACK_PROMPT}\nReason: ${args.reason}`,
      },
    ];

    const stepMessages = prepareMessagesForModel(clarificationMessages);
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

  private executeToolCall(
    taskId: string,
    result: ProviderToolCall,
    executionCwd?: string,
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
    readonly approvalDecision?: ToolApprovalDecision | null;
  }) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${args.result.toolName}`);
    }

    const approvalCacheKey = createApprovalCacheKey(args.result);
    if (
      getToolExecutionPolicy(args.result.toolName) === 'approval-required'
      && requiresInteractiveApproval(args.result)
      && (!approvalCacheKey || !this.approvalCache.has(approvalCacheKey))
    ) {
      const approvalDecision = args.approvalDecision
        ?? await this.requestToolApproval?.(this.buildToolApprovalRequest(args.taskId, args.result))
        ?? 'deny';

      if (approvalDecision === 'allow-all' && approvalCacheKey) {
        this.approvalCache.add(approvalCacheKey);
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

    switch (args.result.toolName) {
      case 'glob':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'glob',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
        });
      case 'grep':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'grep',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
        });
      case 'exec':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'exec',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
        });
      case 'read':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'read',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
        });
      case 'edit':
        return this.toolService.execute({
          taskId: args.taskId,
          toolName: 'edit',
          args: args.result.args,
          inputSummary: args.inputSummary,
          executionCwd: args.executionCwd,
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
  ) {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);

    return withSourceAttribution(
      {
        outputSummary: response.outputSummary,
        providerUsage,
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
    error: unknown,
  ): void {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);
    const failureOutput = withSourceAttribution(
      {
        outputSummary: `Task failed: ${this.getErrorMessage(error)}`,
        providerUsage,
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
    toolResults: toolExecutions.map((execution) => ({
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
 /*    'Execution budget policy:',
    `- This round has a hard limit of ${maxSteps} model steps.`,
    '- Before using tools heavily, estimate whether the full user request can fit inside this step budget.',
    '- At the start of the task, decide whether this work should be completed in one turn or split across multiple turns.',
    `- If the work is too large, choose only the highest-value first batch of 1 to 3 sub-tasks that can be completed reliably within about ${finalizationThreshold} steps, then stop and hand off the rest.`,
    '- Prefer concrete progress on a smaller slice over partial coverage of the whole task.',
    '- When you determine that multiple turns are needed, you may end the current turn early after finishing the first batch instead of using the remaining budget.',
    '- Whenever you hand work off to a later turn, use exactly these section headings in the final answer: Completed this round, Remaining work, Recommended next request.',
    '- Before the budget is exhausted, produce a final answer that clearly states what was completed in this round, what remains, and what the next request should focus on.',
    '- Do not spend the whole budget exploring if that would prevent a useful checkpoint.' */
    '执行预算政策：',
    `- 本轮有 ${maxSteps} 步的硬性模型调用限制。`,
    '- 在任务开始前，先评估请求是否能在这个步数预算内完成。',
    '- 当你判断需要多轮时，可以在完成第一批子任务后提前结束当前轮，而不是用完剩余预算。',
    `- 如果需要更多步数才能完成整个请求，就对工作进行切分，选择最重要的前 1 到 3 个子任务，这些子任务应该能在大约 ${finalizationThreshold} 步内可靠完成，然后停止并把剩余的工作留到后续轮次继续。`,
    '- 宁可在较小的切片上取得具体进展，也不要在整个任务上取得部分覆盖。',    
    '- 每当你把工作交给后续轮次时，在最终答案中使用完全相同的这些部分标题：（本轮已完成、剩余工作、推荐下一步请求）。',
    '- 在预算耗尽前，给出一个最终答案，清楚地说明本轮完成了什么，剩下什么，以及下一步请求应该关注什么。',
    '- 如果探索会导致无法得到有用的检查点，就不要花费整个预算去探索。',
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
  if (toolCall.toolName !== 'exec') {
    return true;
  }

  return classifyExecCommandRisk(toolCall.args.command) !== 'read-only';
}

function createApprovalCacheKey(toolCall: ProviderToolCall): string | null {
  switch (toolCall.toolName) {
    case 'edit':
      return `edit:${normalizeApprovalCacheToken(toolCall.args.path)}`;
    case 'exec':
      return `exec:${normalizeApprovalCacheToken(toolCall.args.command)}`;
    case 'glob':
    case 'grep':
    case 'read':
      return null;
  }
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
    summary: output.summary,
    output: output.output,
  });
}

function formatProgressToolCall(toolCall: ProviderToolCall): string {
  switch (toolCall.toolName) {
    case 'read':
    case 'edit': {
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

  return JSON.stringify({
    status: parsed.status,
    summary: parsed.summary,
    outputPreview: preview,
    outputCount: parsed.output.length,
    outputTruncated: preview.length < parsed.output.length,
    compression: 'older-tool-result-compacted',
    guidance: 'Older tool result was compacted to reduce prompt size. Re-run the tool with narrower arguments if exact full output is needed again.',
  });
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

function resolveAgentTaskStepLimit(maxSteps?: number): number {
  if (typeof maxSteps !== 'number' || !Number.isFinite(maxSteps)) {
    return DEFAULT_MAX_AGENT_STEPS;
  }

  return Math.max(1, Math.floor(maxSteps));
}
