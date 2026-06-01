import type { AgentSessionSummary, Session } from '../shared/schema';
import type { SessionStore } from './session-repository';

export class SessionQueries {
  constructor(private readonly repository: SessionStore) {}

  listSessions(): Session[] {
    return this.repository.list();
  }

  listSessionSummaries(): AgentSessionSummary[] {
    return this.repository.listSummaries();
  }

  getCurrentSession(): Session | null {
    return this.repository.getCurrentSession();
  }
}
