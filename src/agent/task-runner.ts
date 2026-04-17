import { AgentTaskRepository } from './task-repository';
import type { AgentTask } from '../shared/schema';
import { ProviderRegistry } from '../providers/provider-registry';
import type { PromptAsset, MemoryRecord } from '../shared/schema';
import { withSourceAttribution } from '../shared/result';
import { ToolService } from '../tools/tool-service';

export interface RunAgentTaskInput {
  readonly goal: string;
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputContextSummary: string;
  readonly prompts?: PromptAsset[];
  readonly memories?: MemoryRecord[];
}

export class AgentTaskRunner {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly repository: AgentTaskRepository,
    private readonly toolService?: ToolService,
  ) {}

  async run(input: RunAgentTaskInput): Promise<AgentTask> {
    this.providerRegistry.ensureModel(input.providerId, input.modelId);
    const adapter = this.providerRegistry.getAdapter(input.providerId);
    const response = await adapter.runTask({
      modelId: input.modelId,
      goal: input.goal,
      inputContextSummary: this.buildInputSummary(input),
    });

    const initialTask = this.repository.create({
      goal: input.goal,
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      inputContextSummary: this.buildInputSummary(input),
      status: 'running',
      outputSummary: null,
      toolInvocationIds: [],
    });

    const toolRun = this.toolService ? await this.toolService.runForTask(initialTask.id, input.goal) : { invocations: [], outputs: [] };
    const enrichedOutput = withSourceAttribution(
      {
        outputSummary: response.outputSummary,
        promptIds: input.prompts?.map((prompt) => prompt.id) ?? [],
        memoryIds: input.memories?.map((memory) => memory.id) ?? [],
        toolInvocationIds: toolRun.invocations.map((invocation) => invocation.id),
        toolNames: toolRun.outputs.map((output) => output.toolName),
        toolResults: toolRun.outputs.map((output) => ({
          toolName: output.toolName,
          status: output.status,
          summary: output.summary,
        })),
      },
      {
        modelOutput: response.outputSummary,
        promptIds: input.prompts?.map((prompt) => prompt.id) ?? [],
        memoryIds: input.memories?.map((memory) => memory.id) ?? [],
        toolNames: toolRun.outputs.map((output) => output.toolName),
      },
    );

    return this.repository.update(initialTask.id, {
      goal: input.goal,
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      inputContextSummary: this.buildInputSummary(input),
      status: 'completed',
      outputSummary: JSON.stringify(enrichedOutput),
      toolInvocationIds: toolRun.invocations.map((invocation) => invocation.id),
    });
  }

  private buildInputSummary(input: RunAgentTaskInput): string {
    return JSON.stringify({
      inputContextSummary: input.inputContextSummary,
      promptIds: input.prompts?.map((prompt) => prompt.id) ?? [],
      memoryIds: input.memories?.map((memory) => memory.id) ?? [],
    });
  }
}
