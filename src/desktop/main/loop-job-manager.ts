/**
 * Desktop Loop Job Manager
 *
 * Composes the agent-side LoopJobManager (from src/agent/loop-job-manager.ts)
 * and provides the desktop-main-process surface for IPC handlers.
 *
 * Phase 3: Wired to call real loopRunner.run() via agent LoopJobManager.
 */

import {
	LoopJobManager as AgentLoopJobManager,
} from '../../agent/loop-job-manager.js';
import {
	LoopRunner,
} from '../../agent/loop-runner.js';
import type {
	RunRoundFn,
	LoopConfig,
	LoopProgressEvent,
} from '../../agent/loop-runner.js';
import type { LoopJobStatus, OnRoundProgress } from '../../shared/result.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DesktopLoopJobManagerOptions {
	/** Round execution function (delegates to agent) — optional, can be wired later via setRunRound() */
	runRound?: RunRoundFn;
	/** Maximum concurrent loop jobs (default 1) */
	maxConcurrent?: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class DesktopLoopJobManager {
	private readonly agentManager: AgentLoopJobManager;
	private _runRound: RunRoundFn = async () => {
		throw new Error('runRound not wired — call setRunRound() first');
	};

	constructor(options?: DesktopLoopJobManagerOptions) {
		if (options?.runRound) {
			this._runRound = options.runRound;
		}
		this.agentManager = new AgentLoopJobManager({
			loopRunner: new LoopRunner(),
			runRound: (config, prevResult, signal) =>
				this._runRound(config, prevResult, signal),
			maxConcurrent: options?.maxConcurrent ?? 1,
		});
	}

	/**
	 * Wire the round execution function after construction.
	 * Used when the real `runRound` depends on objects (e.g. CLI taskRunner)
	 * created after this manager is instantiated.
	 */
	setRunRound(fn: RunRoundFn): void {
		this._runRound = fn;
	}

	// -----------------------------------------------------------------------
	// Public API — mirrors agent LoopJobManager, adding IPC-friendly types
	// -----------------------------------------------------------------------

	/**
	 * Start a new loop job.
	 * Delegates to agent LoopJobManager.start() which internally calls
	 * loopRunner.run().
	 */
	startJob(
		config: LoopConfig,
		onProgress?: (event: LoopProgressEvent) => void,
		_jobId?: string,
	): { jobId: string } {
		return this.agentManager.start(config, onProgress, _jobId);
	}

	/** Cancel a running or pending loop job. */
	cancelJob(jobId: string): { ok: boolean } {
		try {
			this.agentManager.cancel(jobId);
			return { ok: true };
		} catch (e) {
			console.error(`cancelLoopJob: agent cancel failed:`, e);
			return { ok: false };
		}
	}

	/** Get the status of a single job. */
	getJobStatus(jobId: string): LoopJobStatus | null {
		return this.agentManager.getState(jobId);
	}

	/** List all jobs (running + pending + completed). */
	listJobs(): LoopJobStatus[] {
		return this.agentManager.getAllJobs();
	}

	/** Number of currently active (running) jobs. */
	get activeCount(): number {
		return this.agentManager.activeCount();
	}

	/** Dispose the manager and all associated resources. */
	dispose(): void {
		this.agentManager.dispose();
	}
}

