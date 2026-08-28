import { describe, expect, it } from 'vitest';
import { resolveContinuation, buildContinuationPrompt } from '../../src/workflow/workflow-continuation-policy';
import type { WorkflowInstance } from '../../src/shared/schema';

function createWorkflow(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: 'workflow-1',
    type: 'pueblo-plan',
    status: 'round-active',
    sessionId: 'session-1',
    agentInstanceId: null,
    goal: 'Ship the feature',
    targetDirectory: null,
    runtimePlanPath: '/tmp/runtime.plan.md',
    deliverablePlanPath: null,
    activePlanMemoryId: null,
    activeTodoMemoryId: null,
    activeRoundNumber: 2,
    emptyOutputStrikes: 0,
    roundStartedAt: null,
    blockedAt: null,
    pausedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('workflow continuation policy', () => {
  it('abandon on /workflow-cancel', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: '/workflow-cancel', defaultAction: 'ask' });
    expect(result.decision).toBe('abandon');
  });

  it('abandon on "stop workflow" phrase', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: 'stop workflow now', defaultAction: 'ask' });
    expect(result.decision).toBe('abandon');
  });

  it('interrupt-and-run with the bang prefix stripped', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: '!check the weather', defaultAction: 'ask' });
    expect(result.decision).toBe('interrupt-and-run');
    expect(result.normalizedInput).toBe('check the weather');
  });

  it('interrupt-and-run with /workflow-pause prefix', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: '/workflow-pause run the tests', defaultAction: 'ask' });
    expect(result.decision).toBe('interrupt-and-run');
    expect(result.normalizedInput).toBe('run the tests');
  });

  it('continues by default for plain text under the ask policy', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: 'keep going on round 2', defaultAction: 'ask' });
    expect(result.decision).toBe('continue');
    expect(result.normalizedInput).toBe('keep going on round 2');
  });

  it('pause policy routes plain text to interrupt-and-run', () => {
    const result = resolveContinuation({ workflow: createWorkflow(), input: 'do something unrelated', defaultAction: 'pause' });
    expect(result.decision).toBe('interrupt-and-run');
  });

  it('buildContinuationPrompt includes status and round', () => {
    const prompt = buildContinuationPrompt(createWorkflow());
    expect(prompt).toContain('round-active');
    expect(prompt).toContain('Active round: 2');
    expect(prompt).toContain('/workflow-continue');
  });
});
