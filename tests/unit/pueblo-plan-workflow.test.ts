import { describe, expect, it } from 'vitest';
import type { PuebloPlanDocument } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
import { advancePuebloPlanAfterRound } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';

describe('pueblo plan workflow', () => {
  it('completes the active round and finishes the workflow when no pending tasks remain', () => {
    const plan = createPlan({
      leafTaskCount: 3,
      activeTaskIds: ['task-1', 'task-2', 'task-3'],
    });

    const result = advancePuebloPlanAfterRound(plan, 'Round finished successfully.');

    expect(result.completedRound?.status).toBe('completed');
    expect(result.completedRound?.summary).toBe('Round finished successfully.');
    expect(result.nextRound).toBeNull();
    expect(result.plan.status).toBe('completed');
    expect(result.plan.activeRoundNumber).toBeNull();
    expect(result.plan.tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('activates the next round when pending leaf tasks remain', () => {
    const plan = createPlan({
      leafTaskCount: 12,
      activeTaskIds: Array.from({ length: 10 }, (_, index) => `task-${index + 1}`),
    });

    const result = advancePuebloPlanAfterRound(plan, 'Round one complete.');

    expect(result.completedRound?.roundNumber).toBe(1);
    expect(result.nextRound?.roundNumber).toBe(2);
    expect(result.nextRound?.taskIds).toEqual(['task-11', 'task-12']);
    expect(result.plan.status).toBe('round-active');
    expect(result.plan.activeRoundNumber).toBe(2);
    expect(result.plan.tasks.find((task) => task.id === 'task-11')?.status).toBe('in-progress');
    expect(result.plan.tasks.find((task) => task.id === 'task-12')?.status).toBe('in-progress');
  });
});

function createPlan(args: { readonly leafTaskCount: number; readonly activeTaskIds: string[] }): PuebloPlanDocument {
  return {
    workflowId: 'workflow-1',
    workflowType: 'pueblo-plan',
    status: 'round-active',
    routeReason: 'explicit',
    sessionId: 'session-1',
    goal: 'Advance the workflow',
    runtimePlanPath: 'D:/tmp/.plans/workflow-1/advance.plan.md',
    deliverablePlanPath: null,
    constraints: [],
    acceptanceCriteria: [],
    tasks: [
      { id: 'task-root', title: 'Root task', parentId: null, status: 'in-progress' },
      ...Array.from({ length: args.leafTaskCount }, (_, index) => {
        const taskId = `task-${index + 1}`;
        return {
          id: taskId,
          title: `Task ${index + 1}`,
          parentId: 'task-root',
          status: args.activeTaskIds.includes(taskId) ? 'in-progress' as const : 'pending' as const,
        };
      }),
    ],
    activeRoundNumber: 1,
    rounds: [
      {
        roundNumber: 1,
        taskIds: args.activeTaskIds,
        status: 'active',
        summary: null,
      },
    ],
    executionLog: [],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  };
}