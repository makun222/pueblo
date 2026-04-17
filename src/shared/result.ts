export interface ResultMessage {
  readonly code: string;
  readonly message: string;
  readonly details?: string[];
}

export interface SourceAttribution {
  readonly modelOutput?: string;
  readonly promptIds?: string[];
  readonly memoryIds?: string[];
  readonly toolNames?: string[];
}

interface TaskResultPayload {
  readonly outputSummary?: string;
  readonly attribution?: SourceAttribution;
  readonly toolResults?: Array<{
    readonly toolName: string;
    readonly status: string;
    readonly summary: string;
  }>;
}

export interface OutputBlockInput {
  readonly type: 'command-result' | 'task-result' | 'tool-result' | 'error' | 'system';
  readonly title: string;
  readonly content: string;
  readonly collapsed?: boolean;
  readonly sourceRefs?: string[];
}

export interface CommandResult<TData = unknown> {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly data?: TData;
  readonly suggestions: string[];
}

export function successResult<TData>(code: string, message: string, data?: TData): CommandResult<TData> {
  return {
    ok: true,
    code,
    message,
    data,
    suggestions: [],
  };
}

export function failureResult(code: string, message: string, suggestions: string[] = []): CommandResult {
  return {
    ok: false,
    code,
    message,
    suggestions,
  };
}

export function formatCommandResult(result: CommandResult): string {
  const lines = [`[${result.code}] ${result.message}`];

  if (result.data !== undefined) {
    lines.push(JSON.stringify(result.data, null, 2));
  }

  if (result.suggestions.length > 0) {
    lines.push('Suggestions:');
    for (const suggestion of result.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatError(error: unknown): CommandResult {
  if (error instanceof Error) {
    return failureResult('UNEXPECTED_ERROR', error.message, ['Inspect the command input and retry.']);
  }

  return failureResult('UNKNOWN_ERROR', 'An unknown error occurred', ['Inspect the command input and retry.']);
}

export function withSourceAttribution<TData extends Record<string, unknown>>(
  data: TData,
  attribution: SourceAttribution,
): TData & { attribution: SourceAttribution } {
  return {
    ...data,
    attribution,
  };
}

export function createOutputBlock(input: OutputBlockInput) {
  const now = new Date().toISOString();
  return {
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    type: input.type,
    title: input.title,
    content: input.content,
    collapsed: input.collapsed ?? false,
    sourceRefs: input.sourceRefs ?? [],
    createdAt: now,
  };
}

export function createResultBlocks(result: CommandResult<unknown>) {
  const blocks = [
    createOutputBlock({
      type: result.ok ? 'command-result' : 'error',
      title: result.code,
      content: result.message,
    }),
  ];

  if (result.data !== undefined) {
    const payload = extractTaskResultPayload(result.data);

    if (payload) {
      const outputSummary = payload.outputSummary ?? payload.attribution?.modelOutput ?? JSON.stringify(result.data, null, 2);

      blocks.push(
        createOutputBlock({
          type: result.ok ? 'task-result' : 'error',
          title: 'Output Summary',
          content: outputSummary,
        }),
      );

      if (payload.attribution?.modelOutput) {
        blocks.push(
          createOutputBlock({
            type: 'system',
            title: 'Model Output',
            content: payload.attribution.modelOutput,
            collapsed: true,
          }),
        );
      }

      if ((payload.attribution?.promptIds?.length ?? 0) > 0) {
        blocks.push(
          createOutputBlock({
            type: 'system',
            title: `${result.code}-prompts`,
            content: `Prompt sources: ${payload.attribution?.promptIds?.join(', ')}`,
          }),
        );
      }

      if ((payload.attribution?.memoryIds?.length ?? 0) > 0) {
        blocks.push(
          createOutputBlock({
            type: 'system',
            title: `${result.code}-memories`,
            content: `Memory sources: ${payload.attribution?.memoryIds?.join(', ')}`,
          }),
        );
      }

      for (const toolResult of payload.toolResults ?? []) {
        blocks.push(
          createOutputBlock({
            type: 'tool-result',
            title: `${result.code}-${toolResult.toolName}`,
            content: `${toolResult.toolName}: ${toolResult.status} - ${toolResult.summary}`,
          }),
        );
      }
    } else {
      blocks.push(
        createOutputBlock({
          type: result.ok ? 'task-result' : 'error',
          title: `${result.code}-data`,
          content: JSON.stringify(result.data, null, 2),
        }),
      );
    }
  }

  if (result.suggestions.length > 0) {
    blocks.push(
      createOutputBlock({
        type: 'system',
        title: `${result.code}-suggestions`,
        content: result.suggestions.join('\n'),
      }),
    );
  }

  return blocks;
}

function extractTaskResultPayload(data: unknown): TaskResultPayload | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as { outputSummary?: unknown };
  if (typeof candidate.outputSummary !== 'string') {
    return null;
  }

  try {
    return JSON.parse(candidate.outputSummary) as TaskResultPayload;
  } catch {
    return {
      outputSummary: candidate.outputSummary,
    };
  }
}
