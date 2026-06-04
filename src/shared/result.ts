import type { RendererFileChange } from './schema';
import type { ProviderRequestMetrics, ProviderUsage } from '../providers/provider-adapter';

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

interface TaskModelMessageTraceEntry {
  readonly stepNumber: number;
  readonly messages: Array<{
    readonly role: string;
    readonly content: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly toolArgs?: unknown;
  }>;
}

interface TaskResultPayload {
  readonly outputSummary?: string;
  readonly providerUsage?: ProviderUsage;
  readonly providerRequestMetrics?: ProviderRequestMetrics;
  readonly targetDirectory?: string | null;
  readonly toolExecutionCwd?: string | null;
  readonly workflow?: WorkflowBlockData | null;
  readonly attribution?: SourceAttribution;
  readonly modelMessageTrace?: TaskModelMessageTraceEntry[];
  readonly stepTrace?: Array<{
    readonly stepNumber: number;
    readonly type: string;
    readonly summary: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
  }>;
  readonly toolResults?: Array<{
    readonly toolName: string;
    readonly status: string;
    readonly summary: string;
    readonly executionCwd?: string | null;
  }>;
  readonly fileChanges?: RendererFileChange[];
}

interface ExecCommandBlockData {
  readonly rawCommand: string;
  readonly command: string;
  readonly args: string[];
  readonly result: string;
}

interface WorkflowBlockData {
  readonly workflowId?: string;
  readonly workflowType?: string;
  readonly status?: string;
  readonly routeReason?: string;
  readonly activeRoundNumber?: number | null;
  readonly completedRoundNumber?: number | null;
  readonly planMemoryId?: string | null;
  readonly todoMemoryId?: string | null;
  readonly runtimePlanPath?: string | null;
  readonly deliverablePlanPath?: string | null;
  readonly recovered?: boolean;
  readonly exportResult?: {
    readonly status?: 'exported' | 'unchanged' | 'conflict';
    readonly deliverablePlanPath?: string;
    readonly exportedAt?: string | null;
  } | null;
}

export interface OutputBlockInput {
  readonly type: 'command-result' | 'task-result' | 'tool-result' | 'error' | 'system';
  readonly title: string;
  readonly content: string;
  readonly collapsed?: boolean;
  readonly messageTrace?: TaskModelMessageTraceEntry[];
  readonly fileChanges?: RendererFileChange[];
  readonly execCommand?: ExecCommandBlockData;
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

export interface ParsedTaskOutputSummary {
  readonly outputSummary?: string;
  readonly providerUsage?: ProviderUsage;
  readonly providerRequestMetrics?: ProviderRequestMetrics;
  readonly targetDirectory?: string | null;
  readonly toolExecutionCwd?: string | null;
  readonly workflow?: WorkflowBlockData | null;
  readonly attribution?: SourceAttribution;
  readonly modelMessageTrace?: TaskModelMessageTraceEntry[];
  readonly stepTrace?: Array<{
    readonly stepNumber: number;
    readonly type: string;
    readonly summary: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
  }>;
  readonly toolResults?: Array<{
    readonly toolName: string;
    readonly status: string;
    readonly summary: string;
    readonly executionCwd?: string | null;
  }>;
  readonly fileChanges?: RendererFileChange[];
}

export type TaskStepTraceEntry = NonNullable<ParsedTaskOutputSummary['stepTrace']>[number];

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

export function extractTaskOutputSummaryText(outputSummary: string | null | undefined): string | null {
  const parsed = extractTaskOutputSummaryPayload(outputSummary);
  return parsed?.outputSummary ?? parsed?.attribution?.modelOutput ?? outputSummary ?? null;
}

export function extractTaskOutputSummaryPayload(outputSummary: string | null | undefined): ParsedTaskOutputSummary | null {
  if (!outputSummary) {
    return null;
  }

  return parseTaskResultPayload(outputSummary);
}

export function summarizeModelMessageTrace(trace: ParsedTaskOutputSummary['modelMessageTrace'] | null | undefined): {
  readonly messageCount: number;
  readonly messageCharCount: number;
} {
  if (!trace || trace.length === 0) {
    return {
      messageCount: 0,
      messageCharCount: 0,
    };
  }

  return trace.reduce(
    (totals, step) => ({
      messageCount: totals.messageCount + step.messages.length,
      messageCharCount: totals.messageCharCount + step.messages.reduce((sum, message) => sum + message.content.length, 0),
    }),
    {
      messageCount: 0,
      messageCharCount: 0,
    },
  );
}

export function createOutputBlock(input: OutputBlockInput) {
  const now = new Date().toISOString();
  return {
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    type: input.type,
    title: input.title,
    content: input.content,
    collapsed: input.collapsed ?? false,
    messageTrace: toRendererMessageTrace(input.messageTrace),
    fileChanges: input.fileChanges ?? [],
    execCommand: input.execCommand,
    sourceRefs: input.sourceRefs ?? [],
    createdAt: now,
  };
}

export function summarizeTaskStepTrace(stepTrace: readonly TaskStepTraceEntry[] | null | undefined): Array<{
  readonly stepNumber: number;
  readonly content: string;
}> {
  if (!stepTrace || stepTrace.length === 0) {
    return [];
  }

  const grouped = new Map<number, TaskStepTraceEntry[]>();
  for (const entry of stepTrace) {
    const entries = grouped.get(entry.stepNumber);
    if (entries) {
      entries.push(entry);
      continue;
    }

    grouped.set(entry.stepNumber, [entry]);
  }

  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([stepNumber, entries]) => ({
      stepNumber,
      content: buildTaskStepSummaryContent(stepNumber, entries),
    }))
    .filter((entry) => entry.content.length > 0);
}

