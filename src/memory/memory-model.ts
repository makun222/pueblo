import { memoryRecordSchema, type MemoryRecord, type MemoryScope } from '../shared/schema';

export function createMemoryModel(id: string, title: string, content: string, scope: MemoryScope): MemoryRecord {
  const now = new Date().toISOString();

  return memoryRecordSchema.parse({
    id,
    type: 'short-term',
    title,
    content,
    scope,
    status: 'active',
    tags: [],
    sourceSessionId: null,
    createdAt: now,
    updatedAt: now,
  });
}
