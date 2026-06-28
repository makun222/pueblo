// ============================================================================
// camel-agent.test.ts — CamelAgent 单元测试
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { CamelAgent } from '../camel-agent';
import type {
  CamelAgentInput,
  CamelCallback,
  CamelStatus,
  CamelTurnContext,
  ExecuteTurnInput,
  ExecuteTurnOutput,
} from '../camel-types';
import { buildCamelSystemMessages } from '../camel-prompt-builder';

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

/** 暴露 protected hasBudget() 用于测试 */
class TestableCamelAgent extends CamelAgent {
  public hasBudget(): boolean {
    return super['hasBudget']();
  }
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

  // ========================================================================
  // 扩展测试 P3 #7: retry 耗尽 — 连续 3 次失败后 error 冒泡
  // ========================================================================
  it('should exhaust retries when executeTurn fails 3 times (non-AbortError)', async () => {
    let callCount = 0;

    const executeTurn = vi.fn(async (_context: any) => {
      callCount++;
      throw new Error(`Turn error attempt ${callCount}`);
    });

    const agent = new CamelAgent(makeInput(), executeTurn);
    const result = await agent.start();

    // runTurn 内部最多重试 3 次
    expect(executeTurn).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('attempt 3');
  });

  // ========================================================================
  // 扩展测试 P3 #8: unlimited 预算策略 — hasBudget() 始终为 true
  // ========================================================================
  it('should keep hasBudget() true for unlimited strategy regardless of steps', () => {
    const agent = new TestableCamelAgent(
      makeInput({ budgetStrategy: 'unlimited', maxSteps: 2 }),
      vi.fn(),
    );

    expect(agent.hasBudget()).toBe(true);

    // 即使在多步之后 hasBudget 也不为 false
    // (注：start() 循环有硬上限 totalSteps < maxSteps 作为额外保护)
    for (let i = 0; i < 10; i++) {
      (agent as any).totalSteps = i;
      expect(agent.hasBudget()).toBe(true);
    }
  });

  // ========================================================================
  // 扩展测试 P3 #9: adaptive 预算策略 — 当前走 default 分支，等同 unlimited
  // ========================================================================
  it('should keep hasBudget() true for adaptive strategy (default fallthrough)', () => {
    const agent = new TestableCamelAgent(
      makeInput({ budgetStrategy: 'adaptive', maxSteps: 2 }),
      vi.fn(),
    );

    // adaptive 未显式实现，走 default，hasBudget 始终为 true
    expect(agent.hasBudget()).toBe(true);

    for (let i = 0; i < 5; i++) {
      (agent as any).totalSteps = i;
      expect(agent.hasBudget()).toBe(true);
    }
  });

  // ========================================================================
  // 扩展测试 P3 #10: 回调异常 — 回调抛出异常不影响主流程
  // ========================================================================
  it('should tolerate callback exceptions without affecting main flow', async () => {
    const events: string[] = [];

    const throwingCallback: CamelCallback = {
      onTurnStart: (_turn: number) => {
        events.push('onTurnStart-called');
        throw new Error('onTurnStart crash');
      },
      onTurnComplete: (_turn: number, _context: any) => {
        events.push('onTurnComplete-called');
      },
      onComplete: (_report: any) => {
        events.push('onComplete-called');
        throw new Error('onComplete crash');
      },
      onError: (_error: Error) => {
        events.push('onError-called');
        throw new Error('onError crash');
      },
    };

    const executeTurn = vi.fn().mockResolvedValueOnce({ suggestion: '' });

    const agent = new CamelAgent(
      makeInput({ callbacks: [throwingCallback], maxSteps: 1 }),
      executeTurn,
    );

    const result = await agent.start();

    // 主流程不受回调异常影响
    expect(result.status).toBe('completed');
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(events).toContain('onTurnStart-called');
    expect(events).toContain('onTurnComplete-called');
    expect(events).toContain('onComplete-called');
  });
});

// ---------------------------------------------------------------------------
// Helper: create a mock CamelTurnContext for buildCamelSystemMessages tests
// ---------------------------------------------------------------------------
function createMockContext(overrides: Record<string, unknown> = {}): CamelTurnContext {
  const data: Record<string, unknown> = { ...overrides };
  return {
    contextSummary: data,
    get: (key: string) => data[key],
    turns: [],
    taskLog: '',
    lastSuggestion: null,
    turnCount: 0,
    workBudget: 50,
  } as CamelTurnContext;
}

// ---------------------------------------------------------------------------
// buildCamelSystemMessages tests
// ---------------------------------------------------------------------------
describe('buildCamelSystemMessages', () => {
  it('should return system message with goal only', () => {
    const context = createMockContext({ goal: 'test-goal' });
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('##目标');
    expect(messages[0].content).toContain('test-goal');
  });

  it('should include role directives section', () => {
    const context = createMockContext({
      goal: 'test-goal',
      roleDirectives: ['Directive 1', 'Directive 2'],
    });
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('##角色指令');
    expect(messages[0].content).toContain('Directive 1');
    expect(messages[0].content).toContain('Directive 2');
    expect(messages[0].content).toContain('##目标');
  });

  it('should include path constraints section', () => {
    const context = createMockContext({
      goal: 'test-goal',
      targetDirectory: '/project/src',
      puebloPath: '/project/pueblo',
      skillPath: '/project/skills',
    });
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('##路径约束');
    expect(messages[0].content).toContain('- 目标仓库: /project/src');
    expect(messages[0].content).toContain('- Pueblo框架: /project/pueblo');
    expect(messages[0].content).toContain('- Skill工作空间: /project/skills');
  });

  it('should include additional prompts section', () => {
    const context = createMockContext({
      goal: 'test-goal',
      additionalPrompts: ['Prompt A', 'Prompt B'],
    });
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('##附加提示');
    expect(messages[0].content).toContain('1. Prompt A');
    expect(messages[0].content).toContain('2. Prompt B');
  });

  it('should combine all sections when all fields provided', () => {
    const context = createMockContext({
      goal: 'main-goal',
      roleDirectives: ['Be concise'],
      targetDirectory: '/repo',
      additionalPrompts: ['Extra hint'],
    });
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    expect(content).toContain('##角色指令');
    expect(content).toContain('##路径约束');
    expect(content).toContain('##附加提示');
    expect(content).toContain('##目标');
    expect(content).toContain('Be concise');
    expect(content).toContain('/repo');
    expect(content).toContain('Extra hint');
    expect(content).toContain('main-goal');
  });

  it('should return fallback message when no goal specified', () => {
    const context = createMockContext({});
    const messages = buildCamelSystemMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('No goal specified.');
  });
});
