import { describe, it, expect, vi } from 'vitest';
import { SubAgentService } from '../subagent-service';
import type { SubAgentToolDeps, SubAgentStatus } from '../subagent-types';
import type { ExecuteTurnFn } from '../../camel/camel-types';

// ============================================================================
// SubAgentService 稳定性测试
// 覆盖: spawn → execute → check 全生命周期、并发上限、取消、异常隔离、状态同步
// ============================================================================

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 构造一个可控的 ExecuteTurnFn 桩 */
function makeExecuteTurnFn(opts?: {
  delayMs?: number;
  /** 前 rounds 次返回非空建议，之后返回空串表示完成 */
  rounds?: number;
  /** 从第几次执行起持续抛错（普通 Error，触发重试） */
  failFrom?: number;
  /** 命中这些 goal 的任务抛错（用于同 service 内异常隔离） */
  failGoals?: string[];
  /** 监听 abort 信号，取消时抛 AbortError */
  abortable?: boolean;
}): { fn: ExecuteTurnFn; calls: () => number } {
  let calls = 0;
  const fn: ExecuteTurnFn = async input => {
    calls++;
    if (opts?.abortable) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs ?? 60_000);
        input.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    } else if (opts?.delayMs) {
      await sleep(opts.delayMs);
    }

    const goal = input.context.contextSummary['goal'] as string | undefined;
    if (opts?.failFrom != null && calls >= opts.failFrom) {
      throw new Error('executeTurn: injected failure');
    }
    if (opts?.failGoals?.includes(goal ?? '')) {
      throw new Error(`executeTurn: injected failure for goal=${goal}`);
    }

    const done = opts?.rounds != null && calls > opts.rounds;
    const suggestion = done ? '' : `turn-${calls}`;
    return {
      suggestion,
      context: input.context,
      turn: { messages: [], suggestion },
    };
  };
  return { fn, calls: () => calls };
}

function makeDeps(
  executeTurnFn: ExecuteTurnFn,
  onStatusUpdate?: SubAgentToolDeps['onStatusUpdate'],
): SubAgentToolDeps {
  return {
    sessionId: () => 'session-test',
    providerId: () => 'test-provider',
    modelId: () => 'test-model',
    executeTurnFn,
    onStatusUpdate,
  };
}

/** 轮询直到条件满足或超时 */
async function waitFor(cond: () => boolean, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(intervalMs);
  }
}

describe('SubAgentService — spawn → execute → check 生命周期', () => {
  it('单回合任务: spawn 立即返回 taskId(running), 完成后 check 返回 completed 与结果', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0 });
    const service = new SubAgentService(makeDeps(fn));

    const taskId = await service.spawn('do something');
    expect(taskId).toBeTruthy();

    const running = service.check(taskId);
    expect(running?.status).toBe('running');
    expect(running?.createdAt).toBeGreaterThan(0);
    expect(running?.completedAt).toBeUndefined();

    await waitFor(() => service.check(taskId)?.status === 'completed');
    const done = service.check(taskId);
    expect(done?.status).toBe('completed');
    expect(done?.result).toBeDefined();
    expect(done?.completedAt).toBeGreaterThanOrEqual(done!.createdAt);
    expect(service.activeCount).toBe(0);
  });

  it('多回合任务: 非空建议持续执行, 空建议后进入 completed', async () => {
    const { fn, calls } = makeExecuteTurnFn({ rounds: 2, delayMs: 5 });
    const service = new SubAgentService(makeDeps(fn));

    const taskId = await service.spawn('multi-turn goal');
    await waitFor(() => service.check(taskId)?.status === 'completed');

    expect(calls()).toBe(3); // turn-1, turn-2, 空串完成
    expect(service.check(taskId)?.status).toBe('completed');
  });

  it('check 未知 taskId 返回 null', async () => {
    const { fn } = makeExecuteTurnFn();
    const service = new SubAgentService(makeDeps(fn));
    expect(service.check('no-such-task')).toBeNull();
  });

  it('completed/failed 任务会触发 onStatusUpdate 回调', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0 });
    const updates: Array<{ taskId: string; status: SubAgentStatus }> = [];
    const service = new SubAgentService(
      makeDeps(fn, (taskId, status) => updates.push({ taskId, status })),
    );

    const taskId = await service.spawn('notify me');
    await waitFor(() => updates.some(u => u.taskId === taskId && u.status === 'completed'));

    expect(updates).toContainEqual({ taskId, status: 'completed' });
  });
});

