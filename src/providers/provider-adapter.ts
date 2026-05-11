import { z } from 'zod';

export type ProviderToolName = 'grep' | 'glob' | 'exec' | 'read' | 'edit';
export type ToolExecutionPolicy = 'free' | 'approval-required';

interface ProviderJsonSchemaStringProperty {
  readonly type: 'string';
  readonly description?: string;
}

interface ProviderJsonSchemaIntegerProperty {
  readonly type: 'integer';
  readonly description?: string;
}

type ProviderJsonSchemaProperty = ProviderJsonSchemaStringProperty | ProviderJsonSchemaIntegerProperty;

interface ProviderToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, ProviderJsonSchemaProperty>;
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

export const providerReadToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  startLine: z.coerce.number().int().positive().optional(),
  endLine: z.coerce.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.startLine !== undefined && value.endLine !== undefined) {
    const startLine = value.startLine;
    const endLine = value.endLine;

    if (startLine === undefined || endLine === undefined) {
      return;
    }

    if (startLine > endLine) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startLine must be less than or equal to endLine',
        path: ['startLine'],
      });
    }
  }
});

export const providerEditToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  oldText: z.string(),
  newText: z.string(),
  startLine: z.coerce.number().int().positive().optional(),
  endLine: z.coerce.number().int().positive().optional(),
}).superRefine((value, context) => {
  const hasStartLine = value.startLine !== undefined;
  const hasEndLine = value.endLine !== undefined;

  if (value.oldText.length === 0 && (hasStartLine || hasEndLine)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'startLine and endLine are not supported when oldText is empty',
      path: ['oldText'],
    });
  }

  if (hasStartLine && hasEndLine) {
    const startLine = value.startLine;
    const endLine = value.endLine;

    if (startLine === undefined || endLine === undefined) {
      return;
    }

    if (startLine > endLine) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startLine must be less than or equal to endLine',
        path: ['startLine'],
      });
    }
  }
});

const providerLegacyWriteToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
});

const providerLegacyWriteTextToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  text: z.string(),
});

export type ProviderGlobToolArgs = z.infer<typeof providerGlobToolArgsSchema>;
export type ProviderGrepToolArgs = z.infer<typeof providerGrepToolArgsSchema>;
export type ProviderExecToolArgs = z.infer<typeof providerExecToolArgsSchema>;
export type ProviderReadToolArgs = z.infer<typeof providerReadToolArgsSchema>;
export type ProviderEditToolArgs = z.infer<typeof providerEditToolArgsSchema>;
export type ProviderToolArgs = ProviderGlobToolArgs | ProviderGrepToolArgs | ProviderExecToolArgs | ProviderReadToolArgs | ProviderEditToolArgs;
export type ProviderToolCall =
  | {
      readonly toolCallId: string;
      readonly toolName: 'glob';
      readonly args: ProviderGlobToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'grep';
      readonly args: ProviderGrepToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'exec';
      readonly args: ProviderExecToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'read';
      readonly args: ProviderReadToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'edit';
      readonly args: ProviderEditToolArgs;
    };

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

export const providerReadToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace-relative file path or absolute file path within the workspace to read as UTF-8 text.',
    },
    startLine: {
      type: 'integer',
      description: 'Optional 1-based starting line to read. When provided without endLine, reads from this line to the tool limit or end of file.',
    },
    endLine: {
      type: 'integer',
      description: 'Optional 1-based ending line to read. When provided without startLine, reads from line 1 through this line.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

export const providerEditToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace-relative file path or absolute file path within the workspace to edit.',
    },
    oldText: {
      type: 'string',
      description: 'Exact existing text to replace. Must match exactly once in the target file.',
    },
    newText: {
      type: 'string',
      description: 'Replacement text that will be written into the target file.',
    },
    startLine: {
      type: 'integer',
      description: 'Optional 1-based starting line for a constrained block edit. When provided without endLine, edits from this line to the end of the file.',
    },
    endLine: {
      type: 'integer',
      description: 'Optional 1-based ending line for a constrained block edit. When provided without startLine, edits from the top of the file through this line.',
    },
  },
  required: ['path', 'oldText', 'newText'],
  additionalProperties: false,
};

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: ProviderToolName;
  readonly toolArgs?: ProviderToolArgs;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly reasoningContent?: string;
}

