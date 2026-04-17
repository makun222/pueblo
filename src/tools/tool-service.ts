import { ToolInvocationRepository } from './tool-invocation-repository';
import { createExecTool } from './exec-tool';
import { createGlobTool, type ToolExecutionResult } from './glob-tool';
import { createGrepTool } from './grep-tool';

export interface ToolServiceDependencies {
  readonly repository: ToolInvocationRepository;
  readonly cwd: string;
}

export class ToolService {
  private readonly globTool = createGlobTool();
  private readonly grepTool = createGrepTool();
  private readonly execTool = createExecTool();

  constructor(private readonly dependencies: ToolServiceDependencies) {}

  async runAll(taskId: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    return this.runForTask(taskId, 'inspect workflow with tools');

  }

  async runForTask(taskId: string, goal: string): Promise<{ invocations: ReturnType<ToolInvocationRepository['listByTask']>; outputs: ToolExecutionResult[] }> {
    const outputs = await this.executeSelectedTools(goal);

    for (const output of outputs) {
      this.dependencies.repository.create({
        toolName: output.toolName,
        taskId,
        inputSummary: goal,
        resultStatus: output.status,
        resultSummary: output.summary,
      });
    }

    return {
      invocations: this.dependencies.repository.listByTask(taskId),
      outputs,
    };
  }

  private async executeSelectedTools(goal: string): Promise<ToolExecutionResult[]> {
    const normalizedGoal = goal.toLowerCase();
    const shouldSearchFiles = /inspect|search|find|locate|workflow|repo|repository|bug|file|path|tool/.test(normalizedGoal);
    const shouldExecuteCommand = /exec|execute|run|command|version|build|test|tool/.test(normalizedGoal);
    const outputs: ToolExecutionResult[] = [];

    if (shouldSearchFiles) {
      outputs.push(await this.globTool({ pattern: 'src/**/*.ts', cwd: this.dependencies.cwd }));
      outputs.push(await this.grepTool({ pattern: 'create|session|prompt|memory|tool', cwd: this.dependencies.cwd, include: '*.ts' }));
    }

    if (shouldExecuteCommand) {
      outputs.push(await this.execTool({ command: 'node -v', cwd: this.dependencies.cwd }));
    }

    return outputs;
  }
}