export function createResultBlocks(result: CommandResult<unknown>) {
  const phasedBlocks = createPhasedResultBlocks(result);
  return phasedBlocks.primaryBlock ? [phasedBlocks.primaryBlock, ...phasedBlocks.supplementalBlocks] : phasedBlocks.supplementalBlocks;
}

export function createPhasedResultBlocks(result: CommandResult<unknown>): {
  readonly primaryBlock: ReturnType<typeof createOutputBlock> | null;
  readonly supplementalBlocks: ReturnType<typeof createOutputBlock>[];
} {
  const payload = result.data !== undefined ? extractTaskResultPayload(result.data) : null;
  const supplementalBlocks = [] as ReturnType<typeof createOutputBlock>[];
  const messageTrace = payload?.modelMessageTrace ?? [];
  const execCommandBlocks = extractExecCommandBlocks(messageTrace);
  let execCommandBlockIndex = 0;
  let didAttachMessageTrace = false;
  let primaryBlock: ReturnType<typeof createOutputBlock> | null = null;

  const consumeMessageTrace = () => {
    if (didAttachMessageTrace) {
      return [];
    }

    didAttachMessageTrace = true;
    return messageTrace;
  };

  if (!result.ok || !payload) {
    primaryBlock = createOutputBlock({
      type: result.ok ? 'command-result' : 'error',
      title: result.code,
      content: result.message,
      messageTrace: consumeMessageTrace(),
    });
  }

  if (result.data !== undefined) {
    if (payload) {
      const outputSummary = payload.outputSummary ?? payload.attribution?.modelOutput ?? JSON.stringify(result.data, null, 2);
      const modelOutput = payload.attribution?.modelOutput?.trim();
      const shouldShowModelOutput = Boolean(modelOutput) && modelOutput !== outputSummary.trim();

      if (!primaryBlock) {
        primaryBlock = createOutputBlock({
          type: result.ok ? 'task-result' : 'error',
          title: 'Output Summary',
          content: outputSummary,
          messageTrace: consumeMessageTrace(),
          fileChanges: payload.fileChanges,
        });
      }

      if (shouldShowModelOutput && modelOutput) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: 'Model Output',
            content: modelOutput,
            collapsed: true,
            messageTrace: consumeMessageTrace(),
          }),
        );
      }

      if ((payload.attribution?.promptIds?.length ?? 0) > 0) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: `${result.code}-prompts`,
            content: `Prompt sources: ${payload.attribution?.promptIds?.join(', ')}`,
            messageTrace: consumeMessageTrace(),
          }),
        );
      }

      if ((payload.attribution?.memoryIds?.length ?? 0) > 0) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: `${result.code}-memories`,
            content: `Memory sources: ${payload.attribution?.memoryIds?.join(', ')}`,
            messageTrace: consumeMessageTrace(),
          }),
        );
      }

      if ((payload.stepTrace?.length ?? 0) > 0) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: 'Step Trace',
            content: payload.stepTrace!.map(formatStepTraceLine).join('\n'),
            collapsed: true,
            messageTrace: consumeMessageTrace(),
          }),
        );
      }

      const workflowBlockData = extractWorkflowBlockData(result.data, payload);
      if (workflowBlockData) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: 'Workflow',
            content: formatWorkflowBlock(workflowBlockData),
            messageTrace: consumeMessageTrace(),
            sourceRefs: [
              workflowBlockData.runtimePlanPath,
              workflowBlockData.deliverablePlanPath,
            ].filter((value): value is string => Boolean(value)),
          }),
        );

        if (workflowBlockData.exportResult) {
          supplementalBlocks.push(
            createOutputBlock({
              type: 'system',
              title: 'Workflow Export',
              content: formatWorkflowExportBlock(workflowBlockData.exportResult),
              messageTrace: consumeMessageTrace(),
              sourceRefs: [workflowBlockData.exportResult.deliverablePlanPath].filter((value): value is string => Boolean(value)),
            }),
          );
        }
      }

      for (const toolResult of payload.toolResults ?? []) {
        const execCommand = toolResult.toolName === 'exec' || toolResult.toolName === 'shell_exec'
          ? execCommandBlocks[execCommandBlockIndex++]
          : undefined;
        supplementalBlocks.push(
          createOutputBlock({
            type: 'tool-result',
            title: execCommand ? 'Command Execution' : `${result.code}-${toolResult.toolName}`,
            content: execCommand?.result || `${toolResult.toolName}: ${toolResult.status} - ${toolResult.summary}`,
            collapsed: Boolean(execCommand),
            messageTrace: consumeMessageTrace(),
            execCommand,
          }),
        );
      }
    } else {
      const workflowBlockData = extractWorkflowBlockData(result.data, null);
      if (!primaryBlock) {
        primaryBlock = createOutputBlock({
          type: result.ok ? 'task-result' : 'error',
          title: `${result.code}-data`,
          content: JSON.stringify(result.data, null, 2),
          messageTrace: consumeMessageTrace(),
        });
      }

      if (workflowBlockData) {
        supplementalBlocks.push(
          createOutputBlock({
            type: 'system',
            title: 'Workflow',
            content: formatWorkflowBlock(workflowBlockData),
            messageTrace: consumeMessageTrace(),
            sourceRefs: [
              workflowBlockData.runtimePlanPath,
              workflowBlockData.deliverablePlanPath,
            ].filter((value): value is string => Boolean(value)),
          }),
        );

        if (workflowBlockData.exportResult) {
          supplementalBlocks.push(
            createOutputBlock({
              type: 'system',
              title: 'Workflow Export',
              content: formatWorkflowExportBlock(workflowBlockData.exportResult),
              messageTrace: consumeMessageTrace(),
              sourceRefs: [workflowBlockData.exportResult.deliverablePlanPath].filter((value): value is string => Boolean(value)),
            }),
          );
        }
      }
    }
  }

  if (result.suggestions.length > 0) {
    supplementalBlocks.push(
      createOutputBlock({
        type: 'system',
        title: `${result.code}-suggestions`,
        content: result.suggestions.join('\n'),
        messageTrace: consumeMessageTrace(),
      }),
    );
  }

  return {
    primaryBlock,
    supplementalBlocks,
  };
}

