/**
 * Loop Job Manager
 *
 * Manages concurrent agent-loop execution runs ("jobs").
 *
 * - start() begins a job asynchronously and returns a jobId immediately.
 * - cancel() signals an abort to the underlying LoopRunner.
 * - getState() / getActiveJobs() provide observability for UI consumers.
 *
 * Concurrency is bounded (default maxConcurrent = 2); jobs exceeding the
 * limit are queued and started when a running job finishes.
 *
 * Threading model
 * ---------------
 * This class is designed to live on the Node.js (main) process.  All
 * state mutation happens synchronously inside the private management
 * methods so no mutex / lock is required.
 */

import { randomUUID } from 'node:crypto';
import { LoopRunner, PauseController, type LoopConfig, type LoopTerminationState, type RunRoundFn } from './loop-runner.js';
import type { LoopProgressEvent, LoopJobState, LoopJobStatus, OnRoundProgress } from '../shared/result.js';

// ---------------------------------------------------------------------------
// Internal job record
// ---------------------------------------------------------------------------

interface JobRecord {
  jobId: string;
  state: LoopJobState;
  round: number;
  totalRounds: number;
  results: LoopProgressEvent[];
  startedAt: number;
  abortController: AbortController;
  /** The original LoopConfig supplied to start(). */
  config: LoopConfig;
  /** The promise returned by LoopRunner.run() when the job is active. */
  runPromise: Promise<void> | null;
  /** Optional external callback invoked alongside internal progress recording. */
  externalOnProgress?: OnRoundProgress;

  /** Pause/resume controller for cooperative round-boundary pausing. */
  pauseController: PauseController;

  error?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoopJobManagerOptions {
  /** Pre-built LoopRunner instance (required). */
  loopRunner: LoopRunner;
  /** The round-execution function to pass to LoopRunner.run(). */
  runRound: RunRoundFn;
  /** Maximum number of concurrently-running jobs (default 2). */
  maxConcurrent?: number;
}

// ---------------------------------------------------------------------------
// LoopJobManager
// ---------------------------------------------------------------------------

export class LoopJobManager {
  private readonly loopRunner: LoopRunner;
  private readonly runRound: RunRoundFn;
  private readonly maxConcurrent: number;

  /** Active + queued jobs keyed by jobId. */
  private readonly jobs = new Map<string, JobRecord>();
  /** FIFO queue of jobIds waiting for an execution slot. */
  private readonly queue: string[] = [];

  constructor(options: LoopJobManagerOptions) {
    this.loopRunner = options.loopRunner;
    this.runRound = options.runRound;
    this.maxConcurrent = options.maxConcurrent ?? 2;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start a new loop job.
   *
   * The configuration is validated synchronously; if invalid, an error is
   * thrown.  Otherwise a jobId is returned immediately and execution
   * proceeds in the background (potentially after queuing).
   */
  start(config: LoopConfig, onProgress?: OnRoundProgress, _jobId?: string): { jobId: string } {
    if (config.maxRounds < 1) {
      throw new Error('LoopJobManager.start: maxRounds must be >= 1');
    }

    const jobId = _jobId ?? randomUUID();
    const abortController = new AbortController();

    // Build the signal-wired config once and store it.
    const configWithSignal: LoopConfig = { ...config, signal: abortController.signal };

    const record: JobRecord = {
      jobId,
      state: 'running',
      round: 0,
      totalRounds: config.maxRounds,
      results: [],
      startedAt: Date.now(),
      abortController,
      config: configWithSignal,
      runPromise: null,
      externalOnProgress: onProgress,
      pauseController: new PauseController(),
    };

    this.jobs.set(jobId, record);

    // Try to start immediately; queue if at capacity.
    const activeCount = this.activeCount();
    if (activeCount < this.maxConcurrent) {
      this.launch(record);
    } else {
      this.queue.push(jobId);
    }

    return { jobId };
  }

  /**
   * Request cancellation of a job.
   *
   * Cancellation is cooperative — the LoopRunner will stop at the next
   * round boundary.  The monitor consumer will receive a progress event
   * with `ok: false`.
   */
  cancel(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (!record) return;

    record.abortController.abort();

    // If the job is still queued (not yet launched), remove it from the
    // queue and mark it cancelled immediately.
    const queueIdx = this.queue.indexOf(jobId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      record.state = 'cancelled';
    }
  }

  /** Return snapshot state for a single job. */
  getState(jobId: string): LoopJobStatus | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    return toJobStatus(record);
  }

