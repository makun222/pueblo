import type { Session } from '../shared/schema';
import type { SessionStore } from './session-repository';

export class SessionQueries {
  constructor(private readonly repository: SessionStore) {}

  listSessions(): Session[] {
    return this.repository.list();
  }

  getCurrentSession(): Session | null {
    return this.repository.getCurrentSession();
  }
}
