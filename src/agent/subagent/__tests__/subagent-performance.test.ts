import { describe, it, expect } from 'vitest';
import { SubAgentService } from '../subagent-service';
import type { SubAgentToolDeps } from '../subagent-types';
import type { ExecuteTurnFn } from '../../camel/camel-types';

// ============================================================================
// SubAgentService 并行性能测试
// 覆盖: 并行 vs 串行加速比、满并发吞吐、批次复用、超并发排队、混合负载
// 断言策略: 全部使用相对比较（并行耗时 < 串行耗时 × 系数），避免脆弱的绝对阈值
// ============================================================================

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 每个回合延迟 delayMs、前 rounds 回合返回非空建议的任务桩 */
function makeDelayedExecuteTurn(delayMs: number, rounds = 0): { fn: ExecuteTurnFn } {
  const fn: ExecuteTurnFn = async input => {
    await sleep(delayMs);
    const done = input.context.contextSummary['__done'] === true || rounds === 0;
    const suggestion = done ? '' : `turn`;
    return {
      suggestion,
      context: input.context,
      turn: { messages: [], suggestion },
    };
  };
  return { fn };
}

function makeDeps(executeTurnFn: ExecuteTurnFn): SubAgentToolDeps {
  return {
    sessionId: () => 'perf-session',
    providerId: () => 'test-provider',
    modelId: () => 'test-model',
    executeTurnFn,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(intervalMs);
  }
}

/** 等待一批任务全部进入 final 状态 */
async function waitAllFinal(service: SubAgentService, taskIds: string[], timeoutMs = 5_000) {
  await waitFor(() => taskIds.every(id => {
    const t = service.check(id);
    return t?.status === 'completed' || t?.status === 'failed';
  }), timeoutMs);
}

describe('SubAgentService 并行性能 — 加速比', () => {
  it('5 个任务并行执行耗时显著小于串行执行 (验证真正的并行)', async () => {
    const DELAY = 80;
    const N = 5;

    // --- 串行基线: 逐个 spawn 并等待完成 ---
    const serialTurn = makeDelayedExecuteTurn(DELAY);
    const serialService = new SubAgentService(makeDeps(serialTurn.fn), N);
    const serialStart = Date.now();
    for (let i = 0; i < N; i++) {
      const id = await serialService.spawn(`serial-${i}`);
      await waitFor(() => serialService.check(id)?.status === 'completed');
    }
    const serialMs = Date.now() - serialStart;

    // --- 并行: 一次性 spawn 全部 ---
    const parallelTurn = makeDelayedExecuteTurn(DELAY);
    const parallelService = new SubAgentService(makeDeps(parallelTurn.fn), N);
    const parallelStart = Date.now();
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => parallelService.spawn(`parallel-${i}`)),
    );
    await waitAllFinal(parallelService, ids);
    const parallelMs = Date.now() - parallelStart;

    // 串行 ≈ N × DELAY; 并行 ≈ DELAY
    expect(serialMs).toBeGreaterThan(N * DELAY * 0.8);
    expect(parallelMs).toBeLessThan(serialMs * 0.6);
    // 全部任务成功完成
    for (const id of ids) {
      expect(parallelService.check(id)?.status).toBe('completed');
    }
  });

  it('满并发(5)下总耗时约为单任务延迟量级, 而非 5 倍', async () => {
    const DELAY = 100;
    const N = 5;
    const { fn } = makeDelayedExecuteTurn(DELAY);
    const service = new SubAgentService(makeDeps(fn), N);

    const start = Date.now();
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => service.spawn(`t${i}`)),
    );
    await waitAllFinal(service, ids);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(DELAY * 3); // 远小于串行 5×DELAY
    expect(service.activeCount).toBe(0);
  });
});

