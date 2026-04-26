import { ToolInvocationRepository } from './tool-invocation-repository';
import { createExecTool } from './exec-tool';
import { createGlobTool, type ToolExecutionResult } from './glob-tool';
import { createGrepTool } from './grep-tool';
import {
  providerExecToolInputSchema,
  providerGlobToolInputSchema,
  providerGrepToolInputSchema,
  parseProviderToolArgs,
  type ProviderExecToolArgs,
  type ProviderGlobToolArgs,
  type ProviderGrepToolArgs,
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
    });

export class ToolService {
  private readonly globTool = createGlobTool();
  private readonly grepTool = createGrepTool();
  private readonly execTool = createExecTool();

  constructor(private readonly dependencies: ToolServiceDependencies) {}

  async runAll(taskId: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    return this.runForTask(taskId, 'inspect workflow with tools');

  }

  describeTools(): ProviderToolDefinition[] {
    return [
      {
        name: 'glob',
        description: 'Match repository paths by glob pattern relative to the workspace root.',
        inputSchema: providerGlobToolInputSchema,
      },
      {
        name: 'grep',
        description: 'Search repository files by regex pattern and optional include glob.',
        inputSchema: providerGrepToolInputSchema,
      },
      {
        name: 'exec',
        description: 'Run a local executable command without a shell using the workspace as cwd.',
        inputSchema: providerExecToolInputSchema,
      },
    ];
  }

  async execute(input: ExecuteToolRequest): Promise<{ invocation: ReturnType<ToolInvocationRepository['create']>; output: ToolExecutionResult }> {
    const output = await this.executeTool(input);
    const invocation = this.dependencies.repository.create({
      toolName: output.toolName,
      taskId: input.taskId,
      inputSummary: input.inputSummary ?? JSON.stringify(input.args),
      resultStatus: output.status,
      resultSummary: output.summary,
    });

    return { invocation, output };
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
    switch (input.toolName) {
      case 'glob':
        return this.runGlob(parseProviderToolArgs('glob', input.args));
      case 'grep':
        return this.runGrep(parseProviderToolArgs('grep', input.args));
      case 'exec':
        return this.runExec(parseProviderToolArgs('exec', input.args));
    }
  }

  private runGlob(args: ProviderGlobToolArgs): Promise<ToolExecutionResult> {
    return this.globTool({ pattern: args.pattern, cwd: this.dependencies.cwd });
  }

  private runGrep(args: ProviderGrepToolArgs): Promise<ToolExecutionResult> {
    return this.grepTool({ pattern: args.pattern, include: args.include, cwd: this.dependencies.cwd });
  }

  private runExec(args: ProviderExecToolArgs): Promise<ToolExecutionResult> {
    return this.execTool({ command: args.command, cwd: this.dependencies.cwd });
  }
}
