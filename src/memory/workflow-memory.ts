import type { WorkflowInstance, WorkflowType } from '../shared/schema';
import type { PuebloPlanRound, PuebloPlanTask } from '../workflow/pueblo-plan/pueblo-plan-markdown';

export function buildWorkflowPlanMemoryTitle(workflow: WorkflowInstance): string {
  return `Plan: ${workflow.goal.length <= 60 ? workflow.goal : `${workflow.goal.slice(0, 57)}...`}`;
}

export function buildWorkflowPlanMemoryContent(workflow: WorkflowInstance): string {
  return [
    `workflowId: ${workflow.id}`,
    `workflowType: ${workflow.type}`,
    `status: ${workflow.status}`,
    `runtimePlanPath: ${workflow.runtimePlanPath}`,
    `deliverablePlanPath: ${workflow.deliverablePlanPath ?? 'pending'}`,
    `activeRoundNumber: ${workflow.activeRoundNumber ?? 'none'}`,
  ].join('\n');
}

export function buildWorkflowPlanMemoryTags(workflowType: WorkflowType): string[] {
  return ['workflow', 'plan', `workflow:${workflowType}`];
}

export function buildWorkflowTodoMemoryTitle(args: {
  readonly workflow: WorkflowInstance;
  readonly round: PuebloPlanRound;
}): string {
  return `Todo Round ${args.round.roundNumber}: ${workflowGoalPreview(args.workflow.goal)}`;
}

export function buildWorkflowTodoMemoryContent(args: {
  readonly workflow: WorkflowInstance;
  readonly round: PuebloPlanRound;
  readonly tasks: PuebloPlanTask[];
}): string {
  return [
    `workflowId: ${args.workflow.id}`,
    `workflowType: ${args.workflow.type}`,
    `roundNumber: ${args.round.roundNumber}`,
    'tasks:',
    ...args.tasks.map((task) => `- ${task.id}: ${task.title}`),
  ].join('\n');
}

export function buildWorkflowTodoMemoryTags(workflowType: WorkflowType): string[] {
  return ['workflow', 'todo', `workflow:${workflowType}`];
}

function workflowGoalPreview(goal: string): string {
  return goal.length <= 48 ? goal : `${goal.slice(0, 45)}...`;
}
