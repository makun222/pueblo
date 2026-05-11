import { describe, expect, it } from 'vitest';
import { createWorkflowInstanceModel } from '../../src/workflow/workflow-model';
import { createInitialPuebloPlanOutline } from '../../src/workflow/pueblo-plan/pueblo-plan-planner';
import { createInitialPuebloPlanDocument, parsePuebloPlanMarkdown, renderPuebloPlanMarkdown } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
import { applyTodoRound, selectNextTodoRound } from '../../src/workflow/pueblo-plan/pueblo-plan-rounds';

describe('pueblo plan markdown', () => {
  it('renders and parses a structured plan document round-trip', () => {
    const workflow = createWorkflowInstanceModel({
      type: 'pueblo-plan',
      goal: 'Implement the workflow planner',
      runtimePlanPath: 'D:/tmp/.plans/workflow-1/implement-the-workflow-planner.plan.md',
      deliverablePlanPath: 'D:/tmp/implement-the-workflow-planner.plan.md',
      sessionId: 'session-1',
      agentInstanceId: 'agent-1',
    });
    const outline = createInitialPuebloPlanOutline({ goal: workflow.goal });
    const initialPlan = createInitialPuebloPlanDocument({
      workflow,
      routeReason: 'explicit',
      sessionId: 'session-1',
      outline,
    });
    const round = selectNextTodoRound(initialPlan);
    const hydratedPlan = round ? applyTodoRound(initialPlan, round) : initialPlan;

    const markdown = renderPuebloPlanMarkdown(hydratedPlan);
    const parsed = parsePuebloPlanMarkdown(markdown);

    expect(markdown).toContain('# Plan: Implement the workflow planner');
    expect(markdown).toContain('## Task Tree');
    expect(markdown).toContain('## Current Round');
    expect(markdown).toContain('Active Round: 1');
    expect(markdown).toContain('```pueblo-plan-state');
    expect(parsed.goal).toBe('Implement the workflow planner');
    expect(parsed.activeRoundNumber).toBe(1);
    expect(parsed.rounds).toHaveLength(1);
    expect(parsed.tasks.some((task) => task.status === 'in-progress')).toBe(true);
  });
});
