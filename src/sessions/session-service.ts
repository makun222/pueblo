import type { Session } from '../shared/schema';
import { SessionCommandError } from '../commands/command-errors';
import { SessionQueries } from './session-queries';
import type { SessionStore } from './session-repository';

export class SessionService {
  private readonly queries: SessionQueries;

  constructor(private readonly repository: SessionStore) {
    this.queries = new SessionQueries(repository);
  }

  createSession(title?: string, currentModelId?: string | null): Session {
    const resolvedTitle = title?.trim() || 'Untitled session';
    const session = this.repository.create(resolvedTitle, currentModelId ?? null);
    this.repository.setCurrentSession(session.id);
    return session;
  }

  listSessions(): Session[] {
    return this.queries.listSessions();
  }

  selectSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be selected');
    }

    const updated = this.updateSession(session, {
      status: 'active',
      archivedAt: null,
    });
    this.repository.setCurrentSession(updated.id);
    return updated;
  }

  archiveSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be archived');
    }

    const updated = this.updateSession(session, {
      status: 'archived',
      archivedAt: new Date().toISOString(),
    });

    if (this.repository.getCurrentSession()?.id === updated.id) {
      this.repository.setCurrentSession(null);
    }

    return updated;
  }

  restoreSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be restored');
    }

    const updated = this.updateSession(session, {
      status: 'active',
      archivedAt: null,
    });
    this.repository.setCurrentSession(updated.id);
    return updated;
  }

  deleteSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);
    const updated = this.updateSession(session, {
      status: 'deleted',
      archivedAt: session.archivedAt,
    });

    if (this.repository.getCurrentSession()?.id === updated.id) {
      this.repository.setCurrentSession(null);
    }

    return updated;
  }

  setCurrentModel(sessionId: string, modelId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      currentModelId: modelId,
    });
  }

  getSession(sessionId: string): Session | null {
    return this.repository.getById(sessionId);
  }

  addSelectedPrompt(sessionId: string, promptId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: uniqueValues([...session.selectedPromptIds, promptId]),
    });
  }

  removeSelectedPrompt(sessionId: string, promptId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: session.selectedPromptIds.filter((id) => id !== promptId),
    });
  }

  setSelectedPromptIds(sessionId: string, promptIds: string[]): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: uniqueValues(promptIds),
    });
  }

  addSelectedMemory(sessionId: string, memoryId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: uniqueValues([...session.selectedMemoryIds, memoryId]),
    });
  }

  removeSelectedMemory(sessionId: string, memoryId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: session.selectedMemoryIds.filter((id) => id !== memoryId),
    });
  }

  setSelectedMemoryIds(sessionId: string, memoryIds: string[]): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: uniqueValues(memoryIds),
    });
  }

  getCurrentSession(): Session | null {
    return this.queries.getCurrentSession();
  }

  private requireSession(sessionId: string): Session {
    const session = this.repository.getById(sessionId);

    if (!session) {
      throw new SessionCommandError(`Session not found: ${sessionId}`);
    }

    return session;
  }

  private updateSession(session: Session, patch: Partial<Session>): Session {
    const updated: Session = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    return this.repository.save(updated);
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}
