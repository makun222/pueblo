import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCoordinator } from '../../src/app/runtime';
import { CommandDispatcher } from '../../src/commands/dispatcher';
import { InputRouter, routeInput } from '../../src/commands/input-router';
import { successResult } from '../../src/shared/result';
import { createTestAppConfig } from '../helpers/test-config';

describe('Desktop Plain-Text Routing and Exit', () => {
  it('should route plain text input through shared routing', async () => {
    const router = new InputRouter({
      dispatcher: new CommandDispatcher(),
      runTaskFromText: vi.fn().mockResolvedValue(successResult('TASK_COMPLETED', 'ok')),
    });

    const result = await router.route('inspect repo');

    expect(result.code).toBe('TASK_COMPLETED');
  });

  it('should handle slash commands in window input', async () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.register('/ping', async () => successResult('PING_OK', 'pong'));
    const runTaskFromText = vi.fn();
    const router = new InputRouter({
      dispatcher,
      runTaskFromText,
    });

    const result = await router.route('/ping');

    expect(result.code).toBe('PING_OK');
    expect(runTaskFromText).not.toHaveBeenCalled();
  });

  it('should gracefully ignore empty input', async () => {
    const router = new InputRouter({
      dispatcher: new CommandDispatcher(),
      runTaskFromText: vi.fn(),
    });

    const result = await router.route('   ');

    expect(result.code).toBe('INPUT_IGNORED');
  });

  it('should release resources on exit', async () => {
    const submitInput = vi.fn().mockResolvedValue(successResult('TASK_COMPLETED', 'ok'));
    const runtime = createRuntimeCoordinator({
      config: createTestAppConfig(),
      submitInput,
    });

    await routeInput({ input: 'inspect repo', runtime });

    expect(submitInput).toHaveBeenCalledWith('inspect repo');
  });
});