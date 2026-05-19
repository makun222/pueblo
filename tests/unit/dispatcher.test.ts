import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher, tokenizeCommandInput } from '../../src/commands/dispatcher';
import { successResult } from '../../src/shared/result';

describe('tokenizeCommandInput', () => {
  it('preserves quoted arguments with spaces', () => {
    expect(tokenizeCommandInput('/talkto 41234 -m "hello from agent a"')).toEqual([
      '/talkto',
      '41234',
      '-m',
      'hello from agent a',
    ]);
  });

  it('supports single quotes and escaped quotes', () => {
    expect(tokenizeCommandInput("/talkto 41234 -m 'say \"hello\" first'")).toEqual([
      '/talkto',
      '41234',
      '-m',
      'say "hello" first',
    ]);
  });
});

describe('CommandDispatcher', () => {
  it('passes parsed quoted args to handlers', async () => {
    const dispatcher = new CommandDispatcher();
    const handler = vi.fn(async () => successResult('TALK_OK', 'ok'));
    dispatcher.register('/talkto', handler);

    const result = await dispatcher.dispatch({
      input: '/talkto 41234 -m "hello from agent a"',
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith(['41234', '-m', 'hello from agent a']);
  });
});