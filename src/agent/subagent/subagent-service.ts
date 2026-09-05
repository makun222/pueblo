/**
 * SubAgentService — lifecycle management for spawned CamelAgent instances.
 *
 * Maintains an in-memory map of tasks. Each subagent runs asynchronously
 * with its own sessionId, AbortController, budget, and goal.
 */

import { CamelAgent } from '../camel/camel-agent';
import type { CamelAgentInput, ExecuteTurnFn, CamelReport } from '../camel/camel-types';
import type { SubAgentTask, SubAgentStatus, SubAgentToolDeps } from './subagent-types';

interface ManagedSubAgent {
  controller: AbortController;
  agent: CamelAgent | null;
  task: SubAgentTask;
  goal: string;
  options?: { maxSteps?: number; budgetLimit?: number };
}

export class SubAgentService {
  private readonly agents = new Map<string, ManagedSubAgent>();
  private readonly pending: ManagedSubAgent[] = [];
  private readonly deps: SubAgentToolDeps;
  private readonly maxConcurrent: number;
  private readonly maxPending: number;

  constructor(deps: SubAgentToolDeps, maxConcurrent = 5, maxPending = 10) {
    this.deps = deps;
    this.maxConcurrent = maxConcurrent;
    this.maxPending = maxPending;
  }

  /**
   * Spawn a new subagent with the given goal and optional budget / maxSteps.
   * Returns a unique taskId immediately (non-blocking). When the concurrent
   * running limit is reached, the task is queued (`pending`) instead of
   * rejected, and starts as soon as a slot frees up.
   */
  async spawn(
    goal: string,
    options?: { maxSteps?: number; budgetLimit?: number },
  ): Promise<string> {
    const taskId = crypto.randomUUID();
    const createdAt = Date.now();

    const task: SubAgentTask = {
      taskId,
      status: 'pending',
      createdAt,
    };

    const controller = new AbortController();
    const managed: ManagedSubAgent = {
      controller,
      agent: null,
      task,
      goal,
      options,
    };

    this.agents.set(taskId, managed);

    if (this.activeCount < this.maxConcurrent) {
      this.startManaged(managed);
    } else {
      if (this.pending.length >= this.maxPending) {
        this.agents.delete(taskId);
        throw new Error(
          `Max pending subagents (${this.maxPending}) reached. Cannot queue more.`,
        );
      }
      this.pending.push(managed);
    }

    return taskId;
  }

  /**
   * Starts a managed subagent immediately, transitioning it to `running`.
   */
  private startManaged(managed: ManagedSubAgent): void {
    managed.task.status = 'running';

    const { task, goal, options, controller } = managed;
    const taskId = task.taskId;
    const subSessionId = `${this.deps.sessionId()}::sub::${taskId}`;

    const callbacks = [
      {
        onComplete: (report: CamelReport) => {
          task.status = 'completed';
          task.result = report.result ?? undefined;
          task.completedAt = Date.now();
          this.deps.onStatusUpdate?.(taskId, 'completed', { result: report.result ?? undefined });
          this.drainPending();
        },
        onError: (error: Error) => {
          task.status = 'failed';
          task.error = error.message;
          task.completedAt = Date.now();
          this.deps.onStatusUpdate?.(taskId, 'failed', { error: error.message });
          this.drainPending();
        },
      },
    ];

    const input: CamelAgentInput = {
      goal,
      sessionId: subSessionId,
      providerId: this.deps.providerId(),
      modelId: this.deps.modelId(),
      signal: controller.signal,
      callbacks,
      maxSteps: options?.maxSteps ?? 50,
      budgetLimit: options?.budgetLimit ?? 25,
    };

    const agent = new CamelAgent(input, this.deps.executeTurnFn);
    managed.agent = agent;

    // Start asynchronously — don't await
    agent.start().catch((err: unknown) => {
      if (managed.task.status === 'running') {
        managed.task.status = 'failed';
        managed.task.error = err instanceof Error ? err.message : String(err);
        managed.task.completedAt = Date.now();
        this.deps.onStatusUpdate?.(taskId, 'failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.drainPending();
      }
    });
  }

  /**
   * Promotes queued pending subagents into free running slots.
   */
  private drainPending(): void {
    while (this.activeCount < this.maxConcurrent && this.pending.length > 0) {
      const managed = this.pending.shift();
      if (managed) this.startManaged(managed);
    }
  }

  /**
   * Check the status of a subagent task.
   * Returns null if taskId is unknown.
   */
  check(taskId: string): SubAgentTask | null {
    const managed = this.agents.get(taskId);
    if (!managed) return null;
    // Pending tasks have no agent yet; return their queued status directly.
    if (managed.task.status === 'pending' || !managed.agent) {
      return managed.task;
    }
    // Sync status from the agent for live polling
    const agentStatus = managed.agent.getStatus();
    if (agentStatus === 'running' && managed.task.status === 'running') {
      // still running — status unchanged
    } else if (agentStatus === 'cancelled' && managed.task.status === 'running') {
      managed.task.status = 'failed';
      managed.task.error = 'cancelled';
      managed.task.completedAt = Date.now();
      this.drainPending();
    }
    return managed.task;
  }

  /**
   * Cancel a running subagent.
   * Returns true if the task was found and cancelled, false otherwise.
   */
  cancel(taskId: string): boolean {
    const managed = this.agents.get(taskId);
    if (!managed) return false;
    if (managed.task.status === 'pending') {
      const index = this.pending.indexOf(managed);
      if (index >= 0) this.pending.splice(index, 1);
      managed.task.status = 'failed';
      managed.task.error = 'cancelled';
      managed.task.completedAt = Date.now();
      return true;
    }
    if (managed.task.status === 'running') {
      managed.controller.abort();
      managed.task.status = 'failed';
      managed.task.error = 'cancelled';
      managed.task.completedAt = Date.now();
      this.drainPending();
    }
    return true;
  }

  /**
   * Returns the 1-based queue position of a pending task, or null if the task
   * is unknown or is not currently queued (e.g. already running/finished).
   */
  queuePosition(taskId: string): number | null {
    const managed = this.agents.get(taskId);
    if (!managed || managed.task.status !== 'pending') return null;
    const index = this.pending.indexOf(managed);
    return index >= 0 ? index + 1 : null;
  }

  /** Number of active (running) subagents */
  get activeCount(): number {
    let count = 0;
    for (const { task } of this.agents.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }
}
