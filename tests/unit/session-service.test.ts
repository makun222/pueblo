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
});
