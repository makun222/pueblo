export type ProviderToolName = 'grep' | 'glob' | 'exec';

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: ProviderToolName;
}

export interface ProviderToolDefinition {
  readonly name: ProviderToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ProviderStepContext {
  readonly modelId: string;
  readonly messages: ProviderMessage[];
  readonly availableTools: ProviderToolDefinition[];
}

export type ProviderStepResult =
  | {
      readonly type: 'final';
      readonly outputSummary: string;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: ProviderToolName;
      readonly args: Record<string, unknown>;
      readonly rationale?: string;
    };

export interface ProviderRunRequest {
  readonly modelId: string;
  readonly goal: string;
  readonly inputContextSummary: string;
}

export interface ProviderRunResult {
  readonly outputSummary: string;
}

export interface ProviderAdapter {
  runStep(context: ProviderStepContext): Promise<ProviderStepResult>;
  runTask(request: ProviderRunRequest): Promise<ProviderRunResult>;
}

export class InMemoryProviderAdapter implements ProviderAdapter {
  constructor(
    public readonly providerId: string,
    private readonly responseText: string,
  ) {}

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const latestUserMessage = [...context.messages].reverse().find((message) => message.role === 'user');

    return {
      type: 'final',
      outputSummary: `${this.responseText}: ${latestUserMessage?.content ?? 'No goal provided'}`,
    };
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await this.runStep(createLegacyStepContext(request));

    if (result.type !== 'final') {
      throw new Error('InMemoryProviderAdapter does not support tool calls in compatibility mode');
    }

    return { outputSummary: result.outputSummary };
  }
}

export function createLegacyStepContext(request: ProviderRunRequest): ProviderStepContext {
  return {
    modelId: request.modelId,
    messages: [
      {
        role: 'system',
        content: request.inputContextSummary,
      },
      {
        role: 'user',
        content: request.goal,
      },
    ],
    availableTools: [],
  };
}
