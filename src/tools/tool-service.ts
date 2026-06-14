import { ToolInvocationRepository } from './tool-invocation-repository';
import { buildEditApprovalPreview, createEditTool, type EditReviewHandler } from './edit-tool';
import { createExecTool } from './exec-tool';
import { createGlobTool, type ToolExecutionResult } from './glob-tool';
import { createGrepTool } from './grep-tool';
import { createReadTool } from './read-tool';
import { createShellExecTool } from './shell-exec-tool';
import { createWriteTool, type WriteToolRequest } from './write-tool';
import { createUndoEditTool, type UndoEditToolRequest } from './undo-edit-tool';
import { MemoRecallTool, type MemoRecallRequest } from './memo-recall-tool';
import type { MemoryQueries } from '../memory/memory-queries';
import {
  getToolExecutionPolicy,
  providerEditToolInputSchema,
  providerExecToolInputSchema,
  providerGlobToolInputSchema,
  providerGrepToolInputSchema,
  providerReadToolInputSchema,
  providerShellExecToolInputSchema,
  providerWriteToolInputSchema,
  parseProviderToolArgs,
  type ProviderEditToolArgs,
  type ProviderExecToolArgs,
  type ProviderGlobToolArgs,
  type ProviderGrepToolArgs,
  type ProviderReadToolArgs,
  type ProviderShellExecToolArgs,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderToolName,
  type ProviderWriteToolArgs,
  type ProviderUndoEditToolArgs,
  type ProviderMemoRecallToolArgs,
  providerUndoEditToolArgsSchema,
  providerUndoEditToolInputSchema,
  providerMemoRecallToolInputSchema,
} from '../providers/provider-adapter';
import { throwIfTaskCancelled } from '../shared/task-cancellation';

export interface ToolServiceDependencies {
  readonly repository: ToolInvocationRepository;
  readonly cwd: string | (() => string);
  readonly resolveEditReviewHandler?: () => EditReviewHandler | null;
  readonly editShadowRoot?: string | (() => string);
  readonly memoRecallTool?: MemoRecallTool;
}

export interface ExecuteToolInput {
  readonly taskId: string;
  readonly inputSummary?: string;
  readonly executionCwd?: string;
  readonly signal?: AbortSignal;
}

export interface ToolApprovalDescription {
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
}

export type ExecuteToolRequest =
  | (ExecuteToolInput & {
      readonly toolName: 'glob';
      readonly args: ProviderGlobToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'grep';
      readonly args: ProviderGrepToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'exec';
      readonly args: ProviderExecToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'shell_exec';
      readonly args: ProviderShellExecToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'read';
      readonly args: ProviderReadToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'edit';
      readonly args: ProviderEditToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'write';
      readonly args: ProviderWriteToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'undo_edit';
      readonly args: ProviderUndoEditToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'memo_recall';
      readonly args: ProviderMemoRecallToolArgs;
    });

export class ToolService {
  private readonly editTool: ReturnType<typeof createEditTool>;
  private readonly globTool = createGlobTool();
  private readonly grepTool = createGrepTool();
  private readonly execTool = createExecTool();
  private readonly shellExecTool = createShellExecTool();
  private readonly readTool = createReadTool();
  private readonly writeTool = createWriteTool();
  private readonly undoEditTool = createUndoEditTool();
  private readonly memoRecallTool?: MemoRecallTool;

  constructor(private readonly dependencies: ToolServiceDependencies) {
    this.memoRecallTool = dependencies.memoRecallTool;
    this.editTool = createEditTool({
      getReviewHandler: () => this.dependencies.resolveEditReviewHandler?.() ?? null,
      shadowRoot: this.dependencies.editShadowRoot,
    });
  }

  getDefaultExecutionCwd(): string {
    return this.resolveDefaultExecutionCwd();
  }

  async runAll(taskId: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    return this.runForTask(taskId, 'inspect workflow with tools');
  }

