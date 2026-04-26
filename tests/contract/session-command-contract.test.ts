import { describe, expect, it } from 'vitest';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { SessionService } from '../../src/sessions/session-service';
import { InMemorySessionRepository } from '../../src/sessions/session-repository';

describe('session command contract', () => {
  it('creates and lists sessions with current-state visibility', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const created = service.createSession('First session');
    const sessions = service.listSessions();

    expect(created.status).toBe('active');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(created.id);
  });

  it('can import memory selections from another session', () => {
    const memoryService = new MemoryService(new InMemoryMemoryRepository());
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository, memoryService);

    const source = service.createSession('Source session');
    const target = service.createSession('Target session');
    const memory = memoryService.createMemory('Turn 1', 'User: inspect\n\nAssistant: done', 'session', {
      sourceSessionId: source.id,
      tags: ['conversation-turn'],
      derivationType: 'summary',
    });

    const imported = service.importSelectedMemoriesFromSession(target.id, source.id);

    expect(imported.selectedMemoryIds).toEqual([memory.id]);
  });
});
