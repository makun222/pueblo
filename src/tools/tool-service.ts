import { ToolInvocationRepository } from './tool-invocation-repository';
import { buildEditApprovalPreview, createEditTool } from './edit-tool';
import { createExecTool } from './exec-tool';
import { createGlobTool, type ToolExecutionResult } from './glob-tool';
import { createGrepTool } from './grep-tool';
import { createReadTool } from './read-tool';
import {
  getToolExecutionPolicy,
  providerEditToolInputSchema,
  providerExecToolInputSchema,
  providerGlobToolInputSchema,
  providerGrepToolInputSchema,
  providerReadToolInputSchema,
  parseProviderToolArgs,
  type ProviderEditToolArgs,
  type ProviderExecToolArgs,
  type ProviderGlobToolArgs,
  type ProviderGrepToolArgs,
  type ProviderReadToolArgs,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderToolName,
} from '../providers/provider-adapter';

export interface ToolServiceDependencies {
  readonly repository: ToolInvocationRepository;
  readonly cwd: string;
}

export interface ExecuteToolInput {
  readonly taskId: string;
  readonly inputSummary?: string;
  readonly executionCwd?: string;
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
      readonly toolName: 'read';
      readonly args: ProviderReadToolArgs;
    })
  | (ExecuteToolInput & {
      readonly toolName: 'edit';
      readonly args: ProviderEditToolArgs;
    });

export class ToolService {
  private readonly editTool = createEditTool();
  private readonly globTool = createGlobTool();
  private readonly grepTool = createGrepTool();
  private readonly execTool = createExecTool();
  private readonly readTool = createReadTool();

  constructor(private readonly dependencies: ToolServiceDependencies) {}

  getDefaultExecutionCwd(): string {
    return this.dependencies.cwd;
  }

  async runAll(taskId: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    return this.runForTask(taskId, 'inspect workflow with tools');
  }

  describeTools(): ProviderToolDefinition[] {
    return [
      {
        name: 'glob',
        description: 'Match repository paths by glob pattern relative to the current task root. When a target directory is provided for the task, use that as the root; otherwise use the workspace root.',
        inputSchema: providerGlobToolInputSchema,
        executionPolicy: getToolExecutionPolicy('glob'),
      },
      {
        name: 'grep',
        description: 'Search repository files by regex pattern and optional include glob under the current task root. When a target directory is provided for the task, use that as the root; otherwise use the workspace root.',
        inputSchema: providerGrepToolInputSchema,
        executionPolicy: getToolExecutionPolicy('grep'),
      },
      {
        name: 'exec',
        description: 'Run a local executable command without a shell using the current task root as cwd. When a target directory is provided for the task, use that as cwd; otherwise use the workspace root. Requires user approval before execution.',
        inputSchema: providerExecToolInputSchema,
        executionPolicy: getToolExecutionPolicy('exec'),
      },
      {
        name: 'read',
        description: 'Read a text file by relative path or absolute path within the current task root and return numbered lines with bounded output. When a target directory is provided for the task, use that as the root; otherwise use the workspace root.',
        inputSchema: providerReadToolInputSchema,
        executionPolicy: getToolExecutionPolicy('read'),
      },
      {
        name: 'edit',
        description: 'Edit a text file within the current task root by replacing one exact text match, optionally constrained to a line range. When a target directory is provided for the task, use that as the root; otherwise use the workspace root. Requires user approval before execution.',
        inputSchema: providerEditToolInputSchema,
        executionPolicy: getToolExecutionPolicy('edit'),
      },
    ];
  }

  async execute(input: ExecuteToolRequest): Promise<{ invocation: ReturnType<ToolInvocationRepository['create']>; output: ToolExecutionResult }> {
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
            `Workspace: ${this.dependencies.cwd}`,
          ].join('\n'),
        };
      case 'edit':
        return buildEditApprovalPreview({
          cwd: this.dependencies.cwd,
          path: input.args.path,
          oldText: input.args.oldText,
          newText: input.args.newText,
          startLine: input.args.startLine,
          endLine: input.args.endLine,
        });
      case 'glob':
      case 'grep':
      case 'read':
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
    const executionCwd = input.executionCwd ?? this.dependencies.cwd;

    switch (input.toolName) {
      case 'glob':
        return this.runGlob(parseProviderToolArgs('glob', input.args), executionCwd);
      case 'grep':
        return this.runGrep(parseProviderToolArgs('grep', input.args), executionCwd);
      case 'exec':
        return this.runExec(parseProviderToolArgs('exec', input.args), executionCwd);
      case 'read':
        return this.runRead(parseProviderToolArgs('read', input.args), executionCwd);
      case 'edit':
        return this.runEdit(parseProviderToolArgs('edit', input.args), executionCwd);
    }
  }

  private runGlob(args: ProviderGlobToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.globTool({ pattern: args.pattern, cwd: executionCwd });
  }

  private runGrep(args: ProviderGrepToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.grepTool({ pattern: args.pattern, include: args.include, cwd: executionCwd });
  }

  private runExec(args: ProviderExecToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.execTool({ command: args.command, cwd: executionCwd });
  }

  private runRead(args: ProviderReadToolArgs, executionCwd: string): Promise<ToolExecutionResult> {
    return this.readTool({ path: args.path, cwd: executionCwd });
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
}
