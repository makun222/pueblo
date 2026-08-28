import { describe, expect, it } from 'vitest';
import { WorkflowRegistry } from '../../src/workflow/workflow-registry';
import { WorkflowRouter } from '../../src/workflow/workflow-router';
import { PUEBLO_PLAN_WORKFLOW_TYPE } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';
import { createTestAppConfig } from '../helpers/test-config';
import type { AppConfig } from '../../src/shared/config';

describe('workflow router', () => {
  function createRouter(overrides: Partial<AppConfig['workflow']> = {}, deps: { hasWorkflowCommand?: () => boolean } = {}) {
    const config = createTestAppConfig({ workflow: overrides });
    const registry = new WorkflowRegistry([
      {
        type: PUEBLO_PLAN_WORKFLOW_TYPE,
        description: 'Structured workflow',
      },
    ]);

    return new WorkflowRouter(config, registry, { hasWorkflowCommand: () => true, ...deps });
  }

  it('routes explicit /workflow input to pueblo-plan handoff', () => {
    const router = createRouter();

    const decision = router.decide({
      input: '/workflow pueblo-plan implement the feature in rounds',
    });

    expect(decision).toEqual({
      kind: 'handoff',
      workflowType: 'pueblo-plan',
      reason: 'explicit',
      normalizedInput: 'implement the feature in rounds',
    });
  });

  it('does not auto-route keyword plain text when autoRoute is disabled (default)', () => {
    const router = createRouter();

    const decision = router.decide({
      input: 'Please create a workflow plan.md for this repository change.',
    });

    expect(decision).toEqual({ kind: 'pass-through', reason: 'none' });
  });

  it('auto-routes keyword plain text only when autoRoute is enabled and keyword matches at sentence start', () => {
    const router = createRouter({
      autoRoute: { enabled: true, routeKeywords: ['start workflow'] },
    });

    const matched = router.decide({ input: 'start workflow onboarding docs' });
    expect(matched.kind).toBe('handoff');
    if (matched.kind === 'handoff') {
      expect(matched.reason).toBe('keyword');
      expect(matched.workflowType).toBe('pueblo-plan');
    }

    const incidental = router.decide({ input: 'help me find my workflow folder' });
    expect(incidental).toEqual({ kind: 'pass-through', reason: 'none' });
  });

  it('does not auto-route over-budget work when autoRoute is disabled', () => {
    const router = createRouter();

    const decision = router.decide({
      input: 'Implement the entire migration and UI overhaul.',
      estimatedSteps: 64,
    });

    expect(decision).toEqual({ kind: 'pass-through', reason: 'none' });
  });

  it('auto-routes over-budget work only when autoRoute is enabled', () => {
    const router = createRouter({ autoRoute: { enabled: true, routeKeywords: [] } });

    const decision = router.decide({
      input: 'Implement the entire migration and UI overhaul.',
      estimatedSteps: 64,
    });

    expect(decision).toEqual({
      kind: 'handoff',
      workflowType: 'pueblo-plan',
      reason: 'step-budget',
      normalizedInput: 'Implement the entire migration and UI overhaul.',
    });
  });

  it('keeps simple plain text on the normal task path', () => {
    const router = createRouter();

    const decision = router.decide({
      input: 'inspect repo',
      estimatedSteps: 8,
    });

    expect(decision).toEqual({ kind: 'pass-through', reason: 'none' });
  });

  it('returns deferred when the /workflow command is not registered', () => {
    const router = createRouter({}, { hasWorkflowCommand: () => false });

    const decision = router.decide({ input: '/workflow do something' });

    expect(decision.kind).toBe('deferred');
  });
});