function extractTaskResultPayload(data: unknown): TaskResultPayload | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as { outputSummary?: unknown };
  if (typeof candidate.outputSummary !== 'string') {
    return null;
  }

  return parseTaskResultPayload(candidate.outputSummary);
}

function parseTaskResultPayload(outputSummary: string): ParsedTaskOutputSummary {
  try {
    return JSON.parse(outputSummary) as TaskResultPayload;
  } catch {
    return {
      outputSummary,
    };
  }
}

function extractWorkflowBlockData(data: unknown, payload: ParsedTaskOutputSummary | null): WorkflowBlockData | null {
  const payloadWorkflow = payload?.workflow && typeof payload.workflow === 'object'
    ? payload.workflow
    : null;

  if (!data || typeof data !== 'object') {
    return payloadWorkflow;
  }

  const candidate = data as Record<string, unknown>;
  const topLevelWorkflow = candidate.workflow && typeof candidate.workflow === 'object'
    ? candidate.workflow as Record<string, unknown>
    : null;
  const directWorkflowLike = hasWorkflowShape(candidate) ? candidate : null;
  const merged = {
    ...(payloadWorkflow ?? {}),
    ...(directWorkflowLike ?? {}),
    ...(topLevelWorkflow ?? {}),
  } satisfies WorkflowBlockData;

  if (!merged.workflowId && !merged.runtimePlanPath && !merged.deliverablePlanPath) {
    return null;
  }

  return merged;
}