describe('SubAgentService — 取消与异常', () => {
  it('cancel 运行中的任务: 任务转为 failed(cancelled), activeCount 归零', async () => {
    const { fn } = makeExecuteTurnFn({ abortable: true });
    const service = new SubAgentService(makeDeps(fn));

    const taskId = await service.spawn('long running');
    expect(service.activeCount).toBe(1);

    expect(service.cancel(taskId)).toBe(true);
    await waitFor(() => service.check(taskId)?.status === 'failed');

    const task = service.check(taskId);
    expect(task?.error).toBe('cancelled');
    expect(task?.completedAt).toBeGreaterThan(0);
    expect(service.activeCount).toBe(0);
  });

  it('cancel 未知 taskId 返回 false; 已完成任务返回 true 但状态不被破坏', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0 });
    const service = new SubAgentService(makeDeps(fn));
    expect(service.cancel('missing')).toBe(false);

    const taskId = await service.spawn('quick');
    await waitFor(() => service.check(taskId)?.status === 'completed');
    // 注意: cancel() 实现语义为"任务存在即返回 true"(非"已取消"),
    // 与 subagent-service.ts 注释 "found and cancelled" 有偏差, 此处锁定现状防回归
    expect(service.cancel(taskId)).toBe(true);
    expect(service.check(taskId)?.status).toBe('completed'); // 状态不被破坏
  });

  it('executeTurnFn 抛错: 任务最终 failed 并携带错误信息(重试耗尽后)', { timeout: 15_000 }, async () => {
    const { fn } = makeExecuteTurnFn({ failFrom: 1, delayMs: 0 });
    const service = new SubAgentService(makeDeps(fn));

    const taskId = await service.spawn('will fail');
    await waitFor(() => service.check(taskId)?.status === 'failed', 10_000);

    const task = service.check(taskId);
    expect(task?.error).toContain('injected failure');
    expect(task?.completedAt).toBeGreaterThan(0);
    expect(service.activeCount).toBe(0);
  });

  it('异常隔离: 同一 service 内一个任务失败不影响并行任务完成', { timeout: 15_000 }, async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0, delayMs: 5, failGoals: ['bad'] });
    const service = new SubAgentService(makeDeps(fn), 3);

    const badId = await service.spawn('bad');
    const goodId = await service.spawn('good');
    const goodId2 = await service.spawn('good2');

    await waitFor(() => service.check(badId)?.status === 'failed', 10_000);
    expect(service.check(badId)?.status).toBe('failed');
    expect(service.check(badId)?.error).toContain('injected failure');

    // 健康任务不受影响, 继续完成
    await waitFor(() => service.check(goodId)?.status === 'completed');
    await waitFor(() => service.check(goodId2)?.status === 'completed');
    expect(service.check(goodId)?.status).toBe('completed');
    expect(service.check(goodId2)?.status).toBe('completed');
    expect(service.activeCount).toBe(0);
  });
});

describe('SubAgentService — 并发上限与槽位释放', () => {
  it('超过 maxConcurrent 时 spawn 被拒绝且不阻塞已运行任务', async () => {
    const { fn } = makeExecuteTurnFn({ abortable: true, delayMs: 60_000 });
    const service = new SubAgentService(makeDeps(fn), 2);

    const id1 = await service.spawn('a');
    const id2 = await service.spawn('b');
    await expect(service.spawn('c')).rejects.toThrow(/Max concurrent subagents \(2\) reached/);

    // 已运行的两个任务不受影响
    expect(service.check(id1)?.status).toBe('running');
    expect(service.check(id2)?.status).toBe('running');
    expect(service.activeCount).toBe(2);

    service.cancel(id1);
    service.cancel(id2);
    await waitFor(() => service.activeCount === 0);
  });

  it('任务完成后并发槽释放, 可继续 spawn 新任务', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0, delayMs: 5 });
    const service = new SubAgentService(makeDeps(fn), 2);

    const id1 = await service.spawn('a');
    const id2 = await service.spawn('b');
    await waitFor(() => service.activeCount === 0);

    const id3 = await service.spawn('c'); // 槽已释放, 不再拒绝
    await waitFor(() => service.check(id3)?.status === 'completed');
    expect(service.check(id3)?.status).toBe('completed');
  });

  it('activeCount 只统计 running 状态任务', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0, delayMs: 5 });
    const service = new SubAgentService(makeDeps(fn), 2);

    expect(service.activeCount).toBe(0);
    const id = await service.spawn('x');
    expect(service.activeCount).toBe(1);
    await waitFor(() => service.activeCount === 0);
    expect(service.check(id)?.status).toBe('completed');
  });
});

describe('SubAgentService — 资源使用约束', () => {
  it('已完成任务保留在内存 map 中(现状), 需注意长时间运行的累积', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0, delayMs: 1 });
    const service = new SubAgentService(makeDeps(fn), 5);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await service.spawn(`t${i}`));
    }
    await waitFor(() => service.activeCount === 0);

    // 所有任务仍可通过 check 查询 → 说明任务未被清理(记录现状, 防止无意识回归)
    for (const id of ids) {
      expect(service.check(id)?.status).toBe('completed');
    }
  });

  it('onStatusUpdate 在并发场景下对每个任务恰好通知一次 final 状态', async () => {
    const { fn } = makeExecuteTurnFn({ rounds: 0, delayMs: 5 });
    const finalCounts = new Map<string, number>();
    const service = new SubAgentService(
      makeDeps(fn, (taskId, status) => {
        if (status !== 'running') {
          finalCounts.set(taskId, (finalCounts.get(taskId) ?? 0) + 1);
        }
      }),
      3,
    );

    const ids = await Promise.all([
      service.spawn('a'),
      service.spawn('b'),
      service.spawn('c'),
    ]);
    await waitFor(() => service.activeCount === 0);

    for (const id of ids) {
      expect(finalCounts.get(id)).toBe(1);
    }
  });
});
