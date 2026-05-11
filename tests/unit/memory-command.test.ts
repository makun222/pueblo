import { describe, expect, it, vi } from 'vitest';
import { createMemoryListCommand } from '../../src/commands/memory-command';

describe('memory command', () => {
  it('lists only memories for the current session', () => {
    const listSessionMemories = vi.fn().mockReturnValue([
      { id: 'memory-session-1', sourceSessionId: 'session-1' },
    ]);
    const command = createMemoryListCommand({
      memoryService: {
        listSessionMemories,
      } as never,
      sessionService: {} as never,
      getCurrentSessionId: () => 'session-1',
    });

    const result = command();

    expect(result.ok).toBe(true);
    expect(result.code).toBe('MEMORY_LIST');
    expect(listSessionMemories).toHaveBeenCalledWith('session-1');
    expect(result.data).toEqual({
      memories: [{ id: 'memory-session-1', sourceSessionId: 'session-1' }],
    });
  });

  it('requires an active session before listing memories', () => {
    const listSessionMemories = vi.fn();
    const command = createMemoryListCommand({
      memoryService: {
        listSessionMemories,
      } as never,
      sessionService: {} as never,
      getCurrentSessionId: () => null,
    });

    const result = command();

    expect(result.ok).toBe(false);
    expect(result.code).toBe('SESSION_REQUIRED');
    expect(listSessionMemories).not.toHaveBeenCalled();
  });
});