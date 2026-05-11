import { describe, expect, it } from 'vitest';
import { buildWorkflowContextSummaries } from '../../src/workflow/workflow-context';
import type { PuebloPlanDocument } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';

describe('workflow context', () => {
  it('projects plan and current todo summaries from the active round', () => {
    const summaries = buildWorkflowContextSummaries(createPlanDocument());

    expect(summaries.planSummary).toContain('Goal: Implement workflow context projection');
    expect(summaries.planSummary).toContain('Status: round-active');
    expect(summaries.todoSummary).toContain('Round 1 tasks:');
    expect(summaries.todoSummary).toContain('Wire workflow context into task resolution');
  });
});

function createPlanDocument(): PuebloPlanDocument {
  return {
    workflowId: 'workflow-1',
    workflowType: 'pueblo-plan',
    status: 'round-active',
    routeReason: 'explicit',
    sessionId: 'session-1',
    goal: 'Implement workflow context projection',
    runtimePlanPath: 'D:/tmp/.plans/workflow-1/context.plan.md',
    deliverablePlanPath: null,
    constraints: ['Keep execution state visible.'],
    acceptanceCriteria: [
      'The active plan is injected independently of Pepe ranking.',
      'The current todo round is always available to the model.',
    ],
    tasks: [
      { id: 'task-root', title: 'Deliver workflow context injection', parentId: null, status: 'in-progress' },
      {
        id: 'task-1',
        title: 'Wire workflow context into task resolution',
        parentId: 'task-root',
        status: 'in-progress',
      },
      {
        id: 'task-2',
        title: 'Filter pinned workflow memories from Pepe result items',
        parentId: 'task-root',
        status: 'in-progress',
      },
    ],
    activeRoundNumber: 1,
    rounds: [
      {
        roundNumber: 1,
        taskIds: ['task-1', 'task-2'],
        status: 'active',
        summary: null,
      },
    ],
    executionLog: [],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  };
}