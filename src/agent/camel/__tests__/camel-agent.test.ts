// ============================================================================
// camel-agent.test.ts — CamelAgent 单元测试
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { CamelAgent } from '../camel-agent';
import type {
  CamelAgentInput,
  CamelCallback,
  CamelStatus,
  ExecuteTurnInput,
  ExecuteTurnOutput,
} from '../camel-types';

/** 创建一个可预测的 mock executeTurn 函数 */
function mockExecuteTurn(
  suggestions: string[],
): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async (_input: ExecuteTurnInput): Promise<ExecuteTurnOutput> => {
    const suggestion = index < suggestions.length ? suggestions[index++] : '';
    return { suggestion, context: _input.context, turn: { messages: [], suggestion } };
  });
}

/** 创建一个标准的 CamelAgentInput 工厂 */
function makeInput(
  overrides: Partial<CamelAgentInput> = {},
): CamelAgentInput {
  return {
    goal: 'test goal',
    sessionId: 'test-session',
    providerId: 'test-provider',
    modelId: 'test-model',
    ...overrides,
  };
}

// ============================================================================
// 测试用例
// ============================================================================

describe('CamelAgent', () => {
  // --------------------------------------------------------------------------
  // 1. 正常完成单轮执行
  // --------------------------------------------------------------------------
  it('should complete normally when executeTurn returns empty suggestion', async () => {
    const executeTurn = mockExecuteTurn(['']);
    const agent = new CamelAgent(makeInput(), executeTurn);

    const report = await agent.start();

    expect(report.status).toBe('completed');
    expect(report.result).toBe('');
    expect(report.totalSteps).toBe(1);
    expect(report.totalTurns).toBe(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // 2. 预算耗尽自动完成
  // --------------------------------------------------------------------------
  it('should complete when budget is exhausted', async () => {
    // budgetLimit = 1, so after 1 turn the budget is 0
    const executeTurn = mockExecuteTurn(['keep going', '']);
    const agent = new CamelAgent(
      makeInput({ budgetLimit: 1, budgetStrategy: 'fixed' }),
      executeTurn,
    );

    const report = await agent.start();

    // Only 1 turn should execute because budget is exhausted after that
    expect(report.status).toBe('completed');
    expect(report.totalSteps).toBe(1);
    expect(report.totalTurns).toBe(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // 3. 外部信号取消
  // --------------------------------------------------------------------------
  it('should cancel when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted

    const executeTurn = mockExecuteTurn(['should not run']);
    const agent = new CamelAgent(
      makeInput({ signal: controller.signal }),
      executeTurn,
    );

    const report = await agent.start();

    expect(report.status).toBe('cancelled');
    expect(report.result).toBeNull();
    expect(report.totalSteps).toBe(0);
    expect(report.totalTurns).toBe(0);
    // executeTurn should not have been called
    expect(executeTurn).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 4. executeTurn 抛出异常
  // --------------------------------------------------------------------------
  it('should fail when executeTurn rejects', async () => {
    const error = new Error('LLM failure');
    const executeTurn = vi.fn(async () => {
      throw error;
    });

    const agent = new CamelAgent(makeInput(), executeTurn);

    const report = await agent.start();

    expect(report.status).toBe('failed');
    expect(report.result).toBeNull();
    expect(report.totalSteps).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 5. maxSteps 限制
  // --------------------------------------------------------------------------
  it('should stop at maxSteps limit', async () => {
    // maxSteps = 1, return non-empty suggestion to keep looping
    const executeTurn = mockExecuteTurn(['step 1', 'step 2', 'step 3']);
    const agent = new CamelAgent(
      makeInput({ maxSteps: 1 }),
      executeTurn,
    );

    const report = await agent.start();

    expect(report.status).toBe('completed');
    expect(report.totalSteps).toBe(1);
    expect(report.totalTurns).toBe(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // 6. 回调调度验证
  // --------------------------------------------------------------------------
  it('should invoke callbacks in correct order', async () => {
    const events: string[] = [];
    const callbacks: CamelCallback = {
      onStatusChange: (status: CamelStatus) => {
        events.push(`status:${status}`);
      },
      onTurnStart: (turn: number) => {
        events.push(`turnStart:${turn}`);
      },
      onTurnComplete: (turn: number) => {
        events.push(`turnComplete:${turn}`);
      },
      onError: (_error: Error) => {
        events.push('error');
      },
      onComplete: (_report: unknown) => {
        events.push('complete');
      },
    };

    const executeTurn = mockExecuteTurn(['']);
    const agent = new CamelAgent(
      makeInput({ callbacks: [callbacks] }),
      executeTurn,
    );

    await agent.start();

    expect(events).toEqual([
      'status:running',
      'turnStart:1',
      'turnComplete:1',
      'complete',
      'status:completed',
    ]);
  });
});
