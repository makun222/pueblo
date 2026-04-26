import { describe, expect, it } from 'vitest';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { InMemorySessionRepository } from '../../src/sessions/session-repository';
import { SessionService } from '../../src/sessions/session-service';

describe('session service', () => {
  it('tracks current session across create and archive operations', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const created = service.createSession('Session A');
    expect(service.getCurrentSession()?.id).toBe(created.id);

    service.archiveSession(created.id);
    expect(service.getCurrentSession()).toBeNull();
  });

  it('appends structured conversation messages to the session history', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const created = service.createSession('Session A');
    service.addUserMessage(created.id, 'Inspect the repo');
    service.addAssistantMessage(created.id, 'Repository inspection complete');

    const reloaded = service.getSession(created.id);

    expect(reloaded?.messageHistory).toHaveLength(2);
    expect(reloaded?.messageHistory[0]).toMatchObject({
      role: 'user',
      content: 'Inspect the repo',
      taskId: null,
      toolName: null,
    });
    expect(reloaded?.messageHistory[1]).toMatchObject({
      role: 'assistant',
      content: 'Repository inspection complete',
      taskId: null,
      toolName: null,
    });
  });

  it('imports session-scoped memories from another session into the active session selection', () => {
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository, memoryService);

    const source = service.createSession('Session B');
    const target = service.createSession('Session A');
    const sourceMemory = memoryService.createMemory('Turn 1', 'User: hi\n\nAssistant: hello', 'session', {
      sourceSessionId: source.id,
      tags: ['conversation-turn'],
      derivationType: 'summary',
    });

    const updated = service.importSelectedMemoriesFromSession(target.id, source.id);

    expect(updated.selectedMemoryIds).toEqual([sourceMemory.id]);
  });
});
