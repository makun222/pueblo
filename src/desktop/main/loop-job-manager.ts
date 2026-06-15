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
import type {
	RunRoundFn,
	LoopConfig,
	LoopProgressEvent,
} from '../../agent/loop-runner.js';
import type { LoopJobStatus } from '../../shared/result.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DesktopLoopJobManagerOptions {
	/** Round execution function (delegates to agent) */
	runRound: RunRoundFn;
	/** Maximum concurrent loop jobs (default 1) */
	maxConcurrent?: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class LoopJobManager {
	private readonly agentManager: AgentLoopJobManager;

	constructor(options: DesktopLoopJobManagerOptions) {
		this.agentManager = new AgentLoopJobManager({
			runRound: options.runRound,
			maxConcurrent: options.maxConcurrent ?? 1,
		});
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
	): { jobId: string } {
		return this.agentManager.start(config, onProgress);
	}

	/** Cancel a running or pending loop job. */
	cancelJob(jobId: string): void {
		this.agentManager.cancel(jobId);
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

