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
  });
});