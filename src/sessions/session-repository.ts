import { randomUUID } from 'node:crypto';
import { RepositoryBase, fromJson, toJson, type RepositoryContext } from '../persistence/repository-base';
import { sessionMessageSchema, sessionSchema, type Session, type SessionMessage } from '../shared/schema';
import { createSessionModel } from './session-model';

interface SessionRow {
  id: string;
  title: string;
  status: Session['status'];
  session_kind: Session['sessionKind'];
  agent_instance_id: string | null;
  current_model_id: string | null;
  message_history_json: string;
  selected_prompt_ids_json: string;
  selected_memory_ids_json: string;
  origin_session_id: string | null;
  trigger_reason: Session['triggerReason'];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  archived_at: string | null;
}

export interface SessionStore {
  create(title: string, currentModelId?: string | null, agentInstanceId?: string | null): Session;
  list(): Session[];
  getById(sessionId: string): Session | null;
  save(session: Session): Session;
  setCurrentSession(sessionId: string | null): void;
  getCurrentSession(): Session | null;
}

export class InMemorySessionRepository implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private currentSessionId: string | null = null;

  create(title: string, currentModelId?: string | null, agentInstanceId?: string | null): Session {
    const session = createSessionModel({
      id: randomUUID(),
      title,
      agentInstanceId: agentInstanceId ?? null,
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

  create(title: string, currentModelId?: string | null, agentInstanceId?: string | null): Session {
    const session = createSessionModel({
      id: randomUUID(),
      title,
      agentInstanceId: agentInstanceId ?? null,
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
          session_kind = @session_kind,
          agent_instance_id = @agent_instance_id,
            current_model_id = @current_model_id,
            message_history_json = @message_history_json,
            selected_prompt_ids_json = @selected_prompt_ids_json,
            selected_memory_ids_json = @selected_memory_ids_json,
          origin_session_id = @origin_session_id,
          trigger_reason = @trigger_reason,
            created_at = @created_at,
            updated_at = @updated_at,
          started_at = @started_at,
          completed_at = @completed_at,
          failed_at = @failed_at,
            archived_at = @archived_at
        WHERE id = @id
        `,
        this.toParams(session),
      );
    } else {
      this.run(
        `
        INSERT INTO sessions (
          id, title, status, session_kind, agent_instance_id, current_model_id, message_history_json,
          selected_prompt_ids_json, selected_memory_ids_json, origin_session_id, trigger_reason,
          created_at, updated_at, started_at, completed_at, failed_at, archived_at
        ) VALUES (
          @id, @title, @status, @session_kind, @agent_instance_id, @current_model_id, @message_history_json,
          @selected_prompt_ids_json, @selected_memory_ids_json, @origin_session_id, @trigger_reason,
          @created_at, @updated_at, @started_at, @completed_at, @failed_at, @archived_at
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
      sessionKind: row.session_kind,
      agentInstanceId: row.agent_instance_id ?? null,
      currentModelId: row.current_model_id,
      messageHistory: deserializeMessageHistory(row.id, row.message_history_json, row.updated_at),
      selectedPromptIds: fromJson<string[]>(row.selected_prompt_ids_json),
      selectedMemoryIds: fromJson<string[]>(row.selected_memory_ids_json),
      originSessionId: row.origin_session_id,
      triggerReason: row.trigger_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      archivedAt: row.archived_at,
    });
  }

  private toParams(session: Session) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      session_kind: session.sessionKind,
      agent_instance_id: session.agentInstanceId,
      current_model_id: session.currentModelId,
      message_history_json: toJson(session.messageHistory),
      selected_prompt_ids_json: toJson(session.selectedPromptIds),
      selected_memory_ids_json: toJson(session.selectedMemoryIds),
      origin_session_id: session.originSessionId,
      trigger_reason: session.triggerReason,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      started_at: session.startedAt,
      completed_at: session.completedAt,
      failed_at: session.failedAt,
      archived_at: session.archivedAt,
    };
  }
}

function deserializeMessageHistory(sessionId: string, serializedHistory: string, fallbackTimestamp: string): SessionMessage[] {
  const parsed = fromJson<unknown[]>(serializedHistory);

  return parsed.flatMap((entry, index) => {
    const structuredMessage = sessionMessageSchema.safeParse(entry);
    if (structuredMessage.success) {
      return [structuredMessage.data];
    }

    if (typeof entry !== 'string') {
      return [];
    }

    const content = entry.trim();
    if (!content) {
      return [];
    }

    return [sessionMessageSchema.parse({
      id: `${sessionId}-legacy-${index + 1}`,
      role: 'system',
      content,
      createdAt: fallbackTimestamp,
      taskId: null,
      toolName: null,
    })];
  });
}