export interface ProviderToolDefinition {
  readonly name: ProviderToolName;
  readonly description: string;
  readonly inputSchema: ProviderToolInputSchema;
  readonly executionPolicy: ToolExecutionPolicy;
}

export interface ProviderStepContext {
  readonly modelId: string;
  readonly messages: ProviderMessage[];
  readonly availableTools: ProviderToolDefinition[];
  readonly onTextDelta?: (text: string) => void;
}

export interface ProviderPromptUsageDetails {
  readonly cachedTokens?: number;
}

export interface ProviderCompletionUsageDetails {
  readonly reasoningTokens?: number;
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  readonly promptTokensDetails?: ProviderPromptUsageDetails;
  readonly completionTokensDetails?: ProviderCompletionUsageDetails;
}

export type ProviderStepResult =
  | {
      readonly type: 'final';
      readonly outputSummary: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'glob';
      readonly args: ProviderGlobToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'grep';
      readonly args: ProviderGrepToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'exec';
      readonly args: ProviderExecToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'read';
      readonly args: ProviderReadToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'edit';
      readonly args: ProviderEditToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      readonly type: 'tool-calls';
      readonly toolCalls: readonly ProviderToolCall[];
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
    };

export interface ProviderRunRequest {
  readonly modelId: string;
  readonly goal: string;
  readonly inputContextSummary: string;
}

export interface ProviderRunResult {
  readonly outputSummary: string;
  readonly usage?: ProviderUsage;
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
export function parseProviderToolArgs(toolName: 'read', rawArgs: unknown): ProviderReadToolArgs;
export function parseProviderToolArgs(toolName: 'edit', rawArgs: unknown): ProviderEditToolArgs;
export function parseProviderToolArgs(toolName: ProviderToolName, rawArgs: unknown): ProviderToolArgs {
  switch (toolName) {
    case 'glob':
      return providerGlobToolArgsSchema.parse(rawArgs);
    case 'grep':
      return providerGrepToolArgsSchema.parse(rawArgs);
    case 'exec':
      return providerExecToolArgsSchema.parse(rawArgs);
    case 'read':
      return providerReadToolArgsSchema.parse(rawArgs);
    case 'edit':
      return providerEditToolArgsSchema.parse(rawArgs);
  }
}

export function parseProviderEditCompatibleToolArgs(rawArgs: unknown): ProviderEditToolArgs {
  const directResult = providerEditToolArgsSchema.safeParse(rawArgs);
  if (directResult.success) {
    return directResult.data;
  }

  const legacyContentResult = providerLegacyWriteToolArgsSchema.safeParse(rawArgs);
  if (legacyContentResult.success) {
    return {
      path: legacyContentResult.data.path,
      oldText: '',
      newText: legacyContentResult.data.content,
    };
  }

  const legacyTextResult = providerLegacyWriteTextToolArgsSchema.safeParse(rawArgs);
  if (legacyTextResult.success) {
    return {
      path: legacyTextResult.data.path,
      oldText: '',
      newText: legacyTextResult.data.text,
    };
  }

  throw directResult.error;
}

export function normalizeProviderToolName(value: string | undefined): ProviderToolName | undefined {
  const normalizedValue = value?.trim().toLowerCase();
  switch (normalizedValue) {
    case 'glob':
    case 'grep':
    case 'exec':
    case 'read':
    case 'edit':
      return normalizedValue;
    case 'write':
      return 'edit';
    default:
      return undefined;
  }
}

export function getToolExecutionPolicy(toolName: ProviderToolName): ToolExecutionPolicy {
  switch (toolName) {
    case 'exec':
    case 'edit':
      return 'approval-required';
    case 'glob':
    case 'grep':
    case 'read':
      return 'free';
  }
}
