import { ToolInvocationRepository } from './tool-invocation-repository';
import { createExecTool } from './exec-tool';
import { createGlobTool, type ToolExecutionResult } from './glob-tool';
import { createGrepTool } from './grep-tool';
import type { ProviderToolDefinition, ProviderToolName } from '../providers/provider-adapter';

export interface ToolServiceDependencies {
  readonly repository: ToolInvocationRepository;
  readonly cwd: string;
}

export interface ExecuteToolInput {
  readonly taskId: string;
  readonly toolName: ProviderToolName;
  readonly args: Record<string, unknown>;
  readonly inputSummary?: string;
}

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
        inputSchema: { pattern: 'string' },
      },
      {
        name: 'grep',
        description: 'Search repository files by regex pattern and optional include glob.',
        inputSchema: { pattern: 'string', include: 'string?' },
      },
      {
        name: 'exec',
        description: 'Run a local executable command without a shell using the workspace as cwd.',
        inputSchema: { command: 'string' },
      },
    ];
  }

  async execute(input: ExecuteToolInput): Promise<{ invocation: ReturnType<ToolInvocationRepository['create']>; output: ToolExecutionResult }> {
    const output = await this.executeTool(input.toolName, input.args);
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

  private async executeTool(toolName: ProviderToolName, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    switch (toolName) {
      case 'glob':
        return this.runGlob(args);
      case 'grep':
        return this.runGrep(args);
      case 'exec':
        return this.runExec(args);
      default:
        return {
          toolName,
          status: 'failed',
          summary: `Unsupported tool: ${toolName}`,
          output: [],
        };
    }
  }

  private runGlob(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';

    if (!pattern) {
      return Promise.resolve({
        toolName: 'glob',
        status: 'failed',
        summary: 'Glob pattern is required',
        output: [],
      });
    }

    return this.globTool({ pattern, cwd: this.dependencies.cwd });
  }

  private runGrep(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    const include = typeof args.include === 'string' ? args.include.trim() : undefined;

    if (!pattern) {
      return Promise.resolve({
        toolName: 'grep',
        status: 'failed',
        summary: 'Grep pattern is required',
        output: [],
      });
    }

    return this.grepTool({ pattern, include, cwd: this.dependencies.cwd });
  }

  private runExec(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';

    if (!command) {
      return Promise.resolve({
        toolName: 'exec',
        status: 'failed',
        summary: 'Exec command is required',
        output: [],
      });
    }

    return this.execTool({ command, cwd: this.dependencies.cwd });
  }
}
