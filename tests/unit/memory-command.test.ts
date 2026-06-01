import { describe, expect, it, vi } from 'vitest';
import { createMemoryListCommand, createMemoryWeightCommand } from '../../src/commands/memory-command';

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

  it('updates a memory weight through the command surface', () => {
    const setMemoryWeight = vi.fn().mockReturnValue({ id: 'memory-1', weight: 0.75 });
    const command = createMemoryWeightCommand({
      memoryService: {
        setMemoryWeight,
      } as never,
      sessionService: {} as never,
      getCurrentSessionId: () => 'session-1',
    });

    const result = command(['memory-1', 'set', '0.75']);

    expect(result.ok).toBe(true);
    expect(result.code).toBe('MEMORY_WEIGHT_UPDATED');
    expect(setMemoryWeight).toHaveBeenCalledWith('memory-1', 0.75);
  });
});