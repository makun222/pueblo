import { describe, it, expect, vi } from 'vitest';
import { LoopRunner } from '../../src/agent/loop-runner.js';
import { LoopJobManager } from '../../src/agent/loop-job-manager.js';

describe('LoopRunner', () => {
  it('parses --goal and --max-rounds correctly via createLoopCommand', async () => {
    // 验证 createLoopCommand 能正确解析参数
    const { createLoopCommand } = await import('../../src/commands/loop-command.js');
    const mockTaskRunner = { run: vi.fn() } as any;
    const mockContextResolver = { resolve: vi.fn() } as any;
    const mockSessionService = {} as any;

    const handler = createLoopCommand({
      taskRunner: mockTaskRunner,
      contextResolver: mockContextResolver,
      sessionService: mockSessionService,
    });

    // 模拟输入: /loop --goal="写一个斐波那契函数" --max-rounds=3
    const result = await handler({
      type: 'message',
      text: '/loop --goal="写一个斐波那契函数" --max-rounds=3',
      sessionId: 'test-session',
      userId: 'test-user',
    });

    expect(result.code).toBe('LOOP_COMPLETED');
    expect(result.data).toHaveProperty('goal', '写一个斐波那契函数');
    expect(result.data).toHaveProperty('maxRounds', 3);
  });

  it('runs maxRounds iterations and accumulates context', async () => {
    const manager = new LoopJobManager();
    const runRoundMock = vi.fn();
    
    // 第1轮返回初始斐波那契代码
    runRoundMock.mockResolvedValueOnce({
      output: 'function fibonacci(n) { if (n <= 1) return n; return fibonacci(n-1) + fibonacci(n-2); }',
      tokenUsage: 150,
    });
    // 第2轮返回优化后的代码
    runRoundMock.mockResolvedValueOnce({
      output: 'function fibonacci(n) {\n  if (n <= 1) return n;\n  let a = 0, b = 1;\n  for (let i = 2; i <= n; i++) {\n    [a, b] = [b, a + b];\n  }\n  return b;\n}',
      tokenUsage: 200,
    });
    // 第3轮返回带测试的代码
    runRoundMock.mockResolvedValueOnce({
      output: '// 斐波那契数列\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  let a = 0, b = 1;\n  for (let i = 2; i <= n; i++) {\n    [a, b] = [b, a + b];\n  }\n  return b;\n}\n\n// 测试\nconsole.log(fibonacci(10)); // 55',
      tokenUsage: 250,
    });

    const runner = new LoopRunner({
      goal: '写一个斐波那契函数',
      maxRounds: 3,
      loopJobManager: manager,
      runRound: runRoundMock,
      signal: new AbortController().signal,
    });

    const result = await runner.run();

    // 验证运行了3轮
    expect(runRoundMock).toHaveBeenCalledTimes(3);
    expect(result.roundsCompleted).toBe(3);
    
    // 验证累计Token
    expect(result.totalTokenUsage).toBe(600); // 150 + 200 + 250

    // 验证最终输出包含最终轮次的内容
    expect(result.output).toContain('fibonacci');
    expect(result.output).toContain('55');

    // 验证每轮的config传递正确
    const firstCallArgs = runRoundMock.mock.calls[0][0];
    expect(firstCallArgs.round).toBe(1);
    expect(firstCallArgs.goal).toBe('写一个斐波那契函数');
    expect(firstCallArgs.maxRounds).toBe(3);

    // 验证第二轮收到了第一轮的上下文
    const secondCallArgs = runRoundMock.mock.calls[1];
    expect(secondCallArgs[0].round).toBe(2);
    expect(secondCallArgs[1]!.output).toContain('fibonacci'); // prevResult
  });

  it('respects maxRounds=1 (single round)', async () => {
    const manager = new LoopJobManager();
    const runRoundMock = vi.fn().mockResolvedValue({
      output: 'function add(a, b) { return a + b; }',
      tokenUsage: 50,
    });

    const runner = new LoopRunner({
      goal: '写一个加法函数',
      maxRounds: 1,
      loopJobManager: manager,
      runRound: runRoundMock,
      signal: new AbortController().signal,
    });

    const result = await runner.run();
    expect(runRoundMock).toHaveBeenCalledTimes(1);
    expect(result.roundsCompleted).toBe(1);
    expect(result.output).toContain('add');
  });

  it('supports cancellation via AbortSignal', async () => {
    const manager = new LoopJobManager();
    const ac = new AbortController();
    const runRoundMock = vi.fn().mockImplementation(async (_config: any, _prev: any, signal: AbortSignal) => {
      // 模拟长时间运行的任务
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      return { output: 'never', tokenUsage: 0 };
    });

    const runner = new LoopRunner({
      goal: '测试取消',
      maxRounds: 5,
      loopJobManager: manager,
      runRound: runRoundMock,
      signal: ac.signal,
    });

    // 在启动后立即取消
    const runPromise = runner.run();
    ac.abort();

    await expect(runPromise).rejects.toThrow('Aborted');
  });
});
