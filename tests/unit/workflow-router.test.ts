import { describe, expect, it } from 'vitest';
import { WorkflowRegistry } from '../../src/workflow/workflow-registry';
import { WorkflowRouter } from '../../src/workflow/workflow-router';
import { PUEBLO_PLAN_WORKFLOW_TYPE } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';
import { createTestAppConfig } from '../helpers/test-config';

describe('workflow router', () => {
  function createRouter() {
    const config = createTestAppConfig();
    const registry = new WorkflowRegistry([
      {
        type: PUEBLO_PLAN_WORKFLOW_TYPE,
        description: 'Structured workflow',
      },
    ]);

    return new WorkflowRouter(config, registry);
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

  it('routes keyword-matched plain text to workflow handoff', () => {
    const router = createRouter();

    const decision = router.decide({
      input: 'Please create a workflow plan.md for this repository change.',
    });

    expect(decision.kind).toBe('handoff');
    if (decision.kind === 'handoff') {
      expect(decision.workflowType).toBe('pueblo-plan');
      expect(decision.reason).toBe('keyword');
      expect(decision.normalizedInput).toContain('workflow');
    }
  });

  it('routes over-budget work to workflow handoff', () => {
    const router = createRouter();

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

    expect(decision).toEqual({
      kind: 'pass-through',
      reason: 'none',
    });
  });
});
