import { randomUUID } from 'node:crypto';
import { RepositoryBase, buildLikePattern, fromJson, toJson, type RepositoryContext } from '../persistence/repository-base';
import { memoryRecordSchema, type MemoryRecord, type MemoryScope } from '../shared/schema';
import { createMemoryModel, type CreateMemoryModelOptions } from './memory-model';

interface MemoryRow {
  id: string;
  type: MemoryRecord['type'];
  memory_kind: MemoryRecord['memoryKind'];
  title: string;
  content: string;
  scope: MemoryRecord['scope'];
  status: MemoryRecord['status'];
  tags_json: string;
  parent_id: string | null;
  derivation_type: MemoryRecord['derivationType'];
  summary_depth: number;
  weight: number;
  last_accessed_at: string | null;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryStore {
  create(title: string, content: string, scope: MemoryScope, options?: CreateMemoryModelOptions): MemoryRecord;
  list(): MemoryRecord[];
  getById(memoryId: string): MemoryRecord | null;
  save(memory: MemoryRecord): MemoryRecord;
  search(query: string): MemoryRecord[];
}

export class InMemoryMemoryRepository implements MemoryStore {
  private readonly memories = new Map<string, MemoryRecord>();

  create(title: string, content: string, scope: MemoryScope, options: CreateMemoryModelOptions = {}): MemoryRecord {
    const memory = createMemoryModel(randomUUID(), title, content, scope, options);
    this.memories.set(memory.id, memory);
    return memory;
  }

  list(): MemoryRecord[] {
    return [...this.memories.values()];
  }

  getById(memoryId: string): MemoryRecord | null {
    return this.memories.get(memoryId) ?? null;
  }

  save(memory: MemoryRecord): MemoryRecord {
    this.memories.set(memory.id, memory);
    return memory;
  }

  search(query: string): MemoryRecord[] {
    const normalized = query.toLowerCase();
    return this.list().filter((memory) =>
      memory.title.toLowerCase().includes(normalized) || memory.content.toLowerCase().includes(normalized),
    );
  }
}

export class MemoryRepository extends RepositoryBase implements MemoryStore {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(title: string, content: string, scope: MemoryScope, options: CreateMemoryModelOptions = {}): MemoryRecord {
    const memory = createMemoryModel(randomUUID(), title, content, scope, options);
    this.save(memory);
    return memory;
  }

  list(): MemoryRecord[] {
    return this.all<MemoryRow>('SELECT * FROM memory_records ORDER BY updated_at DESC').map((row) => this.mapRow(row));
  }

  getById(memoryId: string): MemoryRecord | null {
    const row = this.get<MemoryRow>('SELECT * FROM memory_records WHERE id = ?', [memoryId]);
    return row ? this.mapRow(row) : null;
  }

  save(memory: MemoryRecord): MemoryRecord {
    const existing = this.getById(memory.id);
    const params = {
      id: memory.id,
      type: memory.type,
      memory_kind: memory.memoryKind,
      title: memory.title,
      content: memory.content,
      scope: memory.scope,
      status: memory.status,
      tags_json: toJson(memory.tags),
      parent_id: memory.parentId,
      derivation_type: memory.derivationType,
      summary_depth: memory.summaryDepth,
      weight: memory.weight,
      last_accessed_at: memory.lastAccessedAt,
      source_session_id: memory.sourceSessionId,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
    };

    if (existing) {
      this.run(
        `UPDATE memory_records
         SET type=@type, memory_kind=@memory_kind, title=@title, content=@content, scope=@scope, status=@status,
             tags_json=@tags_json, parent_id=@parent_id, derivation_type=@derivation_type,
             summary_depth=@summary_depth, weight=@weight, last_accessed_at=@last_accessed_at,
             source_session_id=@source_session_id,
             created_at=@created_at, updated_at=@updated_at
         WHERE id=@id`,
        params,
      );
    } else {
      this.run(
        `INSERT INTO memory_records (
          id, type, memory_kind, title, content, scope, status, tags_json, parent_id, derivation_type, summary_depth,
          weight, last_accessed_at, source_session_id, created_at, updated_at
        ) VALUES (
          @id, @type, @memory_kind, @title, @content, @scope, @status, @tags_json, @parent_id, @derivation_type, @summary_depth,
          @weight, @last_accessed_at, @source_session_id, @created_at, @updated_at
        )`,
        params,
      );
    }

    return memory;
  }

  search(query: string): MemoryRecord[] {
    const like = buildLikePattern(query);
    return this.all<MemoryRow>(
      `SELECT * FROM memory_records
       WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC`,
      [like, like],
    ).map((row) => this.mapRow(row));
  }

  private mapRow(row: MemoryRow): MemoryRecord {
    return memoryRecordSchema.parse({
      id: row.id,
      type: row.type,
      memoryKind: row.memory_kind,
      title: row.title,
      content: row.content,
      scope: row.scope,
      status: row.status,
      tags: fromJson<string[]>(row.tags_json),
      parentId: row.parent_id,
      derivationType: row.derivation_type,
      summaryDepth: row.summary_depth,
      weight: row.weight,
      lastAccessedAt: row.last_accessed_at,
      sourceSessionId: row.source_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