  /** Return snapshot state for every job that is currently active or recently finished. */
  getActiveJobs(): LoopJobStatus[] {
    const result: LoopJobStatus[] = [];
    for (const [, record] of this.jobs) {
      result.push(toJobStatus(record));
    }
    return result;
  }

  /** Return all jobs in the manager (alias for getActiveJobs). */
  getAllJobs(): LoopJobStatus[] {
    return this.getActiveJobs();
  }

  /** Cancel all running jobs and clear the internal state. */
  dispose(): void {
    for (const [jobId, record] of this.jobs) {
      if (record.state === 'running') {
        this.cancel(jobId);
      }
    }
    this.jobs.clear();
    this.queue.length = 0;
  }

  /**
   * Return a promise that resolves when a job reaches a terminal state.
   * Useful for callers that need to await loop completion after start().
   */
  async waitForCompletion(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) return;
    if (record.runPromise) {
      await record.runPromise;
      return;
    }
    // Poll until terminal — handles the race where start() hasn't called launch() yet
    const pollIntervalMs = 100;
    while (true) {
      const r = this.jobs.get(jobId);
      if (!r) return;
      if (r.state === 'completed' || r.state === 'cancelled' || r.state === 'failed') return;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  public activeCount(): number {
    let count = 0;
    for (const [, r] of this.jobs) {
      if (r.state === 'running' && r.runPromise !== null) count++;
    }
    return count;
  }

  /** Begin executing a job. */
  private launch(record: JobRecord): void {
    const onProgress = (event: LoopProgressEvent): void => {
      record.results.push(event);
      record.round = event.round;
      if (record.externalOnProgress) {
        record.externalOnProgress(event);
      }
    };

    record.runPromise = this.loopRunner
      .run(record.config, this.runRound, record.jobId, onProgress, record.pauseController)
      .then((result) => {
        record.state = terminationStateToJobState(result.state);
      })
      .catch((err: unknown) => {
        record.state = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        record.runPromise = null;
        this.drainQueue();
      });
  }

  /**
   * Pause a running loop job at the next round boundary.
   * Returns true if the job was found and a pause signal was delivered.
   */
  pauseJob(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record) {
      return false;
    }
    record.pauseController.pause();
    return true;
  }

  /**
   * Resume a paused loop job.
   * Returns true if the job was found and a resume signal was delivered.
   */
  resumeJob(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record) {
      return false;
    }
    record.pauseController.resume();
    return true;
  }

  /** Start the next queued job if slots are available. */
  private drainQueue(): void {
    while (this.queue.length > 0) {
      const activeCount = this.activeCount();
      if (activeCount >= this.maxConcurrent) break;

      const nextJobId = this.queue.shift()!;
      const record = this.jobs.get(nextJobId);
      if (!record) continue;

      // If the job was cancelled while queued, skip it.
      if (record.abortController.signal.aborted) {
        record.state = 'cancelled';
        continue;
      }

      this.launch(record);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function terminationStateToJobState(s: LoopTerminationState): LoopJobState {
  switch (s) {
    case 'goal_met':
    case 'max_rounds':
    case 'token_budget':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'failed';
    // default exhaustiveness — should not happen but be safe:
    default:
      return 'failed';
  }
}

function toJobStatus(record: JobRecord): LoopJobStatus {
  return {
    jobId: record.jobId,
    state: record.state,
    round: record.round,
    totalRounds: record.totalRounds,
    results: record.results,
    startedAt: record.startedAt,
    error: record.error,
  };
}
