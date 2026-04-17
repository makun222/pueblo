import { describe, expect, it } from 'vitest';
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
});
