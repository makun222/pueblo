import type { AppConfig } from '../shared/config';
import type { WorkflowInstance, WorkflowStatus } from '../shared/schema';

export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export const ACTIVE_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'idle',
  'drafting',
  'assessing',
  'planning',
  'round-active',
  'round-review',
];

export function isActiveWorkflowState(status: WorkflowStatus): boolean {
  return ACTIVE_WORKFLOW_STATUSES.includes(status);
}

export function isTerminalWorkflowState(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}

export type WorkflowTaskOutcome =
  | { readonly kind: 'success'; readonly hasAssistantOutput: boolean }
  | { readonly kind: 'cancelled'; readonly reason?: string | null }
  | { readonly kind: 'failed'; readonly reason?: string | null };

export interface FsmConfig {
  readonly emptyOutputStrikeLimit: number;
  readonly roundTimeoutMs: number;
  readonly blockedTimeoutMs: number;
  readonly pauseTimeoutMs: number;
}

export const DEFAULT_FSM_CONFIG: FsmConfig = {
  emptyOutputStrikeLimit: 2,
  roundTimeoutMs: 15 * 60 * 1000,
  blockedTimeoutMs: 5 * 60 * 1000,
  pauseTimeoutMs: 10 * 60 * 1000,
};

export function resolveFsmConfig(workflow: Pick<AppConfig, 'workflow'>): FsmConfig {
  return {
    emptyOutputStrikeLimit: workflow.workflow.emptyOutputStrikeLimit,
    roundTimeoutMs: workflow.workflow.roundTimeoutMs,
    blockedTimeoutMs: workflow.workflow.blockedTimeoutMs,
    pauseTimeoutMs: workflow.workflow.pauseTimeoutMs,
  };
}

export interface WorkflowFsmTransition {
  readonly workflow: WorkflowInstance;
  readonly toStatus: WorkflowStatus;
  readonly reason: string | null;
  readonly terminal: boolean;
}

function bumpUpdatedAt(workflow: WorkflowInstance, updatedAt: string): WorkflowInstance {
  return { ...workflow, updatedAt };
}

function withTerminal(workflow: WorkflowInstance, status: WorkflowStatus, reason: string | null, now: string): WorkflowFsmTransition {
  const next: WorkflowInstance = {
    ...workflow,
    status,
    activeRoundNumber: null,
    activeTodoMemoryId: null,
    roundStartedAt: null,
    blockedAt: null,
    pausedAt: null,
    updatedAt: now,
    completedAt: status === 'completed' ? (workflow.completedAt ?? now) : workflow.completedAt,
    failedAt: status === 'failed' ? (workflow.failedAt ?? now) : workflow.failedAt,
    cancelledAt: status === 'cancelled' ? (workflow.cancelledAt ?? now) : workflow.cancelledAt,
  };

  return { workflow: next, toStatus: status, reason, terminal: true };
}

export function enterRoundActive(workflow: WorkflowInstance, roundNumber: number | null, now: string): WorkflowInstance {
  return bumpUpdatedAt({
    ...workflow,
    status: 'round-active',
    activeRoundNumber: roundNumber ?? workflow.activeRoundNumber ?? null,
    roundStartedAt: now,
    blockedAt: null,
    pausedAt: null,
    emptyOutputStrikes: 0,
  }, now);
}

export function enterRoundReview(workflow: WorkflowInstance, now: string): WorkflowInstance {
  return bumpUpdatedAt({
    ...workflow,
    status: 'round-review',
    roundStartedAt: null,
  }, now);
}

export function markBlocked(workflow: WorkflowInstance, reason: string | null, now: string): WorkflowFsmTransition {
  const next = bumpUpdatedAt({
    ...workflow,
    status: 'blocked',
    blockedAt: workflow.blockedAt ?? now,
    roundStartedAt: null,
  }, now);

  return { workflow: next, toStatus: 'blocked', reason, terminal: false };
}

export function markFailed(workflow: WorkflowInstance, reason: string | null, now: string): WorkflowFsmTransition {
  return withTerminal(workflow, 'failed', reason, now);
}

export function markCancelled(workflow: WorkflowInstance, reason: string | null, now: string): WorkflowFsmTransition {
  return withTerminal(workflow, 'cancelled', reason, now);
}

export function markCompleted(workflow: WorkflowInstance, now: string): WorkflowFsmTransition {
  return withTerminal(workflow, 'completed', null, now);
}

