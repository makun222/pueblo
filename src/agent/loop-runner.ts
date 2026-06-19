import type { LoopProgressEvent, OnRoundProgress } from '../shared/result.ts';
export type { LoopProgressEvent, OnRoundProgress };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopConfig {
  /** The goal to achieve across all rounds. */
  goal: string;
  /** Maximum number of agent-loop rounds. Default: 20. */
  maxRounds: number;
  /** Optional cumulative token budget across all rounds. */
  maxTokens?: number;
  /** Completion detection mode. */
  judge: 'flag' | 'llm';
  /** Custom flag string (default: <<<LOOP_GOAL_MET>>>). */
  flag?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export type LoopTerminationState =
  | 'goal_met'
  | 'max_rounds'
  | 'token_budget'
  | 'cancelled'
  | 'error';

export interface LoopRoundResult {
  round: number;
  state: LoopTerminationState;
  /** The assistant output text from this round. */
  output: string;
  /** Token usage for this round (provider-reported). */
  tokenUsage: number;
}

export interface LoopResult {
  state: LoopTerminationState;
  rounds: LoopRoundResult[];
  totalTokens: number;
  finalSummary: string;
}

/** Signature of the function that runs a single agent-loop round. */
export interface RunRoundConfig {
  round: number;
  totalRounds: number;
  goal: string;
  accumulatedContext: string;
}

export interface RunRoundResult {
  output: string;
  tokenUsage: number;
}

export type RunRoundFn = (
  config: RunRoundConfig,
  prevResult: RunRoundResult | null,
  signal: AbortSignal,
) => Promise<RunRoundResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLAG = '<<<LOOP_GOAL_MET>>>';
const DEFAULT_MAX_ROUNDS = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan `text` for the loop-goal-met flag marker.
 */
function scanForFlag(text: string, flag: string): boolean {
  return text.includes(flag);
}

/**
 * Build a prompt that asks the LLM whether the goal has been met.
 * Returns an assistant-formatted prompt string.
 */
function buildJudgePrompt(goal: string, lastOutput: string): string {
  return [
    'You are a goal-completion judge. Review the following task output and determine',
    'whether the stated goal has been fully achieved. Respond with ONLY the word',
    '"MET" if the goal has been completely achieved, or "NOT_MET" if more work remains.',
    '',
    `Goal: ${goal}`,
    '',
    `Task Output:`,
    lastOutput,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LoopRunner
// ---------------------------------------------------------------------------

/**
 * Controls pause/resume for a single loop job.
 * Pause is per-job: after the current round finishes, the runner blocks
 * until resume() is called, the abort signal fires, or a 30-minute timeout elapses.
 */
export class PauseController {
  private _paused = false;
  private _resolve: (() => void) | null = null;
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly _timeoutMs = 30 * 60 * 1000; // 30 minutes

  /** Request pause after current round. */
  pause(): void {
    this._paused = true;
    this._startTimeout();
  }

  /** Release the pause and continue execution. */
  resume(): void {
    this._clearTimeout();
    this._paused = false;
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }

  /** Whether pause has been requested (may not yet be blocking). */
  isPaused(): boolean {
    return this._paused;
  }

  /**
   * Block until resumed, aborted, or timeout.
   * @returns 'resumed' | 'cancelled' | 'timeout'
   */
  async waitIfPaused(signal?: AbortSignal): Promise<'resumed' | 'cancelled' | 'timeout'> {
    if (!this._paused) {
      return 'resumed';
    }
    try {
      return await new Promise<'resumed' | 'cancelled' | 'timeout'>((resolve) => {
        this._resolve = () => resolve('resumed');
        if (signal) {
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }
      });
    } finally {
      this._clearTimeout();
      this._paused = false;
    }
  }

  private _startTimeout(): void {
    if (this._timeoutHandle) return;
    this._timeoutHandle = setTimeout(() => {
      this._paused = false;
      if (this._resolve) {
        this._resolve();
        this._resolve = null;
      }
    }, this._timeoutMs);
  }

  private _clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }
}

// ---------------------------------------------------------------------------

export class LoopRunner {
  /**
   * Run the loop: repeatedly invoke `runRound` until a termination condition
   * is met or the loop budget is exhausted.
   */
  async run(
    configArg: LoopConfig,
    runRound: RunRoundFn,
    jobId?: string,
    onProgress?: OnRoundProgress,
    pauseController?: PauseController,
  ): Promise<LoopResult> {
    const jid = jobId ?? `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const config = {
      goal: configArg.goal,
      maxRounds: configArg.maxRounds > 0 ? configArg.maxRounds : DEFAULT_MAX_ROUNDS,
      maxTokens: configArg.maxTokens,
      judge: configArg.judge,
      flag: configArg.flag || DEFAULT_FLAG,
      signal: configArg.signal,
    };
    const signal = config.signal ?? new AbortController().signal;

    // -- structured logging helper ------------------------------------------------
    const logRound = (phase: 'start' | 'end', data: {
      round: number; totalRounds: number; elapsed?: number;
      ok?: boolean; tokens?: number; outputLen?: number;
    }) => {
      console.log(JSON.stringify({
        event: 'loop_round', phase, timestamp: new Date().toISOString(), ...data,
      }));
    };

    const rounds: LoopRoundResult[] = [];
    let totalTokens = 0;
    let accumulatedContext = '';
    let lastResult: RunRoundResult | null = null;
    let finalState: LoopTerminationState = 'max_rounds';

    for (let round = 1; round <= config.maxRounds; round++) {
      // -- cancellation check -------------------------------------------------
      if (signal.aborted) {
        finalState = 'cancelled';
        onProgress?.({
          jobId: jid,
          status: 'completed',
          round,
          totalRounds: config.maxRounds,
          content: '',
          ok: false,
          elapsedMs: 0,
        });
        break;
      }

      // -- run the round ------------------------------------------------------
      let output: string;
      let tokenUsage: number;

      let roundElapsed = 0;

      // -- emit running event --------------------------------------------------
      onProgress?.({
        jobId: jid,
        status: 'running',
        round,
        totalRounds: config.maxRounds,
        message: `Starting round ${round}/${config.maxRounds}`,
        ok: true,
        elapsedMs: 0,
      });
      logRound('start', { round, totalRounds: config.maxRounds });

      try {
        const roundStart = performance.now();
        const roundConfig: RunRoundConfig = {
          round,
          totalRounds: config.maxRounds,
          goal: config.goal,
          accumulatedContext,
        };
        const roundResult = await runRound(roundConfig, lastResult, signal);
        roundElapsed = performance.now() - roundStart;
        output = roundResult.output;
        tokenUsage = roundResult.tokenUsage;
        lastResult = roundResult;
      } catch (err) {
        finalState = 'error';
        const errorMsg = err instanceof Error ? err.message : String(err);
        rounds.push({
          round,
          state: 'error',
          output: errorMsg,
          tokenUsage: 0,
        });
        if (onProgress) {
          onProgress({
            jobId: jid,
            status: 'error',
            round,
            totalRounds: config.maxRounds,
            content: errorMsg,
            ok: false,
            elapsedMs: 0,
          });
        }
        break;
      }

      totalTokens += tokenUsage;

      // -- goal detection -----------------------------------------------------
      let goalMet = false;

      // Flag check (always checked first, regardless of judge mode)
      if (scanForFlag(output, config.flag)) {
        goalMet = true;
      }

      // LLM judge fallback (only if flag mode and flag not found)
      if (!goalMet && config.judge === 'llm') {
        // Note: LLM judge requires an additional LLM call.
        // We delegate this to the caller by expecting output to contain
        // the judge's decision when judge=llm. For now, the judge
        // prompt is injected into the accumulated context so the next
        // round's LLM can evaluate. In a real implementation, this
        // would make a separate judge call.
        //
        // For v1: if the round output contains the literal "GOAL_COMPLETE"
        // (which the agent is instructed to emit when done), treat as met.
        if (output.includes('GOAL_COMPLETE')) {
          goalMet = true;
        }
      }

      // -- record round -------------------------------------------------------
      const roundState: LoopTerminationState = goalMet ? 'goal_met' : 'max_rounds';
      rounds.push({
        round,
        state: roundState,
        output,
        tokenUsage,
      });

      // -- notify progress ----------------------------------------------------
      if (onProgress) {
        onProgress({
          jobId: jid,
          status: 'round-completed',
          round,
          totalRounds: config.maxRounds,
          content: output,
          ok: true, // round succeeded (error branches exit earlier)
          elapsedMs: roundElapsed,
        });
      }

      // -- accumulate context for next round ----------------------------------
      const roundLabel = `[Round ${round}]`;
      accumulatedContext += `\n${roundLabel}\n${output}\n`;

      logRound('end', {
        round, totalRounds: config.maxRounds, elapsed: roundElapsed,
        ok: true, tokens: totalTokens, outputLen: output.length,
      });

      if (goalMet) {
        finalState = 'goal_met';
        break;
      }

      // -- token budget check -------------------------------------------------
      if (config.maxTokens && totalTokens >= config.maxTokens) {
        finalState = 'token_budget';
        break;
      }
    }

    // -- pause-after-round check -------------------------------------------
    if (pauseController) {
      const pauseResult = await pauseController.waitIfPaused(signal);
      if (pauseResult === 'cancelled' || pauseResult === 'timeout') {
        finalState = 'cancelled';
      }
    }

    // Determine overall state
    if (finalState === 'max_rounds' && rounds.length > 0) {
      finalState = 'max_rounds';
    }

    const finalSummary = this.buildFinalSummary(finalState, rounds, totalTokens);

    // Emit completed event so the progress sender can forward finalOutput to the monitor
    onProgress?.({
      jobId: jid,
      status: 'completed' as const,
      round: rounds.length,
      totalRounds: config.maxRounds,
      message: 'Loop completed',
      finalOutput: finalSummary,
    });

    return {
      state: finalState,
      rounds,
      totalTokens,
      finalSummary,
    };
  }

  private buildFinalSummary(
    state: LoopTerminationState,
    rounds: LoopRoundResult[],
    totalTokens: number,
  ): string {
    const lastOutput = rounds.length > 0 ? rounds[rounds.length - 1].output : '(no output)';
    const prefix = state === 'goal_met'
      ? '✅ Goal achieved'
      : state === 'token_budget'
        ? '⚠️ Token budget exhausted'
        : state === 'cancelled'
          ? '⏹️ Cancelled'
          : state === 'error'
            ? '❌ Error'
            : '⏱️ Maximum rounds reached';

    return `${prefix} after ${rounds.length} round(s), ${totalTokens} tokens.\n\n${lastOutput}`;
  }
}
