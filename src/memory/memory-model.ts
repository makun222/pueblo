import { createHash } from 'node:crypto';
import { memoryRecordSchema, type MemoryRecord, type MemoryScope } from '../shared/schema';

export interface CreateMemoryModelOptions {
  readonly tags?: string[];
  readonly type?: MemoryRecord['type'];
  readonly memoryKind?: MemoryRecord['memoryKind'];
  readonly parentId?: string | null;
  readonly derivationType?: MemoryRecord['derivationType'];
  readonly summaryDepth?: number;
  readonly weight?: number;
  readonly lastAccessedAt?: string | null;
  readonly sourceSessionId?: string | null;
  //readonly usageLocation?: UsageLocation | null;
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
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
    memoryKind: options.memoryKind ?? 'generic',
    title,
    content,
    contentHash: computeContentHash(content),
    scope,
    status: 'active',
    tags: options.tags ?? [],
    parentId: options.parentId ?? null,
    derivationType: options.derivationType ?? 'manual',
    summaryDepth: options.summaryDepth ?? 0,
    weight: options.weight ?? 0,
    lastAccessedAt: options.lastAccessedAt ?? now,
    sourceSessionId: options.sourceSessionId ?? null,
    //usageLocation: options.usageLocation ?? null,
    createdAt: now,
    updatedAt: now,
  });
}
