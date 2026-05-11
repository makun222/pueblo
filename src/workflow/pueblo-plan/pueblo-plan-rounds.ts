import type { PuebloPlanDocument, PuebloPlanRound, PuebloPlanTask } from './pueblo-plan-markdown';

export function selectNextTodoRound(plan: PuebloPlanDocument, maxTasks = 10): PuebloPlanRound | null {
  const nextTasks = getSelectableTasks(plan).slice(0, maxTasks);
  if (nextTasks.length === 0) {
    return null;
  }

  const roundNumber = (plan.rounds.at(-1)?.roundNumber ?? 0) + 1;
  return {
    roundNumber,
    taskIds: nextTasks.map((task) => task.id),
    status: 'active',
    summary: null,
  };
}

export function applyTodoRound(plan: PuebloPlanDocument, round: PuebloPlanRound): PuebloPlanDocument {
  const roundTaskIds = new Set(round.taskIds);
  const updatedAt = new Date().toISOString();

  return {
    ...plan,
    activeRoundNumber: round.roundNumber,
    updatedAt,
    rounds: [...plan.rounds, round],
    tasks: plan.tasks.map((task) => {
      if (!roundTaskIds.has(task.id) || task.status === 'completed') {
        return task;
      }

      return {
        ...task,
        status: 'in-progress',
      };
    }),
    executionLog: [
      ...plan.executionLog,
      `${updatedAt}: Activated round ${round.roundNumber} with tasks ${round.taskIds.join(', ')}.`,
    ],
  };
}

function getSelectableTasks(plan: PuebloPlanDocument): PuebloPlanTask[] {
  const parentIds = new Set(plan.tasks.flatMap((task) => (task.parentId ? [task.parentId] : [])));

  return plan.tasks.filter((task) => !parentIds.has(task.id) && task.status === 'pending');
}
