import { AgentTaskRepository } from './task-repository';
import type { AgentTask } from '../shared/schema';
import { buildLegacyProviderMessages, buildProviderMessages } from './task-message-builder';
import type {
  ProviderMessage,
  ProviderRunResult,
  ProviderStepResult,
  ProviderToolName,
} from '../providers/provider-adapter';
import { ProviderRegistry } from '../providers/provider-registry';
import type { PromptAsset, MemoryRecord } from '../shared/schema';
import { withSourceAttribution } from '../shared/result';
import { ToolService } from '../tools/tool-service';
import type { TaskContext } from './task-context';

export interface RunAgentTaskInput {
  readonly goal: string;
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputContextSummary: string;
  readonly taskContext?: TaskContext;
  readonly prompts?: PromptAsset[];
  readonly memories?: MemoryRecord[];
}

const MAX_AGENT_STEPS = 8;

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
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly repository: AgentTaskRepository,
    private readonly toolService?: ToolService,
  ) {}

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
      memoryIds: this.getMemories(input).map((memory) => memory.id),
    });
  }

  private async runAgentLoop(args: {
    readonly adapter: ReturnType<ProviderRegistry['getAdapter']>;
    readonly modelId: string;
    readonly taskId: string;
    readonly availableTools: ReturnType<ToolService['describeTools']>;
    readonly executionMessages: ProviderMessage[];
    readonly toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'];
    readonly toolInvocationIds: string[];
    readonly stepTrace: AgentStepTraceEntry[];
    readonly modelMessageTrace: ModelMessageTraceEntry[];
  }): Promise<ProviderRunResult> {
    const messages = [...args.executionMessages];

    for (let stepIndex = 0; stepIndex < MAX_AGENT_STEPS; stepIndex += 1) {
      args.modelMessageTrace.push({
        stepNumber: stepIndex + 1,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
        })),
      });

      const result = await args.adapter.runStep({
        modelId: args.modelId,
        messages,
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

      args.stepTrace.push({
        stepNumber: stepIndex + 1,
        type: 'tool-call',
        summary: result.rationale ?? `Model requested tool ${result.toolName}`,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
      });

      const toolExecution = await this.executeToolCall(args.taskId, result);
      args.toolInvocationIds.push(toolExecution.invocation.id);
      args.toolOutputs.push(toolExecution.output);
      args.stepTrace.push({
        stepNumber: stepIndex + 1,
        type: 'tool-result',
        summary: toolExecution.output.summary,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
      });

      messages.push({
        role: 'assistant',
        content: result.rationale ?? `Requesting tool ${result.toolName}`,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        toolArgs: result.args,
      });
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          status: toolExecution.output.status,
          summary: toolExecution.output.summary,
          output: toolExecution.output.output,
        }),
        toolCallId: result.toolCallId,
        toolName: result.toolName,
      });
    }

    throw new Error(`Agent task exceeded ${MAX_AGENT_STEPS} steps without producing a final response`);
  }

  private executeToolCall(taskId: string, result: Extract<ProviderStepResult, { type: 'tool-call' }>) {
    if (!this.toolService) {
      throw new Error(`Tool service is required to execute tool call: ${result.toolName}`);
    }

    const inputSummary = JSON.stringify({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: result.args,
    });

    switch (result.toolName) {
      case 'glob':
        return this.toolService.execute({
          taskId,
          toolName: 'glob',
          args: result.args,
          inputSummary,
        });
      case 'grep':
        return this.toolService.execute({
          taskId,
          toolName: 'grep',
          args: result.args,
          inputSummary,
        });
      case 'exec':
        return this.toolService.execute({
          taskId,
          toolName: 'exec',
          args: result.args,
          inputSummary,
        });
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

  private getMemories(input: RunAgentTaskInput): MemoryRecord[] {
    return input.taskContext?.memories ?? input.memories ?? [];
  }

  private createCompletedOutputSummary(
    input: RunAgentTaskInput,
    response: ProviderRunResult,
    toolOutputs: Awaited<ReturnType<ToolService['runForTask']>>['outputs'],
    toolInvocationIds: string[],
    stepTrace: AgentStepTraceEntry[],
    modelMessageTrace: ModelMessageTraceEntry[],
  ) {
    return withSourceAttribution(
      {
        outputSummary: response.outputSummary,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemories(input).map((memory) => memory.id),
        toolInvocationIds,
        toolNames: toolOutputs.map((output) => output.toolName),
        modelMessageTrace,
        stepTrace,
        toolResults: toolOutputs.map((output) => ({
          toolName: output.toolName,
          status: output.status,
          summary: output.summary,
        })),
      },
      {
        modelOutput: response.outputSummary,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemories(input).map((memory) => memory.id),
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
    const failureOutput = withSourceAttribution(
      {
        outputSummary: `Task failed: ${this.getErrorMessage(error)}`,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemories(input).map((memory) => memory.id),
        toolInvocationIds,
        toolNames: toolOutputs.map((output) => output.toolName),
        modelMessageTrace,
        stepTrace,
        toolResults: toolOutputs.map((output) => ({
          toolName: output.toolName,
          status: output.status,
          summary: output.summary,
        })),
      },
      {
        modelOutput: response?.outputSummary,
        promptIds: this.getPrompts(input).map((prompt) => prompt.id),
        memoryIds: this.getMemories(input).map((memory) => memory.id),
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
}