describe('SubAgentService 并行性能 — 吞吐与槽位复用', () => {
  it('20 个任务分 4 批(每批 5)执行, 总耗时约为批次数量 × 单任务延迟', async () => {
    const DELAY = 60;
    const BATCH = 5;
    const TOTAL = 20;
    const { fn } = makeDelayedExecuteTurn(DELAY);
    const service = new SubAgentService(makeDeps(fn), BATCH);

    const start = Date.now();
    const allIds: string[] = [];
    for (let batch = 0; batch < TOTAL / BATCH; batch++) {
      const ids = await Promise.all(
        Array.from({ length: BATCH }, (_, i) => service.spawn(`b${batch}-${i}`)),
      );
      allIds.push(...ids);
      await waitAllFinal(service, ids);
    }
    const elapsed = Date.now() - start;

    // 完全串行需要 TOTAL × DELAY = 1200ms; 分批并行 ≈ 4 × DELAY + 开销
    expect(elapsed).toBeLessThan(TOTAL * DELAY * 0.6);
    for (const id of allIds) {
      expect(service.check(id)?.status).toBe('completed');
    }
  });

  it('超并发排队: maxConcurrent=5、maxPending=10 时同时 spawn 50 个, 恰好 5 运行、10 排队、35 拒绝', async () => {
    const DELAY = 20;
    const MAX = 5;
    const MAX_PENDING = 10;
    const TOTAL = 50;
    const { fn } = makeDelayedExecuteTurn(DELAY);
    const service = new SubAgentService(makeDeps(fn), MAX, MAX_PENDING);

    const results = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) => service.spawn(`r${i}`)),
    );
    const ok = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // 新语义: 5 个立即运行, 10 个进入 pending 队列, 其余 35 个超过排队长上限被拒绝
    expect(ok.length).toBe(MAX + MAX_PENDING);
    expect(rejected.length).toBe(TOTAL - ok.length);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason?.message).toContain(
        `Max pending subagents (${MAX_PENDING}) reached`,
      );
    }

    // 前 5 个为 running, 接着 10 个为 pending 且队列位置依次为 1..10
    const okIds = ok.map(r => (r as PromiseFulfilledResult<string>).value);
    const runningIds = okIds.filter(id => service.check(id)?.status === 'running');
    const pendingIds = okIds.filter(id => service.check(id)?.status === 'pending');
    expect(runningIds.length).toBe(MAX);
    expect(pendingIds.length).toBe(MAX_PENDING);
    for (let i = 0; i < pendingIds.length; i++) {
      expect(service.queuePosition(pendingIds[i])).toBe(i + 1);
    }

    // 槽位释放后排队任务自动全部执行完, 且无悬挂任务
    await waitAllFinal(service, okIds);
    expect(service.activeCount).toBe(0);
    for (const id of okIds) {
      expect(service.check(id)?.status).toBe('completed');
    }
  });
});

describe('SubAgentService 并行性能 — 混合负载', () => {
  it('1 个多回合长任务与 4 个短任务并行: 互不阻塞, 全部完成', async () => {
    const SHORT_DELAY = 50;
    const LONG_DELAY = 80;
    const LONG_ROUNDS = 3; // 长任务 ≈ 4 回合 × 80ms
    const MAX = 5;

    // 长任务: 前 LONG_ROUNDS 次非空, 之后完成 (回合数用闭包计数,
    // 因为 CamelContext.get() 每回合返回新的 contextSummary, 不能存在 context 里)
    let round = 0;
    const longFn: ExecuteTurnFn = async input => {
      await sleep(LONG_DELAY);
      round++;
      const suggestion = round <= LONG_ROUNDS ? 'working...' : '';
      return {
        suggestion,
        context: input.context,
        turn: { messages: [], suggestion },
      };
    };
    const shortFn = makeDelayedExecuteTurn(SHORT_DELAY);

    // 两个 service 模拟不同子代理群; 此处用同一 deps 思路: 长任务单独 service
    const longService = new SubAgentService(makeDeps(longFn), MAX);
    const shortService = new SubAgentService(makeDeps(shortFn.fn), MAX);

    const start = Date.now();
    const longId = await longService.spawn('long-task');
    const shortIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) => shortService.spawn(`short-${i}`)),
    );
    await waitAllFinal(longService, [longId]);
    await waitAllFinal(shortService, shortIds);
    const elapsed = Date.now() - start;

    expect(longService.check(longId)?.status).toBe('completed');
    for (const id of shortIds) {
      expect(shortService.check(id)?.status).toBe('completed');
    }
    // 长任务约 4×80=320ms, 短任务 50ms; 并行总耗时应接近长任务耗时
    expect(elapsed).toBeLessThan(LONG_DELAY * (LONG_ROUNDS + 1) * 1.5);
  });
});