function hasWorkflowShape(candidate: Record<string, unknown>): boolean {
  return typeof candidate.workflowId === 'string'
    || typeof candidate.runtimePlanPath === 'string'
    || typeof candidate.deliverablePlanPath === 'string';
}

function formatWorkflowBlock(workflow: WorkflowBlockData): string {
  const lines = [
    `Workflow ID: ${workflow.workflowId ?? 'unknown'}`,
  ];

  if (workflow.workflowType) {
    lines.push(`Workflow Type: ${workflow.workflowType}`);
  }
  if (workflow.status) {
    lines.push(`Status: ${workflow.status}`);
  }
  if (workflow.routeReason) {
    lines.push(`Route Reason: ${workflow.routeReason}`);
  }
  if (workflow.activeRoundNumber !== undefined) {
    lines.push(`Active Round: ${workflow.activeRoundNumber ?? 'none'}`);
  }
  if (workflow.completedRoundNumber !== undefined) {
    lines.push(`Completed Round: ${workflow.completedRoundNumber ?? 'none'}`);
  }
  if (workflow.runtimePlanPath) {
    lines.push(`Runtime Plan Path: ${workflow.runtimePlanPath}`);
  }
  if (workflow.deliverablePlanPath) {
    lines.push(`Deliverable Plan Path: ${workflow.deliverablePlanPath}`);
  }
  if (workflow.planMemoryId) {
    lines.push(`Plan Memory ID: ${workflow.planMemoryId}`);
  }
  if (workflow.todoMemoryId) {
    lines.push(`Todo Memory ID: ${workflow.todoMemoryId}`);
  }
  if (workflow.recovered) {
    lines.push('Recovery: restored from runtime plan');
  }

  return lines.join('\n');
}

function formatWorkflowExportBlock(exportResult: NonNullable<WorkflowBlockData['exportResult']>): string {
  const lines = [
    `Export Status: ${exportResult.status ?? 'unknown'}`,
  ];

  if (exportResult.deliverablePlanPath) {
    lines.push(`Deliverable Plan Path: ${exportResult.deliverablePlanPath}`);
  }
  if (exportResult.exportedAt) {
    lines.push(`Exported At: ${exportResult.exportedAt}`);
  }

  return lines.join('\n');
}

function formatStepTraceLine(step: NonNullable<ParsedTaskOutputSummary['stepTrace']>[number]): string {
  const toolSuffix = step.toolName ? ` (${step.toolName}${step.toolCallId ? ` / ${step.toolCallId}` : ''})` : '';
  return `${step.stepNumber}. ${step.type}${toolSuffix}: ${step.summary}`;
}

const TASK_STEP_SUMMARY_CHAR_LIMIT = 240;

function buildTaskStepSummaryContent(stepNumber: number, entries: readonly TaskStepTraceEntry[]): string {
  const detailLines = entries
    .map((entry) => {
      const normalizedSummary = truncateStepSummary(entry.summary.trim());
      if (!normalizedSummary) {
        return null;
      }

      const labelParts = [entry.type, entry.toolName, entry.toolCallId].filter((value): value is string => Boolean(value));
      return `- ${labelParts.join(' / ')}: ${normalizedSummary}`;
    })
    .filter((line): line is string => Boolean(line));

  if (detailLines.length === 0) {
    return '';
  }

  return [`Step ${stepNumber}`, ...detailLines].join('\n');
}

