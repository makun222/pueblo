import { z } from 'zod';

export type ProviderToolName = 'grep' | 'glob' | 'exec';

interface ProviderJsonSchemaStringProperty {
  readonly type: 'string';
  readonly description?: string;
}

interface ProviderToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, ProviderJsonSchemaStringProperty>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export const providerGlobToolArgsSchema = z.object({
  pattern: z.string().trim().min(1),
});

export const providerGrepToolArgsSchema = z.object({
  pattern: z.string().trim().min(1),
  include: z.string().trim().min(1).optional(),
});

export const providerExecToolArgsSchema = z.object({
  command: z.string().trim().min(1),
});

export type ProviderGlobToolArgs = z.infer<typeof providerGlobToolArgsSchema>;
export type ProviderGrepToolArgs = z.infer<typeof providerGrepToolArgsSchema>;
export type ProviderExecToolArgs = z.infer<typeof providerExecToolArgsSchema>;
export type ProviderToolArgs = ProviderGlobToolArgs | ProviderGrepToolArgs | ProviderExecToolArgs;

export const providerGlobToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Glob pattern relative to the workspace root.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

export const providerGrepToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Case-insensitive regex pattern to search for.',
    },
    include: {
      type: 'string',
      description: 'Optional glob filter for files to search.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

export const providerExecToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Command to execute without a shell from the workspace root.',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: ProviderToolName;
  readonly toolArgs?: ProviderToolArgs;
}

export interface ProviderToolDefinition {
  readonly name: ProviderToolName;
  readonly description: string;
  readonly inputSchema: ProviderToolInputSchema;
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
      readonly toolName: 'glob';
      readonly args: ProviderGlobToolArgs;
      readonly rationale?: string;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'grep';
      readonly args: ProviderGrepToolArgs;
      readonly rationale?: string;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'exec';
      readonly args: ProviderExecToolArgs;
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

export function parseProviderToolArgs(toolName: 'glob', rawArgs: unknown): ProviderGlobToolArgs;
export function parseProviderToolArgs(toolName: 'grep', rawArgs: unknown): ProviderGrepToolArgs;
export function parseProviderToolArgs(toolName: 'exec', rawArgs: unknown): ProviderExecToolArgs;
export function parseProviderToolArgs(toolName: ProviderToolName, rawArgs: unknown): ProviderToolArgs {
  switch (toolName) {
    case 'glob':
      return providerGlobToolArgsSchema.parse(rawArgs);
    case 'grep':
      return providerGrepToolArgsSchema.parse(rawArgs);
    case 'exec':
      return providerExecToolArgsSchema.parse(rawArgs);
  }
}
