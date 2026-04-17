import { describe, expect, it, vi } from 'vitest';
import { InputRouter, routeInput } from '../../src/commands/input-router';
import { successResult } from '../../src/shared/result';

describe('input router', () => {
  it('routes trimmed plain text to task execution', async () => {
    const runTaskFromText = vi.fn().mockResolvedValue(successResult('TASK_COMPLETED', 'ok'));
    const dispatcher = { dispatch: vi.fn() };
    const router = new InputRouter({
      dispatcher: dispatcher as never,
      runTaskFromText,
    });

    const result = await router.route('  inspect repo  ');

    expect(result.code).toBe('TASK_COMPLETED');
    expect(runTaskFromText).toHaveBeenCalledWith('inspect repo');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('routes slash commands to the dispatcher', async () => {
    const dispatch = vi.fn().mockResolvedValue(successResult('PING_OK', 'pong'));
    const router = new InputRouter({
      dispatcher: { dispatch } as never,
      runTaskFromText: vi.fn(),
    });

    const result = await router.route('  /ping  ');

    expect(result.code).toBe('PING_OK');
    expect(dispatch).toHaveBeenCalledWith({ input: '/ping' });
  });

  it('delegates routeInput to runtime.submitInput', async () => {
    const submitInput = vi.fn().mockResolvedValue(successResult('TASK_COMPLETED', 'ok'));

    const result = await routeInput({
      input: 'inspect repo',
      runtime: { submitInput } as never,
    });

    expect(result.code).toBe('TASK_COMPLETED');
    expect(submitInput).toHaveBeenCalledWith('inspect repo');
  });
});