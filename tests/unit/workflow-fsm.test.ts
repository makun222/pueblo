import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FSM_CONFIG,
  enterRoundActive,
  evaluateWatchdog,
  isActiveWorkflowState,
  isTerminalWorkflowState,
  markBlocked,
  markCancelled,
  markCompleted,
  markFailed,
  observeTaskOutcome,
  resolveCompletionAfterRound,
} from '../../src/workflow/workflow-fsm';
import type { WorkflowInstance } from '../../src/shared/schema';

function createWorkflow(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: 'workflow-1',
    type: 'pueblo-plan',
    status: 'round-active',
    sessionId: 'session-1',
    agentInstanceId: null,
    goal: 'Test workflow',
    targetDirectory: null,
    runtimePlanPath: '/tmp/runtime.plan.md',
    deliverablePlanPath: null,
    activePlanMemoryId: null,
    activeTodoMemoryId: null,
    activeRoundNumber: 1,
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

const NOW = '2026-01-01T00:10:00.000Z';
const config = DEFAULT_FSM_CONFIG;

describe('workflow fsm', () => {
  it('treats blocked and terminal states as non-active', () => {
    expect(isActiveWorkflowState('round-active')).toBe(true);
    expect(isActiveWorkflowState('blocked')).toBe(false);
    expect(isTerminalWorkflowState('failed')).toBe(true);
    expect(isTerminalWorkflowState('cancelled')).toBe(true);
    expect(isTerminalWorkflowState('completed')).toBe(true);
    expect(isTerminalWorkflowState('blocked')).toBe(false);
  });

  it('enterRoundActive stamps roundStartedAt and clears strikes', () => {
    const workflow = createWorkflow({ emptyOutputStrikes: 3, blockedAt: NOW });
    const next = enterRoundActive(workflow, 2, NOW);

    expect(next.status).toBe('round-active');
    expect(next.activeRoundNumber).toBe(2);
    expect(next.roundStartedAt).toBe(NOW);
    expect(next.blockedAt).toBeNull();
    expect(next.emptyOutputStrikes).toBe(0);
  });

  it('observeTaskOutcome advances strikes on empty output and blocks at the limit', () => {
    const workflow = createWorkflow({ emptyOutputStrikes: 1 });
    const blocked = observeTaskOutcome(workflow, { kind: 'success', hasAssistantOutput: false }, config, NOW);

    expect(blocked.toStatus).toBe('blocked');
    expect(blocked.workflow.status).toBe('blocked');
    expect(blocked.workflow.blockedAt).toBe(NOW);
    expect(blocked.terminal).toBe(false);
  });

  it('observeTaskOutcome resets strikes when assistant output is present', () => {
    const workflow = createWorkflow({ emptyOutputStrikes: 1 });
    const result = observeTaskOutcome(workflow, { kind: 'success', hasAssistantOutput: true }, config, NOW);

    expect(result.workflow.emptyOutputStrikes).toBe(0);
    expect(result.toStatus).toBe('round-active');
  });

  it('observeTaskOutcome records pausedAt on cancellation but stays non-terminal', () => {
    const workflow = createWorkflow();
    const result = observeTaskOutcome(workflow, { kind: 'cancelled', reason: 'user' }, config, NOW);

    expect(result.toStatus).toBe('round-active');
    expect(result.workflow.pausedAt).toBe(NOW);
    expect(result.terminal).toBe(false);
  });

  it('observeTaskOutcome marks failed on a failed outcome', () => {
    const workflow = createWorkflow();
    const result = observeTaskOutcome(workflow, { kind: 'failed', reason: 'boom' }, config, NOW);

    expect(result.toStatus).toBe('failed');
    expect(result.workflow.failedAt).toBe(NOW);
    expect(result.terminal).toBe(true);
    expect(result.workflow.activeTodoMemoryId).toBeNull();
  });

  it('evaluateWatchdog moves round-active to blocked after round timeout', () => {
    const workflow = createWorkflow({
      roundStartedAt: '2026-01-01T00:00:00.000Z',
      status: 'round-active',
    });
    const configWithTinyRound = { ...config, roundTimeoutMs: 60_000 };
    const result = evaluateWatchdog(workflow, configWithTinyRound, NOW);

    expect(result?.toStatus).toBe('blocked');
    expect(result?.workflow.blockedAt).toBe(NOW);
  });

  it('evaluateWatchdog moves blocked to failed after blocked timeout', () => {
    const workflow = createWorkflow({
      status: 'blocked',
      blockedAt: '2026-01-01T00:00:00.000Z',
      roundStartedAt: null,
    });
    const configWithTinyBlocked = { ...config, blockedTimeoutMs: 60_000 };
    const result = evaluateWatchdog(workflow, configWithTinyBlocked, NOW);

    expect(result?.toStatus).toBe('failed');
    expect(result?.terminal).toBe(true);
  });

  it('evaluateWatchdog cancels a paused workflow after pause timeout', () => {
    const workflow = createWorkflow({
      status: 'round-active',
      pausedAt: '2026-01-01T00:00:00.000Z',
    });
    const configWithTinyPause = { ...config, pauseTimeoutMs: 60_000 };
    const result = evaluateWatchdog(workflow, configWithTinyPause, NOW);

    expect(result?.toStatus).toBe('cancelled');
    expect(result?.terminal).toBe(true);
  });

  it('evaluateWatchdog returns null for terminal workflows', () => {
    const workflow = createWorkflow({ status: 'failed', failedAt: NOW });
    expect(evaluateWatchdog(workflow, config, NOW)).toBeNull();
  });

  it('resolveCompletionAfterRound fails when no next round and tasks remain pending', () => {
    const workflow = createWorkflow({ status: 'round-review' });
    const result = resolveCompletionAfterRound(workflow, false, false, NOW);

    expect(result.toStatus).toBe('failed');
    expect(result.terminal).toBe(true);
  });

  it('resolveCompletionAfterRound completes when all tasks are done', () => {
    const workflow = createWorkflow({ status: 'round-review' });
    const result = resolveCompletionAfterRound(workflow, true, false, NOW);

    expect(result.toStatus).toBe('completed');
    expect(result.terminal).toBe(true);
  });

  it('resolveCompletionAfterRound blocks when a task is blocked', () => {
    const workflow = createWorkflow({ status: 'round-review' });
    const result = resolveCompletionAfterRound(workflow, false, true, NOW);

    expect(result.toStatus).toBe('blocked');
    expect(result.terminal).toBe(false);
  });

  it('terminal helpers clear runtime watchdog fields', () => {
    const workflow = createWorkflow({
      roundStartedAt: NOW,
      blockedAt: NOW,
      pausedAt: NOW,
      activeTodoMemoryId: 'todo-1',
    });
    const failed = markFailed(workflow, 'boom', NOW);
    expect(failed.workflow.roundStartedAt).toBeNull();
    expect(failed.workflow.blockedAt).toBeNull();
    expect(failed.workflow.pausedAt).toBeNull();
    expect(failed.workflow.activeTodoMemoryId).toBeNull();

    const cancelled = markCancelled(createWorkflow(), 'nope', NOW);
    expect(cancelled.workflow.cancelledAt).toBe(NOW);

    const completed = markCompleted(createWorkflow(), NOW);
    expect(completed.workflow.completedAt).toBe(NOW);

    const blocked = markBlocked(createWorkflow(), 'stuck', NOW);
    expect(blocked.workflow.status).toBe('blocked');
    expect(blocked.workflow.blockedAt).toBe(NOW);
  });
});
