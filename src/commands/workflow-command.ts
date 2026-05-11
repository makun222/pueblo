import { failureResult, type CommandResult } from '../shared/result';
import type { WorkflowType } from '../shared/schema';

export interface WorkflowCommandDependencies {
  readonly startWorkflow: (goal: string, workflowType?: WorkflowType) => Promise<CommandResult<unknown>> | CommandResult<unknown>;
  readonly defaultWorkflowType: WorkflowType;
}

export function createWorkflowStartCommand(dependencies: WorkflowCommandDependencies) {
  return async (args: string[]): Promise<CommandResult<unknown>> => {
    const [firstArg, ...remainingArgs] = args;
    const maybeWorkflowType = firstArg === dependencies.defaultWorkflowType ? firstArg : null;
    const goal = maybeWorkflowType ? remainingArgs.join(' ').trim() : args.join(' ').trim();

    if (!goal) {
      return failureResult('WORKFLOW_GOAL_REQUIRED', 'Workflow goal is required', [
        'Use /workflow <goal> or /workflow pueblo-plan <goal>.',
      ]);
    }

    return dependencies.startWorkflow(goal, maybeWorkflowType ?? dependencies.defaultWorkflowType);
  };
}
