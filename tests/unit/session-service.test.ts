import { describe, expect, it } from 'vitest';
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
});