export function markPaused(workflow: WorkflowInstance, now: string): WorkflowInstance {
  return bumpUpdatedAt({
    ...workflow,
    status: workflow.status === 'round-active' ? 'round-active' : workflow.status,
    pausedAt: workflow.pausedAt ?? now,
  }, now);
}

export function clearPause(workflow: WorkflowInstance, now: string): WorkflowInstance {
  return bumpUpdatedAt({
    ...workflow,
    pausedAt: null,
  }, now);
}

/**
 * Decide the next state after a task completes, given the FSM watchdog rules.
 * - success + assistant output → stay round-active so the caller can advance the round
 * - success + empty output → accumulate strikes; on reaching the limit → blocked
 * - cancelled → stay round-active but record pausedAt (watchdog will terminate on pauseTimeoutMs)
 * - failed → failed (terminal)
 */
export function observeTaskOutcome(
  workflow: WorkflowInstance,
  outcome: WorkflowTaskOutcome,
  config: FsmConfig,
  now: string,
): WorkflowFsmTransition {
  if (isTerminalWorkflowState(workflow.status)) {
    return { workflow: bumpUpdatedAt(workflow, now), toStatus: workflow.status, reason: null, terminal: true };
  }

  if (outcome.kind === 'failed') {
    return markFailed(workflow, outcome.reason ?? 'Task failed.', now);
  }

  if (outcome.kind === 'cancelled') {
    return {
      workflow: markPaused(workflow, now),
      toStatus: workflow.status,
      reason: 'Task cancelled; workflow paused pending resume.',
      terminal: false,
    };
  }

  if (!outcome.hasAssistantOutput) {
    const strikes = (workflow.emptyOutputStrikes ?? 0) + 1;
    if (strikes >= config.emptyOutputStrikeLimit) {
      return markBlocked(workflow, `Empty assistant output reached the strike limit (${strikes}).`, now);
    }

    return {
      workflow: bumpUpdatedAt({ ...workflow, emptyOutputStrikes: strikes }, now),
      toStatus: workflow.status,
      reason: `Empty assistant output; strike ${strikes} of ${config.emptyOutputStrikeLimit}.`,
      terminal: false,
    };
  }

  return {
    workflow: bumpUpdatedAt({ ...workflow, emptyOutputStrikes: 0 }, now),
    toStatus: workflow.status,
    reason: null,
    terminal: false,
  };
}

/**
 * Watchdog sweep: returns a terminal/blocked transition when a watchdog timeout fires.
 * - round-active + roundStartedAt older than roundTimeoutMs → blocked
 * - blocked + blockedAt older than blockedTimeoutMs → failed
 * - pausedAt older than pauseTimeoutMs → cancelled
 */
export function evaluateWatchdog(
  workflow: WorkflowInstance,
  config: FsmConfig,
  now: string,
): WorkflowFsmTransition | null {
  if (isTerminalWorkflowState(workflow.status)) {
    return null;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return null;
  }

  if (workflow.status === 'blocked' && workflow.blockedAt) {
    const ageMs = nowMs - Date.parse(workflow.blockedAt);
    if (!Number.isNaN(ageMs) && ageMs >= config.blockedTimeoutMs) {
      return markFailed(workflow, 'Blocked workflow exceeded the blocked timeout.', now);
    }
  }

  if (workflow.pausedAt) {
    const ageMs = nowMs - Date.parse(workflow.pausedAt);
    if (!Number.isNaN(ageMs) && ageMs >= config.pauseTimeoutMs) {
      return markCancelled(workflow, 'Paused workflow exceeded the pause timeout.', now);
    }
  }

  if (workflow.status === 'round-active' && workflow.roundStartedAt) {
    const ageMs = nowMs - Date.parse(workflow.roundStartedAt);
    if (!Number.isNaN(ageMs) && ageMs >= config.roundTimeoutMs) {
      return markBlocked(workflow, 'Round exceeded the round timeout.', now);
    }
  }

  return null;
}

/**
 * When a round completes and the planner cannot produce a next round, resolve
 * the terminal/non-terminal state. Tasks still pending (no next round) is treated
 * as a hard failure to avoid the historical `planning` deadlock.
 */
export function resolveCompletionAfterRound(
  workflow: WorkflowInstance,
  allTasksComplete: boolean,
  hasBlockedTask: boolean,
  now: string,
): WorkflowFsmTransition {
  if (hasBlockedTask) {
    return markBlocked(workflow, 'A task is blocked and no further round could be planned.', now);
  }

  if (allTasksComplete) {
    return markCompleted(workflow, now);
  }

  return markFailed(workflow, 'No next round could be planned while tasks remain pending.', now);
}
