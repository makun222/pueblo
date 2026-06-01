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
    expect(updated.pinnedMemoryIds).toEqual([sourceMemory.id]);
    expect(updated.workingMemoryIds).toEqual([]);
  });

  it('keeps pinned and working memory selections separate while exposing a union', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const session = service.createSession('Session A');
    service.addPinnedMemory(session.id, 'memory-pinned');
    service.addWorkingMemory(session.id, 'memory-working-1');
    service.addWorkingMemory(session.id, 'memory-working-2');

    const reloaded = service.getSession(session.id);

    expect(reloaded?.pinnedMemoryIds).toEqual(['memory-pinned']);
    expect(reloaded?.workingMemoryIds).toEqual(['memory-working-1', 'memory-working-2']);
    expect(reloaded?.selectedMemoryIds).toEqual(['memory-pinned', 'memory-working-1', 'memory-working-2']);
  });

  it('returns the most recent non-deleted session for an agent instance', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const first = service.createSession('Session A', null, 'agent-1');
    const second = service.createSession('Session B', null, 'agent-1');
    const third = service.createSession('Session C', null, 'agent-2');

    service.archiveSession(first.id);
    service.deleteSession(second.id);
    service.addUserMessage(third.id, 'keep agent-2 fresh');

    expect(service.getMostRecentSessionForAgentInstance('agent-1')?.id).toBe(first.id);
    expect(service.getMostRecentSessionForAgentInstance('agent-2')?.id).toBe(third.id);
    expect(service.getMostRecentSessionForAgentInstance('missing-agent')).toBeNull();
  });

  it('lists lightweight session summaries with preview and counts', () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);

    const session = service.createSession('Session A', null, 'agent-1');
    service.addUserMessage(session.id, 'Inspect the repo');
    service.addAssistantMessage(session.id, 'Repository inspection complete');
    service.addPinnedMemory(session.id, 'memory-1');
    service.addWorkingMemory(session.id, 'memory-2');

    const summaries = service.listSessionSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: session.id,
      agentInstanceId: 'agent-1',
      messageCount: 2,
      selectedMemoryCount: 2,
      preview: 'Pueblo: Repository inspection complete',
    });
  });
});
