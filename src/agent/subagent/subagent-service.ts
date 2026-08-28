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
  agent: CamelAgent;
  task: SubAgentTask;
}

export class SubAgentService {
  private readonly agents = new Map<string, ManagedSubAgent>();
  private readonly deps: SubAgentToolDeps;
  private readonly maxConcurrent: number;

  constructor(deps: SubAgentToolDeps, maxConcurrent = 5) {
    this.deps = deps;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Spawn a new subagent with the given goal and optional budget / maxSteps.
   * Returns a unique taskId immediately (non-blocking).
   */
  async spawn(
    goal: string,
    options?: { maxSteps?: number; budgetLimit?: number },
  ): Promise<string> {
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent subagents (${this.maxConcurrent}) reached. Cannot spawn more.`,
      );
    }

    const taskId = crypto.randomUUID();
    const createdAt = Date.now();

    const task: SubAgentTask = {
      taskId,
      status: 'running',
      createdAt,
    };

    const controller = new AbortController();
    const subSessionId = `${this.deps.sessionId()}::sub::${taskId}`;

    const callbacks = [
      {
        onComplete: (report: CamelReport) => {
          task.status = 'completed';
          task.result = report.result ?? undefined;
          task.completedAt = Date.now();
          this.deps.onStatusUpdate?.(taskId, 'completed', { result: report.result ?? undefined });
        },
        onError: (error: Error) => {
          task.status = 'failed';
          task.error = error.message;
          task.completedAt = Date.now();
          this.deps.onStatusUpdate?.(taskId, 'failed', { error: error.message });
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
      budgetStrategy: options?.budgetLimit != null ? ('fixed' as const) : ('fixed' as const),
      budgetLimit: options?.budgetLimit ?? 25,
    };

    const agent = new CamelAgent(input, this.deps.executeTurnFn);

    const managed: ManagedSubAgent = { controller, agent, task };
    this.agents.set(taskId, managed);

    // Start asynchronously — don't await
    agent.start().catch((err: unknown) => {
      const managedEntry = this.agents.get(taskId);
      if (managedEntry && managedEntry.task.status === 'running') {
        managedEntry.task.status = 'failed';
        managedEntry.task.error = err instanceof Error ? err.message : String(err);
        managedEntry.task.completedAt = Date.now();
        this.deps.onStatusUpdate?.(taskId, 'failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return taskId;
  }

  /**
   * Check the status of a subagent task.
   * Returns null if taskId is unknown.
   */
  check(taskId: string): SubAgentTask | null {
    const managed = this.agents.get(taskId);
    if (!managed) return null;
    // Sync status from the agent for live polling
    const agentStatus = managed.agent.getStatus();
    if (agentStatus === 'running' && managed.task.status === 'running') {
      // still running — status unchanged
    } else if (agentStatus === 'cancelled' && managed.task.status === 'running') {
      managed.task.status = 'failed';
      managed.task.error = 'cancelled';
      managed.task.completedAt = Date.now();
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
    if (managed.task.status === 'running') {
      managed.controller.abort();
      managed.task.status = 'failed';
      managed.task.error = 'cancelled';
      managed.task.completedAt = Date.now();
    }
    return true;
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
