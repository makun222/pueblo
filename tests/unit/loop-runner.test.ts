import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoopRunner, type LoopConfig, type LoopRoundResult, type RunRoundFn } from '../../src/agent/loop-runner.js';
import { LoopJobManager, LoopJobStatus } from '../../src/agent/loop-job-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoundFn(outputs: string[]): RunRoundFn {
  let i = 0;
  return async (cfg, _prev, _sig) => {
    const out = outputs[i % outputs.length] ?? 'round ' + cfg.round + ' default';
    i++;
    return { output: out, tokenUsage: 100 };
  };
}

// ---------------------------------------------------------------------------
// LoopRunner
// ---------------------------------------------------------------------------

describe('LoopRunner', () => {
  let runner: LoopRunner;

  beforeEach(() => { runner = new LoopRunner(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // 1. basic rounds & finalSummary
  it('should complete maxRounds and produce finalSummary', async () => {
    const cfg: LoopConfig = { goal: 'task X', maxRounds: 3, judge: 'flag', flag: 'DONE:' };
    const fn = makeRoundFn(['A', 'B', 'C']);
    const r = await runner.run(cfg, fn);
    expect(r.state).toBe('max_rounds');
    expect(r.rounds).toHaveLength(3);
    expect(r.finalSummary).toContain('A');
    expect(r.finalSummary).toContain('B');
    expect(r.finalSummary).toContain('C');
  });

  // 2. early goal detection via flag
  it('should stop on goal_met when flag matches', async () => {
    const cfg: LoopConfig = { goal: 'api', maxRounds: 10, judge: 'flag', flag: 'DONE:' };
    const fn = makeRoundFn(['thinking', 'DONE: api designed']);
    const r = await runner.run(cfg, fn);
    expect(r.state).toBe('goal_met');
    expect(r.rounds).toHaveLength(2);
  });

  // 3. AbortSignal cancellation
  it('should stop when aborted via signal', async () => {
    const ctrl = new AbortController();
    const cfg: LoopConfig = { goal: 'long', maxRounds: 20, judge: 'flag', signal: ctrl.signal };
    const fn: RunRoundFn = async (c, _p, _s) => {
      if (c.round === 1) ctrl.abort();
      return { output: 'r' + c.round, tokenUsage: 10 };
    };
    const r = await runner.run(cfg, fn);
    expect(r.state).toBe('cancelled');
    expect(r.rounds.length).toBeLessThanOrEqual(2);
  });

  // 4. token tracking
  it('should track token usage', async () => {
    const cfg: LoopConfig = { goal: 't', maxRounds: 3, judge: 'flag' };
    const fn: RunRoundFn = async () => ({ output: 'x', tokenUsage: 300 });
    const r = await runner.run(cfg, fn);
    expect(r.rounds).toHaveLength(3);
    expect(r.totalTokens).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// LoopJobManager
// ---------------------------------------------------------------------------

describe('LoopJobManager', () => {
  let runner: LoopRunner;
  let mgr: LoopJobManager;
  let fn: RunRoundFn;

  beforeEach(() => {
    runner = new LoopRunner();
    fn = makeRoundFn(['j1', 'j2', 'DONE: ok']);
    mgr = new LoopJobManager({ loopRunner: runner, runRound: fn });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // 5. start & complete a job
  it('should start and execute a job to completion', async () => {
    const { jobId } = mgr.start({ goal: 'q', maxRounds: 3, judge: 'flag', flag: 'DONE:' });
    expect(mgr.activeCount()).toBe(1);
    const st = mgr.getState(jobId);
    expect(st).not.toBeNull();
    expect(st!.state).toBe('queued');

    await mgr.waitForCompletion(jobId);

    const done = mgr.getState(jobId);
    expect(done!.state).toBe('completed');
    expect(done!.results.length).toBeGreaterThanOrEqual(1);
  });

  // 6. cancel a running job
  it('should cancel a running job', async () => {
    const slow: RunRoundFn = async (c, _p, _s) => {
      await new Promise(r => setTimeout(r, 200));
      return { output: 'slow' + c.round, tokenUsage: 10 };
    };
    const sm = new LoopJobManager({ loopRunner: runner, runRound: slow });
    const { jobId } = sm.start({ goal: 's', maxRounds: 10, judge: 'flag' });
    await new Promise(r => setTimeout(r, 50));
    sm.cancel(jobId);
    await sm.waitForCompletion(jobId);
    expect(sm.getState(jobId)!.state).toBe('cancelled');
  });
});

describe('buildFinalSummary', () => {
  /** Helper: create a minimal LoopRunner to access private buildFinalSummary */
  const makeRunner = () => {
    const mockChatDriver = {
      close: async () => {},
      run: async () => ({ content: [{ type: 'text' as const, text: 'hi' }], stopReason: 'end_turn' as const }),
    };
    return new LoopRunner({ maxRounds: 2 } as LoopConfig, mockChatDriver);
  };

  const makeRound = (output: string): LoopRoundResult => ({
    output,
    iteration: 0,
    tokenUsage: { input: 10, output: 5, total: 15, cache: 0 },
    toolCalls: [],
    stopReason: 'end_turn' as LoopRoundResult['stopReason'],
  });

  it('should return (no output) when rounds array is empty', () => {
    const runner = makeRunner();
    const result = (runner as any).buildFinalSummary('task-1', [], 0);
    expect(result).toContain('(no output)');
    expect(result).toContain('after 0 round(s)');
    expect(result).not.toContain('---');
  });

  it('should return (no output) when all rounds have empty output', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [
      makeRound(''),
      makeRound(''),
      makeRound('  '),
    ];
    const result = (runner as any).buildFinalSummary('task-2', rounds, 45);
    expect(result).toContain('(no output)');
    expect(result).toContain('after 3 round(s)');
    expect(result).toContain('45 tokens');
    expect(result).not.toContain('---');
  });

  it('should use last round output when non-empty', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [
      makeRound('first output'),
      makeRound('second output'),
      makeRound('final output'),
    ];
    const result = (runner as any).buildFinalSummary('task-3', rounds, 100);
    expect(result).toContain('final output');
    expect(result).not.toContain('first output');
    expect(result).not.toContain('second output');
    expect(result).toContain('after 3 round(s)');
    expect(result).toContain('100 tokens');
  });

  it('should merge previous non-empty rounds when last round is empty', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [
      makeRound('round 1 content'),
      makeRound(''),
      makeRound('round 3 content'),
      makeRound(''),
    ];
    const result = (runner as any).buildFinalSummary('task-4', rounds, 80);
    expect(result).toContain('round 1 content');
    expect(result).toContain('round 3 content');
    expect(result).toContain('\n\n---\n\n');
    expect(result).toContain('after 4 round(s)');
    expect(result).toContain('80 tokens');
  });

  it('should skip empty rounds when merging (only one non-empty)', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [
      makeRound('only content'),
      makeRound(''),
      makeRound(''),
      makeRound(''),
    ];
    const result = (runner as any).buildFinalSummary('task-5', rounds, 99);
    expect(result).toContain('only content');
    expect(result).not.toContain('\n\n---\n\n'); // no separator when only one
    expect(result).toContain('after 4 round(s)');
    expect(result).toContain('99 tokens');
  });

  it('should handle single round with output', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [makeRound('solo output')];
    const result = (runner as any).buildFinalSummary('task-6', rounds, 15);
    expect(result).toContain('solo output');
    expect(result).toContain('after 1 round(s)');
    expect(result).toContain('15 tokens');
  });

  it('should handle single empty round', () => {
    const runner = makeRunner();
    const rounds: LoopRoundResult[] = [makeRound('')];
    const result = (runner as any).buildFinalSummary('task-7', rounds, 15);
    expect(result).toContain('(no output)');
    expect(result).toContain('after 1 round(s)');
  });
});
