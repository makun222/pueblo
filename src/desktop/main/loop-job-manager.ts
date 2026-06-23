/**
 * Desktop Loop Job Manager
 *
 * Composes the agent-side LoopJobManager (from src/agent/loop-job-manager.ts)
 * and provides the desktop-main-process surface for IPC handlers.
 *
 * Phase 3: Wired to call real loopRunner.run() via agent LoopJobManager.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
// Call-model callback type
// ---------------------------------------------------------------------------

/** Lightweight LLM callback used for pre-flight goal validation. */
export type CallModelFn = (modelId: string, prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DesktopLoopJobManagerOptions {
	/** Round execution function (delegates to agent) �� optional, can be wired later via setRunRound() */
	runRound?: RunRoundFn;
	/** Maximum concurrent loop jobs (default 1) */
	maxConcurrent?: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class DesktopLoopJobManager {
	private readonly agentManager: AgentLoopJobManager;
	private _callModel: CallModelFn | null = null;
	private _runRound: RunRoundFn = async () => {
		throw new Error('runRound not wired �� call setRunRound() first');
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

	/** Wires the LLM call-back used by validateGoal() �� same injection pattern as setRunRound(). */
	setCallModel(fn: CallModelFn): void {
		this._callModel = fn;
	}

	// -----------------------------------------------------------------------
	// Public API �� mirrors agent LoopJobManager, adding IPC-friendly types
	// -----------------------------------------------------------------------

	/**
	 * Start a new loop job.
	 * Delegates to agent LoopJobManager.start() which internally calls
	 * loopRunner.run().
	 */
	// ------------------------------------------------------------------
	// Pre-flight goal validation
	// ------------------------------------------------------------------

	private isFilePath(goal: string): boolean {
		try {
			const resolved = path.resolve(goal);
			if (fs.existsSync(resolved)) return true;
		} catch {
			// ignore resolution errors
		}
		return false;
	}

	private async validateGoal(
		goal: string,
		modelId: string,
	): Promise<{ valid: boolean; reason: string }> {
		// Existing file paths are inherently concrete -- skip LLM validation.
		if (this.isFilePath(goal)) {
			return { valid: true, reason: 'goal is an existing file path' };
		}

		const prompt = `You are a task goal validator. Evaluate whether the following goal is concrete, verifiable, and actionable: "${goal}"

        Return ONLY a JSON object: {"valid": true/false, "reason": "brief explanation in Chinese"}

		A goal is invalid if it is vague, has no clear deliverable, or cannot be verified as done.`;

		const response = await this._callModel!(modelId, prompt);

		try {
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return { valid: true, reason: 'unable to parse validation response -- proceeding' };
			}
			const parsed = JSON.parse(jsonMatch[0]);
			if (typeof parsed.valid === 'boolean' && typeof parsed.reason === 'string') {
				return { valid: parsed.valid, reason: parsed.reason };
			}
			return { valid: true, reason: 'unexpected validation response format -- proceeding' };
		} catch {
			return { valid: true, reason: 'validation parse error -- proceeding' };
		}
	}

	// ------------------------------------------------------------------
	// startJob
	// ------------------------------------------------------------------

	async startJob(
		config: LoopConfig,
		onProgress?: (event: LoopProgressEvent) => void,
		_jobId?: string,
		modelId?: string,
	): Promise<{ jobId: string }> {
		// Create the job immediately so the UI sees progress right away,
		// but defer launch until validation completes.
		const { jobId } = this.agentManager.start(config, onProgress, _jobId, true);

		if (this._callModel && modelId) {
			const { valid, reason } = await this.validateGoal(config.goal, modelId);
			if (!valid) {
				this.agentManager.cancel(jobId);
				throw new Error(`Goal validation failed: ${reason}`);
			}
		}

		this.agentManager.launchJob(jobId);
		return { jobId };
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

	/** Pause a running loop job. */
	pauseJob(jobId: string): { ok: boolean } {
		try {
			this.agentManager.pauseJob(jobId);
			return { ok: true };
		} catch (e) {
			console.error(`pauseJob: agent pause failed:`, e);
			return { ok: false };
		}
	}

	/** Resume a paused loop job. */
	resumeJob(jobId: string): { ok: boolean } {
		try {
			this.agentManager.resumeJob(jobId);
			return { ok: true };
		} catch (e) {
			console.error(`resumeJob: agent resume failed:`, e);
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