  describeTools(): ProviderToolDefinition[] {
    const taskRootExplanation = 'The task root is the task target directory when one is set; otherwise it is the workspace root.';

    return [
      {
        name: 'glob',
        description: `Match repository paths by glob pattern relative to the current task root. ${taskRootExplanation}`,
        inputSchema: providerGlobToolInputSchema,
        executionPolicy: getToolExecutionPolicy('glob'),
      },
      {
        name: 'grep',
        description: `Search repository files by regex pattern and optional include glob under the current task root. ${taskRootExplanation}`,
        inputSchema: providerGrepToolInputSchema,
        executionPolicy: getToolExecutionPolicy('grep'),
      },
      {
        name: 'exec',
        description: `Run a local executable command without a shell using the current task root as cwd. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerExecToolInputSchema,
        executionPolicy: getToolExecutionPolicy('exec'),
      },
      {
        name: 'shell_exec',
        description: `Run a shell command string using cmd or powershell with the current task root as cwd. Use this when shell features like pipes, redirection, built-in commands, or shell-specific syntax are required. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerShellExecToolInputSchema,
        executionPolicy: getToolExecutionPolicy('shell_exec'),
      },
      {
        name: 'read',
        description: `Read a text file by relative path or absolute path within the current task root and return numbered lines with bounded output. Optionally provide startLine and endLine to read a specific range. ${taskRootExplanation}`,
        inputSchema: providerReadToolInputSchema,
        executionPolicy: getToolExecutionPolicy('read'),
      },
      {
        name: 'edit',
        description: `Edit a text file within the current task root by replacing one exact text match, optionally constrained to a line range. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerEditToolInputSchema,
        executionPolicy: getToolExecutionPolicy('edit'),
      },
      {
        name: 'write',
        description: `Writes content to a file within the current task root, creating or overwriting it. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerWriteToolInputSchema,
        executionPolicy: getToolExecutionPolicy('write'),
      },
      {
        name: 'undo_edit',
        description: `Reverts a previous edit or write operation on a file. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerUndoEditToolInputSchema,
        executionPolicy: getToolExecutionPolicy('undo_edit'),
      },
      {
        name: 'memo_recall' as const,
        description:
          'Search memory notes stored during this session by keyword. ' +
          'Use this when you have doubts about earlier decisions, constraints, ' +
          'or context that may have been lost due to conversation truncation. ' +
          'Returns matching notes with their turn numbers and relevance scores.',
        inputSchema: providerMemoRecallToolInputSchema,
        executionPolicy: getToolExecutionPolicy('memo_recall'),
      },
    ];
  }

  async execute(input: ExecuteToolRequest): Promise<{ invocation: ReturnType<ToolInvocationRepository['create']>; output: ToolExecutionResult }> {
    throwIfTaskCancelled(input.signal, 'Task cancelled before running the requested tool.');
    const output = await this.executeTool(input);
    const invocation = this.recordInvocation({
      toolName: output.toolName,
      taskId: input.taskId,
      inputSummary: input.inputSummary ?? JSON.stringify(input.args),
      resultStatus: output.status,
      resultSummary: output.summary,
    });

    return { invocation, output };
  }

  recordInvocation(input: {
    readonly toolName: ProviderToolName;
    readonly taskId: string;
    readonly inputSummary: string;
    readonly resultStatus: ToolExecutionResult['status'];
    readonly resultSummary: string;
  }): ReturnType<ToolInvocationRepository['create']> {
    const invocation = this.dependencies.repository.create({
      toolName: input.toolName,
      taskId: input.taskId,
      inputSummary: input.inputSummary,
      resultStatus: input.resultStatus,
      resultSummary: input.resultSummary,
    });

    return invocation;
  }

  describeApproval(input: ProviderToolCall): ToolApprovalDescription {
    switch (input.toolName) {
      case 'exec':
        return {
          title: 'Allow command execution in the workspace?',
          summary: `Command: ${input.args.command}`,
          detail: [
            `Command: ${input.args.command}`,
            `Workspace: ${this.resolveDefaultExecutionCwd()}`,
          ].join('\n'),
        };
      case 'shell_exec':
        return {
          title: `Allow ${input.args.mode} shell execution in the workspace?`,
          summary: `${input.args.mode}: ${input.args.command}`,
          detail: [
            `Mode: ${input.args.mode}`,
            `Command: ${input.args.command}`,
            `Workspace: ${this.resolveDefaultExecutionCwd()}`,
          ].join('\n'),
        };
      case 'edit':
        return buildEditApprovalPreview({
          cwd: this.resolveDefaultExecutionCwd(),
          path: input.args.path,
          oldText: input.args.oldText,
          newText: input.args.newText,
          startLine: input.args.startLine,
          endLine: input.args.endLine,
        });
      case 'write':
        return {
          title: 'Allow file write in the workspace?',
          summary: `write: ${input.args.path}`,
          detail: JSON.stringify(input.args, null, 2),
        };
      case 'glob':
      case 'memo_recall':
      case 'grep':
      case 'read':
      case 'undo_edit':
        return {
          title: `Allow ${input.toolName} to run?`,
          summary: `${input.toolName}: ${JSON.stringify(input.args)}`,
          detail: JSON.stringify(input.args, null, 2),
        };
    }
  }

  async runForTask(taskId: string, goal: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    const outputs = await this.executeSelectedTools(goal, taskId);

    return {
      invocations: this.dependencies.repository.listByTask(taskId),
      outputs,
    };
  }

  private async executeSelectedTools(goal: string, taskId: string): Promise<ToolExecutionResult[]> {
    const normalizedGoal = goal.toLowerCase();
    const shouldSearchFiles = /inspect|search|find|locate|workflow|repo|repository|bug|file|path|tool/.test(normalizedGoal);
    const shouldExecuteCommand = /exec|execute|run|command|version|build|test|tool/.test(normalizedGoal);
    const outputs: ToolExecutionResult[] = [];

    if (shouldSearchFiles) {
      outputs.push((await this.execute({
        taskId,
        toolName: 'glob',
        args: { pattern: 'src/**/*.ts' },
        inputSummary: goal,
      })).output);
      outputs.push((await this.execute({
        taskId,
        toolName: 'grep',
        args: { pattern: 'create|session|prompt|memory|tool', include: '*.ts' },
        inputSummary: goal,
      })).output);
    }

    if (shouldExecuteCommand) {
      outputs.push((await this.execute({
        taskId,
        toolName: 'exec',
        args: { command: 'node -v' },
        inputSummary: goal,
      })).output);
    }

    return outputs;
  }

  private async executeTool(input: ExecuteToolRequest): Promise<ToolExecutionResult> {
    const executionCwd = input.executionCwd ?? this.resolveDefaultExecutionCwd();

    switch (input.toolName) {
      case 'glob':
        return this.runGlob(parseProviderToolArgs('glob', input.args), executionCwd);
      case 'grep':
        return this.runGrep(parseProviderToolArgs('grep', input.args), executionCwd);
      case 'exec':
        return this.runExec(parseProviderToolArgs('exec', input.args), executionCwd, input.signal);
      case 'shell_exec':
        return this.runShellExec(parseProviderToolArgs('shell_exec', input.args), executionCwd, input.signal);
      case 'read':
        return this.runRead(parseProviderToolArgs('read', input.args), executionCwd);
      case 'edit':
        return this.runEdit(parseProviderToolArgs('edit', input.args), executionCwd);
      case 'write':
        return this.runWrite(parseProviderToolArgs('write', input.args), executionCwd);
      case 'undo_edit':
        return this.runUndoEdit(parseProviderToolArgs('undo_edit', input.args), executionCwd);
      case 'memo_recall':
        return this.runMemoRecall(parseProviderToolArgs('memo_recall', input.args));
    }
  }

  private resolveDefaultExecutionCwd(): string {
    return typeof this.dependencies.cwd === 'function'
      ? this.dependencies.cwd()
      : this.dependencies.cwd;
  }

  private runGlob(args: ProviderGlobToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.globTool({ pattern: args.pattern, cwd: executionCwd });
  }

  private runGrep(args: ProviderGrepToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.grepTool({ pattern: args.pattern, include: args.include, cwd: executionCwd });
  }

  private runExec(args: ProviderExecToolArgs, executionCwd: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
    return this.execTool({ command: args.command, cwd: executionCwd, signal });
  }

  private runShellExec(args: ProviderShellExecToolArgs, executionCwd: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
    return this.shellExecTool({ mode: args.mode, command: args.command, cwd: executionCwd, signal });
  }

  private runRead(args: ProviderReadToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.readTool({
      path: args.path,
      startLine: args.startLine,
      endLine: args.endLine,
      cwd: executionCwd,
    });
  }

  private runEdit(args: ProviderEditToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.editTool({
      path: args.path,
      oldText: args.oldText,
      newText: args.newText,
      startLine: args.startLine,
      endLine: args.endLine,
      cwd: executionCwd,
    });
  }

  private runWrite(args: ProviderWriteToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.writeTool({
      path: args.path,
      text: args.text,
      cwd: executionCwd,
    });
  }

  private runUndoEdit(args: ProviderUndoEditToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.undoEditTool({
      path: args.path,
      cwd: executionCwd,
    });
  }

  private async runMemoRecall(
    args: ProviderMemoRecallToolArgs,
  ): Promise<ToolExecutionResult> {
    if (!this.memoRecallTool) {
      return {
        toolName: 'memo_recall',
        status: 'failed',
        output: ['MemoRecallTool is not initialized'],
        summary: 'memo-recall unavailable: MemoRecallTool not provided in ToolServiceDependencies',
      };
    }
    const response = await this.memoRecallTool.execute({
      keyword: args.keyword,
      turn_count: args.turnCount,
      mode: (args.matchMode ?? 'fuzzy') as MemoRecallRequest['mode'],
    });
    return {
      toolName: 'memo_recall',
      status: 'succeeded',
      output: [JSON.stringify(response)],
      summary: `memo_recall found ${response.hits.length} hit(s) for '${args.keyword}'`,
    };
  }
}
