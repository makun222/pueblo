import type { WorkflowContext } from '../shared/schema';
import type { PuebloPlanDocument } from './pueblo-plan/pueblo-plan-markdown';

export function buildWorkflowContextSummaries(plan: PuebloPlanDocument): Pick<WorkflowContext, 'planSummary' | 'todoSummary'> {
  const currentRound = plan.rounds.find((round) => round.roundNumber === plan.activeRoundNumber) ?? null;
  const currentTasks = currentRound
    ? plan.tasks.filter((task) => currentRound.taskIds.includes(task.id))
    : [];

  return {
    planSummary: [
      `Goal: ${plan.goal}`,
      `Status: ${plan.status}`,
      ...plan.acceptanceCriteria.slice(0, 2).map((criterion) => `Acceptance: ${criterion}`),
    ].join('\n'),
    todoSummary: currentRound
      ? [
        `Round ${currentRound.roundNumber} tasks:`,
        ...currentTasks.map((task) => `- ${task.title}`),
      ].join('\n')
      : null,
  };
}
