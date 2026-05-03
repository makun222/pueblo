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
}

export interface ToolApprovalRequest {
  readonly taskId: string;
  readonly toolName: ProviderToolName;
  readonly args: ProviderToolArgs;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

const DEFAULT_MAX_AGENT_STEPS = 24;
const DEFAULT_TOOL_PREVIEW_ITEM_LIMIT = 12;
const READ_TOOL_PREVIEW_ITEM_LIMIT = 24;

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

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly repository: AgentTaskRepository,
    private readonly toolService?: ToolService,
    options: AgentTaskRunnerOptions = {},
  ) {
    this.maxSteps = resolveAgentTaskStepLimit(options.maxSteps);
    this.requestToolApproval = options.requestToolApproval;
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

    try {
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
      });
      const enrichedOutput = this.createCompletedOutputSummary(
        input,
        response,
        toolOutputs,
        toolInvocationIds,
        stepTrace,
        modelMessageTrace,
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
  }): Promise<ProviderRunResult> {
    const messages = [...args.executionMessages];

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
      });

      if (result.type === 'final') {
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'final',
          summary: result.outputSummary,
        });
        return { outputSummary: result.outputSummary };
      }

      const requestedToolCalls = result.type === 'tool-calls'
        ? result.toolCalls
        : [this.toProviderToolCall(result)];

      for (const toolCall of requestedToolCalls) {
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'tool-call',
          summary: result.rationale ?? `Model requested tool ${toolCall.toolName}`,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
      }

      const toolExecutions = [] as Array<Awaited<ReturnType<typeof this.executeToolCall>>>;
      for (const toolCall of requestedToolCalls) {
        const toolExecution = await this.executeToolCall(args.taskId, toolCall, args.executionCwd);
        args.toolInvocationIds.push(toolExecution.invocation.id);
        args.toolOutputs.push(toolExecution.output);
        args.stepTrace.push({
          stepNumber: stepIndex + 1,
          type: 'tool-result',
          summary: toolExecution.output.summary,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
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
    }

    throw new Error(`Agent task exceeded ${this.maxSteps} steps without producing a final response`);
  }

  private executeToolCall(taskId: string, result: ProviderToolCall, executionCwd?: string) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${result.toolName}`);
    }

    const inputSummary = JSON.stringify({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: result.args,
    });

    return this.executeToolCallWithApproval({ taskId, result, inputSummary, executionCwd });
  }

  private async executeToolCallWithApproval(args: {
    readonly taskId: string;
    readonly result: ProviderToolCall;
    readonly inputSummary: string;
    readonly executionCwd?: string;
  }) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${args.result.toolName}`);
    }

    if (getToolExecutionPolicy(args.result.toolName) === 'approval-required') {
      const approvalDescription = this.toolService.describeApproval(args.result);
      const approved = await this.requestToolApproval?.({
        taskId: args.taskId,
        toolName: args.result.toolName,
        args: args.result.args,
        title: approvalDescription.title,
        summary: approvalDescription.summary,
        detail: approvalDescription.detail,
      }) ?? false;

      if (!approved) {
        const output: ToolExecutionResult = {
          toolName: args.result.toolName,
          status: 'failed',
          summary: `Execution denied: user approval is required before running ${args.result.toolName}`,
          output: [
            `tool: ${args.result.toolName}`,
            'approvalRequired: true',
            'approved: false',
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
    if (input.taskContext) {
      return buildProviderMessages(input.taskContext, input.goal);
    }

    return buildLegacyProviderMessages(input.goal, input.inputContextSummary);
  }

  private getPrompts(input: RunAgentTaskInput): PromptAsset[] {
    return input.taskContext?.prompts ?? input.prompts ?? [];
  }

  private getMemoryIds(input: RunAgentTaskInput): string[] {
    return input.taskContext?.resultItems.map((item) => item.memoryId) ?? input.memoryIds ?? [];
  }

  private createCompletedOutputSummary(
    input: RunAgentTaskInput,
    response: ProviderRunResult,
    toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'],
    toolInvocationIds: string[],
    stepTrace: AgentStepTraceEntry[],
    modelMessageTrace: ModelMessageTraceEntry[],
  ) {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);

    return withSourceAttribution(
      {
        outputSummary: response.outputSummary,
        targetDirectory,
        toolExecutionCwd,
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
    error: unknown,
  ): void {
    const targetDirectory = input.taskContext?.targetDirectory ?? null;
    const toolExecutionCwd = this.resolveTaskExecutionCwd(input);
    const failureOutput = withSourceAttribution(
      {
        outputSummary: `Task failed: ${this.getErrorMessage(error)}`,
        targetDirectory,
        toolExecutionCwd,
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
