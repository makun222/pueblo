import { randomUUID } from 'node:crypto';
import { RepositoryBase, fromJson, toJson, type RepositoryContext } from '../persistence/repository-base';
import { sessionSchema, type Session } from '../shared/schema';
import { createSessionModel } from './session-model';

interface SessionRow {
  id: string;
  title: string;
  status: Session['status'];
  current_model_id: string | null;
  message_history_json: string;
  selected_prompt_ids_json: string;
  selected_memory_ids_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SessionStore {
  create(title: string, currentModelId?: string | null): Session;
  list(): Session[];
  getById(sessionId: string): Session | null;
  save(session: Session): Session;
  setCurrentSession(sessionId: string | null): void;
  getCurrentSession(): Session | null;
}

export class InMemorySessionRepository implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private currentSessionId: string | null = null;

  create(title: string, currentModelId?: string | null): Session {
    const session = createSessionModel({
      id: randomUUID(),
      title,
      currentModelId: currentModelId ?? null,
    });

    this.sessions.set(session.id, session);
    this.currentSessionId = session.id;
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  getById(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  save(session: Session): Session {
    this.sessions.set(session.id, session);
    const isActive = session.status === 'active';

    if (isActive) {
      this.currentSessionId = session.id;
    } else if (this.currentSessionId === session.id) {
      this.currentSessionId = null;
    }

    return session;
  }

  setCurrentSession(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) {
      return null;
    }

    return this.sessions.get(this.currentSessionId) ?? null;
  }
}

export class SessionRepository extends RepositoryBase implements SessionStore {
  private currentSessionId: string | null = null;

  constructor(context: RepositoryContext) {
    super(context);
  }

  create(title: string, currentModelId?: string | null): Session {
    const session = createSessionModel({
      id: randomUUID(),
      title,
      currentModelId: currentModelId ?? null,
    });

    this.save(session);
    this.currentSessionId = session.id;
    return session;
  }

  list(): Session[] {
    const rows = this.all<SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC');
    return rows.map((row) => this.mapRow(row));
  }

  getById(sessionId: string): Session | null {
    const row = this.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    return row ? this.mapRow(row) : null;
  }

  save(session: Session): Session {
    const existing = this.getById(session.id);

    if (existing) {
      this.run(
        `
        UPDATE sessions
        SET title = @title,
            status = @status,
            current_model_id = @current_model_id,
            message_history_json = @message_history_json,
            selected_prompt_ids_json = @selected_prompt_ids_json,
            selected_memory_ids_json = @selected_memory_ids_json,
            created_at = @created_at,
            updated_at = @updated_at,
            archived_at = @archived_at
        WHERE id = @id
        `,
        this.toParams(session),
      );
    } else {
      this.run(
        `
        INSERT INTO sessions (
          id, title, status, current_model_id, message_history_json,
          selected_prompt_ids_json, selected_memory_ids_json, created_at, updated_at, archived_at
        ) VALUES (
          @id, @title, @status, @current_model_id, @message_history_json,
          @selected_prompt_ids_json, @selected_memory_ids_json, @created_at, @updated_at, @archived_at
        )
        `,
        this.toParams(session),
      );
    }

    return session;
  }

  setCurrentSession(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) {
      const firstActive = this.list().find((session) => session.status === 'active') ?? null;
      this.currentSessionId = firstActive?.id ?? null;
      return firstActive;
    }

    return this.getById(this.currentSessionId);
  }

  private mapRow(row: SessionRow): Session {
    return sessionSchema.parse({
      id: row.id,
      title: row.title,
      status: row.status,
      currentModelId: row.current_model_id,
      messageHistory: fromJson<string[]>(row.message_history_json),
      selectedPromptIds: fromJson<string[]>(row.selected_prompt_ids_json),
      selectedMemoryIds: fromJson<string[]>(row.selected_memory_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    });
  }

  private toParams(session: Session) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      current_model_id: session.currentModelId,
      message_history_json: toJson(session.messageHistory),
      selected_prompt_ids_json: toJson(session.selectedPromptIds),
      selected_memory_ids_json: toJson(session.selectedMemoryIds),
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      archived_at: session.archivedAt,
    };
  }
}
