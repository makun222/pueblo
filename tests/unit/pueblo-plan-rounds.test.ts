import { describe, expect, it } from 'vitest';
import type { PuebloPlanDocument } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
import { applyTodoRound, selectNextTodoRound } from '../../src/workflow/pueblo-plan/pueblo-plan-rounds';

describe('pueblo plan rounds', () => {
  it('selects no more than 10 pending leaf tasks for a round', () => {
    const plan = createPlanWithLeafTasks(12);

    const round = selectNextTodoRound(plan);

    expect(round).not.toBeNull();
    expect(round?.taskIds).toHaveLength(10);
    expect(round?.roundNumber).toBe(1);
  });

  it('marks selected tasks as in-progress when a round becomes active', () => {
    const plan = createPlanWithLeafTasks(3);
    const round = selectNextTodoRound(plan);
    if (!round) {
      throw new Error('Expected a round to be selected');
    }

    const updated = applyTodoRound(plan, round);

    expect(updated.activeRoundNumber).toBe(1);
    expect(updated.rounds).toHaveLength(1);
    expect(updated.tasks.filter((task) => round.taskIds.includes(task.id)).every((task) => task.status === 'in-progress')).toBe(true);
  });
});

function createPlanWithLeafTasks(count: number): PuebloPlanDocument {
  return {
    workflowId: 'workflow-1',
    workflowType: 'pueblo-plan',
    status: 'planning',
    routeReason: 'explicit',
    sessionId: 'session-1',
    goal: 'Test round selection',
    runtimePlanPath: 'D:/tmp/.plans/workflow-1/test.plan.md',
    deliverablePlanPath: null,
    constraints: [],
    acceptanceCriteria: [],
    tasks: [
      { id: 'task-root', title: 'Root', parentId: null, status: 'pending' },
      ...Array.from({ length: count }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        parentId: 'task-root',
        status: 'pending' as const,
      })),
    ],
    activeRoundNumber: null,
    rounds: [],
    executionLog: [],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  };
}
