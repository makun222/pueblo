import { memoryRecordSchema, type MemoryRecord, type MemoryScope } from '../shared/schema';

export interface CreateMemoryModelOptions {
  readonly tags?: string[];
  readonly type?: MemoryRecord['type'];
  readonly parentId?: string | null;
  readonly derivationType?: MemoryRecord['derivationType'];
  readonly summaryDepth?: number;
  readonly sourceSessionId?: string | null;
}

export function createMemoryModel(
  id: string,
  title: string,
  content: string,
  scope: MemoryScope,
  options: CreateMemoryModelOptions = {},
): MemoryRecord {
  const now = new Date().toISOString();

  return memoryRecordSchema.parse({
    id,
    type: options.type ?? 'short-term',
    title,
    content,
    scope,
    status: 'active',
    tags: options.tags ?? [],
    parentId: options.parentId ?? null,
    derivationType: options.derivationType ?? 'manual',
    summaryDepth: options.summaryDepth ?? 0,
    sourceSessionId: options.sourceSessionId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}
