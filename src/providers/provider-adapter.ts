import { z } from 'zod';

export type ProviderToolName = 'grep' | 'glob' | 'exec' | 'shell_exec' | 'read' | 'edit' | 'write' | 'undo_edit' | 'memo_recall';
export type ToolExecutionPolicy = 'free' | 'approval-required';

interface ProviderJsonSchemaStringProperty {
  readonly type: 'string';
  readonly description?: string;
  readonly enum?: readonly string[];
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

export const providerShellExecToolArgsSchema = z.object({
  mode: z.enum(['cmd', 'powershell']),
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

export const providerWriteToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  text: z.string(),
});

export const providerUndoEditToolArgsSchema = z.object({
  path: z.string().trim().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export const providerUndoEditToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'File path to read and display for undo reference.',
    },
    startLine: {
      type: 'integer',
      description: 'Optional starting line number (1-based) of the old content.',
    },
    endLine: {
      type: 'integer',
      description: 'Optional ending line number (1-based) of the old content.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};

export const providerMemoRecallToolArgsSchema = z.object({
  keyword: z.string().trim().min(1),
  turnCount: z.number().int().positive(),
  matchMode: z.enum(['exact', 'fuzzy', 'semantic']).optional(),
});

export const providerMemoRecallToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    keyword: {
      type: 'string',
      description: 'The keyword to search for in stored memory records.',
    },
    turnCount: {
      type: 'integer',
      description: 'Maximum number of recent turns to search (1 turn = 1 user+assistant exchange).',
    },
  },
  required: ['keyword', 'turnCount'],
  additionalProperties: false,
};

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
export type ProviderShellExecToolArgs = z.infer<typeof providerShellExecToolArgsSchema>;
export type ProviderReadToolArgs = z.infer<typeof providerReadToolArgsSchema>;
export type ProviderEditToolArgs = z.infer<typeof providerEditToolArgsSchema>;
export type ProviderWriteToolArgs = z.infer<typeof providerWriteToolArgsSchema>;
export type ProviderUndoEditToolArgs = z.infer<typeof providerUndoEditToolArgsSchema>;
export type ProviderMemoRecallToolArgs = z.infer<typeof providerMemoRecallToolArgsSchema>;

export type ProviderToolArgs = ProviderGlobToolArgs | ProviderGrepToolArgs | ProviderExecToolArgs | ProviderShellExecToolArgs | ProviderReadToolArgs | ProviderEditToolArgs | ProviderWriteToolArgs | ProviderUndoEditToolArgs | ProviderMemoRecallToolArgs;
export type ProviderToolArgsByName<TToolName extends ProviderToolName> =
  TToolName extends 'glob' ? ProviderGlobToolArgs :
    TToolName extends 'grep' ? ProviderGrepToolArgs :
      TToolName extends 'exec' ? ProviderExecToolArgs :
        TToolName extends 'shell_exec' ? ProviderShellExecToolArgs :
          TToolName extends 'read' ? ProviderReadToolArgs :
            TToolName extends 'edit' ? ProviderEditToolArgs :
              TToolName extends 'undo_edit' ? ProviderUndoEditToolArgs :
                TToolName extends 'memo_recall' ? ProviderMemoRecallToolArgs :
                  ProviderWriteToolArgs;
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
      readonly toolName: 'shell_exec';
      readonly args: ProviderShellExecToolArgs;
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
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'write';
      readonly args: ProviderWriteToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'undo_edit';
      readonly args: ProviderUndoEditToolArgs;
    }
  | {
      readonly toolCallId: string;
      readonly toolName: 'memo_recall';
      readonly args: ProviderMemoRecallToolArgs;
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

export const providerShellExecToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['cmd', 'powershell'],
      description: 'Shell mode to use for command execution.',
    },
    command: {
      type: 'string',
      description: 'Command string to execute via the selected shell from the workspace root.',
    },
  },
  required: ['mode', 'command'],
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

export const providerWriteToolInputSchema: ProviderToolInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace-relative file path or absolute file path within the workspace to create or overwrite.',
    },
    text: {
      type: 'string',
      description: 'Text content to write to the target file.',
    },
  },
  required: ['path', 'text'],
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
  readonly signal?: AbortSignal;
  /** Unique identifier for the agent job (loop job), used to distinguish
   *  concurrent agent runs. Falls back to process PID if not provided. */
  readonly userId?: string;
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

export interface ProviderRequestMetrics {
  readonly submittedTokens: number;
  readonly bodyBytes: number;
  readonly originalBodyBytes: number;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly roleCounts: Record<ProviderMessage['role'], number>;
  readonly compacted: boolean;
  readonly compactedToolMessages: number;
  readonly compactionStage: string;
}

export type ProviderStepResult =
  | {
      readonly type: 'final';
      readonly outputSummary: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'glob';
      readonly args: ProviderGlobToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'grep';
      readonly args: ProviderGrepToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'exec';
      readonly args: ProviderExecToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'shell_exec';
      readonly args: ProviderShellExecToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'read';
      readonly args: ProviderReadToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'edit';
      readonly args: ProviderEditToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'write';
      readonly args: ProviderWriteToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'undo_edit';
      readonly args: ProviderUndoEditToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: 'memo_recall';
      readonly args: ProviderMemoRecallToolArgs;
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    }
  | {
      readonly type: 'tool-calls';
      readonly toolCalls: readonly ProviderToolCall[];
      readonly rationale?: string;
      readonly reasoningContent?: string;
      readonly usage?: ProviderUsage;
      readonly requestMetrics?: ProviderRequestMetrics;
    };

export interface ProviderRunRequest {
  readonly modelId: string;
  readonly goal: string;
  readonly inputContextSummary: string;
  readonly userId?: string;
}

export interface ProviderRunResult {
  readonly outputSummary: string;
  readonly usage?: ProviderUsage;
  readonly requestMetrics?: ProviderRequestMetrics;
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
    userId: request.userId,
  };
}

export function parseProviderToolArgs<TToolName extends ProviderToolName>(
  toolName: TToolName,
  rawArgs: unknown,
): ProviderToolArgsByName<TToolName> {
  switch (toolName) {
    case 'glob':
      return providerGlobToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'grep':
      return providerGrepToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'exec':
      return providerExecToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'shell_exec':
      return providerShellExecToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'read':
      return providerReadToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'edit':
      return providerEditToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'write':
      return providerWriteToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'undo_edit':
      return providerUndoEditToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
    case 'memo_recall':
      return providerMemoRecallToolArgsSchema.parse(rawArgs) as ProviderToolArgsByName<TToolName>;
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
    case 'shell_exec':
    case 'read':
    case 'edit':
    case 'write':
    case 'memo_recall':
      return normalizedValue;
    default:
      return undefined;
  }
}

export function getToolExecutionPolicy(toolName: string): ToolExecutionPolicy {
  switch (toolName) {
    case 'exec':
    case 'shell_exec':
    case 'edit':
    case 'write':
    case 'undo_edit':
      return 'approval-required';
    case 'glob':
    case 'grep':
    case 'read':
    case 'memo_recall':
      return 'free';
    default:
      // Unknown tools (e.g. provider-specific extensions) default to
      // requiring approval so they don't bypass the approval flow.
      return 'approval-required';
  }
}