function truncateStepSummary(summary: string): string {
  if (summary.length <= TASK_STEP_SUMMARY_CHAR_LIMIT) {
    return summary;
  }

  return `${summary.slice(0, TASK_STEP_SUMMARY_CHAR_LIMIT - 3)}...`;
}

function toRendererMessageTrace(trace: ParsedTaskOutputSummary['modelMessageTrace'] | null | undefined) {
  if (!trace || trace.length === 0) {
    return [];
  }

  return trace.map((step) => ({
    stepNumber: step.stepNumber,
    messageCount: step.messages.length,
    charCount: step.messages.reduce((sum, message) => sum + message.content.length, 0),
    messages: step.messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      toolArgs: message.toolArgs,
      charCount: message.content.length,
    })),
  }));
}

function extractExecCommandBlocks(trace: ParsedTaskOutputSummary['modelMessageTrace'] | null | undefined): ExecCommandBlockData[] {
  if (!trace || trace.length === 0) {
    return [];
  }

  const pendingByCallId = new Map<string, Omit<ExecCommandBlockData, 'result'>>();
  const pendingQueue: string[] = [];
  const blocks: ExecCommandBlockData[] = [];

  for (const step of trace) {
    for (const message of step.messages) {
      if (message.toolName !== 'exec' && message.toolName !== 'shell_exec') {
        continue;
      }

      if (message.role !== 'tool') {
        const commandText = extractExecCommandText(message.toolArgs);
        if (!commandText) {
          continue;
        }

        const pending = createPendingExecCommandBlock(commandText);
        const key = message.toolCallId ?? `exec-${pendingQueue.length}`;
        pendingByCallId.set(key, pending);
        pendingQueue.push(key);
        continue;
      }

      const parsed = parseSerializedToolContent(message.content);
      const matchedPending = message.toolCallId ? consumePendingExecCommand(message.toolCallId, pendingByCallId, pendingQueue) : undefined;
      const fallbackPending = matchedPending ?? consumeNextPendingExecCommand(pendingByCallId, pendingQueue);
      if (!fallbackPending) {
        continue;
      }

      blocks.push({
        ...fallbackPending,
        result: formatExecCommandResult(parsed),
      });
    }
  }

  return blocks;
}

function createPendingExecCommandBlock(commandText: string): Omit<ExecCommandBlockData, 'result'> {
  const [command, ...args] = splitExecCommandText(commandText);

  return {
    rawCommand: commandText,
    command: command || commandText.trim(),
    args,
  };
}

function consumePendingExecCommand(
  key: string,
  pendingByCallId: Map<string, Omit<ExecCommandBlockData, 'result'>>,
  pendingQueue: string[],
): Omit<ExecCommandBlockData, 'result'> | undefined {
  const pending = pendingByCallId.get(key);
  if (!pending) {
    return undefined;
  }

  pendingByCallId.delete(key);
  const queueIndex = pendingQueue.indexOf(key);
  if (queueIndex >= 0) {
    pendingQueue.splice(queueIndex, 1);
  }

  return pending;
}

function consumeNextPendingExecCommand(
  pendingByCallId: Map<string, Omit<ExecCommandBlockData, 'result'>>,
  pendingQueue: string[],
): Omit<ExecCommandBlockData, 'result'> | undefined {
  while (pendingQueue.length > 0) {
    const key = pendingQueue.shift();
    if (!key) {
      continue;
    }

    const pending = pendingByCallId.get(key);
    if (!pending) {
      continue;
    }

    pendingByCallId.delete(key);
    return pending;
  }

  return undefined;
}

function extractExecCommandText(toolArgs: unknown): string | null {
  if (!toolArgs || typeof toolArgs !== 'object') {
    return null;
  }

  const maybeCommand = (toolArgs as { command?: unknown }).command;
  return typeof maybeCommand === 'string' && maybeCommand.trim().length > 0 ? maybeCommand.trim() : null;
}

function splitExecCommandText(commandText: string): string[] {
  const matches = commandText.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
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

function formatExecCommandResult(parsed: { status: string; summary: string; output: string[] } | null): string {
  if (!parsed) {
    return 'No command output captured.';
  }

  if (parsed.output.length > 0) {
    return parsed.output.join('\n\n');
  }

  return parsed.summary.trim().length > 0 ? parsed.summary : 'No command output captured.';
}
