import { describe, expect, it } from 'vitest';
import { sessionSchema } from '../../src/shared/schema';

describe('session schema compatibility', () => {
  it('normalizes missing agentInstanceId to null for legacy session records', () => {
    const session = sessionSchema.parse({
      id: 'session-1',
      title: 'Legacy session',
      status: 'active',
      sessionKind: 'user',
      currentModelId: null,
      messageHistory: [],
      selectedPromptIds: [],
      selectedMemoryIds: [],
      originSessionId: null,
      triggerReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      archivedAt: null,
    });

    expect(session.agentInstanceId).toBeNull();
    expect(session.pinnedMemoryIds).toEqual([]);
    expect(session.workingMemoryIds).toEqual([]);
  });

  it('hydrates legacy selectedMemoryIds into pinned memory ids when split fields are missing', () => {
    const session = sessionSchema.parse({
      id: 'session-2',
      title: 'Legacy memory session',
      status: 'active',
      sessionKind: 'user',
      currentModelId: null,
      messageHistory: [],
      selectedPromptIds: [],
      selectedMemoryIds: ['memory-1', 'memory-2'],
      originSessionId: null,
      triggerReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      archivedAt: null,
    });

    expect(session.pinnedMemoryIds).toEqual(['memory-1', 'memory-2']);
    expect(session.workingMemoryIds).toEqual([]);
    expect(session.selectedMemoryIds).toEqual(['memory-1', 'memory-2']);
  });

  it('keeps explicit empty pinned ids when working ids are present', () => {
    const session = sessionSchema.parse({
      id: 'session-3',
      title: 'Layered session',
      status: 'active',
      sessionKind: 'user',
      currentModelId: null,
      messageHistory: [],
      selectedPromptIds: [],
      pinnedMemoryIds: [],
      workingMemoryIds: ['memory-working'],
      selectedMemoryIds: ['memory-working'],
      originSessionId: null,
      triggerReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      archivedAt: null,
    });

    expect(session.pinnedMemoryIds).toEqual([]);
    expect(session.workingMemoryIds).toEqual(['memory-working']);
    expect(session.selectedMemoryIds).toEqual(['memory-working']);
  });
});