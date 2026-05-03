import type { MemoryRecord, PepeResultItem } from '../shared/schema';

export const LOCAL_VECTOR_VERSION = 'pepe-local-v1';
const VECTOR_DIMENSION = 256;
const RECENT_STICKY_WINDOW = 6;
const STICKY_MEMORY_BONUS = 0.08;
const STICKY_RETENTION_DELTA = 0.2;
const MIN_RETENTION_SIMILARITY = 0.35;
const STICKY_DECAY_FACTOR = 0.6;
const RELATED_MEMORY_WEIGHT_FACTOR = 0.75;

export interface RankedMemoryCandidate {
  readonly memoryId: string | null;
  readonly parentMemoryId: string | null;
  readonly summary: string;
  readonly similarity: number;
  readonly sourceSessionId: string | null;
  readonly vectorVersion: string;
}

export interface RankMemoryCandidatesInput {
  readonly memories: MemoryRecord[];
  readonly pendingUserInput?: string;
  readonly resultTopK: number;
  readonly similarityThreshold: number;
  readonly summaryOverrides?: ReadonlyMap<string, string>;
  readonly selectedMemoryIds?: string[];
}

export function buildQueryText(pendingUserInput?: string): string {
  const trimmed = pendingUserInput?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'session memory context';
}

export function fingerprintInput(queryText: string, memoryIds: string[]): string {
  return `${queryText}::${memoryIds.join(',')}`;
}

export function rankMemoryCandidates(input: RankMemoryCandidatesInput): RankedMemoryCandidate[] {
  const queryText = buildQueryText(input.pendingUserInput);
  const queryVector = vectorizeWithLocalHash(queryText);
  const entries = input.memories
    .map((memory) => {
      const overrideSummary = input.summaryOverrides?.get(memory.id);
      const summary = overrideSummary ?? summarizeMemory(memory);
      return {
        memory,
        summary,
        similarity: cosineSimilarity(queryVector, vectorizeWithLocalHash(summary)),
      };
    });

  return finalizeRankedCandidates({
    entries,
    memories: input.memories,
    resultTopK: input.resultTopK,
    similarityThreshold: input.similarityThreshold,
    selectedMemoryIds: input.selectedMemoryIds,
    vectorVersion: LOCAL_VECTOR_VERSION,
  });
}

export function summarizeMemory(memory: MemoryRecord): string {
  const normalizedLines = memory.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);

  const body = normalizedLines.join(' ');
  const summary = body.length > 220 ? `${body.slice(0, 217)}...` : body;
  return `${memory.title}: ${summary}`;
}

export function toPepeResultItem(candidate: RankedMemoryCandidate, memoryId: string): PepeResultItem {
  return {
    memoryId,
    summary: candidate.summary,
    similarity: candidate.similarity,
    sourceSessionId: candidate.sourceSessionId,
    vectorVersion: candidate.vectorVersion,
  };
}

export async function rankMemoryCandidatesWithVectors(args: {
  readonly memories: MemoryRecord[];
  readonly pendingUserInput?: string;
  readonly resultTopK: number;
  readonly similarityThreshold: number;
  readonly summaryOverrides?: ReadonlyMap<string, string>;
  readonly selectedMemoryIds?: string[];
  readonly vectors: number[][];
  readonly vectorVersion: string;
}): Promise<RankedMemoryCandidate[]> {
  const summaries = args.memories.map((memory) => args.summaryOverrides?.get(memory.id) ?? summarizeMemory(memory));
  const expectedVectorCount = summaries.length + 1;
  if (args.vectors.length !== expectedVectorCount) {
    throw new Error(`Expected ${expectedVectorCount} vectors for query + summaries, received ${args.vectors.length}`);
  }

  const entries = args.memories.map((memory, index) => ({
    memory,
    summary: summaries[index]!,
    similarity: cosineSimilarity(args.vectors[0]!, args.vectors[index + 1]!),
  }));

  return finalizeRankedCandidates({
    entries,
    memories: args.memories,
    resultTopK: args.resultTopK,
    similarityThreshold: args.similarityThreshold,
    selectedMemoryIds: args.selectedMemoryIds,
    vectorVersion: args.vectorVersion,
  });
}

function finalizeRankedCandidates(args: {
  readonly entries: Array<{
    readonly memory: MemoryRecord;
    readonly summary: string;
    readonly similarity: number;
  }>;
  readonly memories: MemoryRecord[];
  readonly resultTopK: number;
  readonly similarityThreshold: number;
  readonly selectedMemoryIds?: string[];
  readonly vectorVersion: string;
}): RankedMemoryCandidate[] {
  const stickyWeights = buildStickyMemoryWeights(args.memories, args.selectedMemoryIds ?? []);
  const scoredEntries = args.entries
    .map((entry) => ({
      ...entry,
      stickyWeight: stickyWeights.get(entry.memory.id) ?? 0,
      isSticky: (stickyWeights.get(entry.memory.id) ?? 0) > 0,
      retentionFloor: Math.max(
        MIN_RETENTION_SIMILARITY,
        args.similarityThreshold - (STICKY_RETENTION_DELTA * (stickyWeights.get(entry.memory.id) ?? 0)),
      ),
      rankingScore: entry.similarity + ((stickyWeights.get(entry.memory.id) ?? 0) * STICKY_MEMORY_BONUS),
    }))
    .sort((left, right) => right.rankingScore - left.rankingScore);

  const primary = scoredEntries.filter((entry) => entry.similarity >= args.similarityThreshold);
  const retained = scoredEntries.filter((entry) => entry.isSticky && entry.similarity >= entry.retentionFloor);
  const fallback = primary.length === 0 && retained.length === 0
    ? scoredEntries.filter((entry) => entry.similarity > 0).slice(0, Math.min(1, args.resultTopK))
    : [];

  const selected = dedupeEntries([...primary, ...retained, ...fallback]).slice(0, args.resultTopK);

  return selected.map(({ memory, similarity, summary }) => ({
    memoryId: memory.id,
    parentMemoryId: memory.parentId,
    summary,
    similarity: Number(similarity.toFixed(4)),
    sourceSessionId: memory.sourceSessionId,
    vectorVersion: args.vectorVersion,
  }));
}

function dedupeEntries<T extends { readonly memory: MemoryRecord }>(entries: T[]): T[] {
  const seenMemoryIds = new Set<string>();
  const deduped: T[] = [];

  for (const entry of entries) {
    if (seenMemoryIds.has(entry.memory.id)) {
      continue;
    }

    seenMemoryIds.add(entry.memory.id);
    deduped.push(entry);
  }

  return deduped;
}

function buildStickyMemoryWeights(memories: MemoryRecord[], selectedMemoryIds: string[]): Map<string, number> {
  const memoryIds = new Set(memories.map((memory) => memory.id));
  const recentSelectedIds = selectedMemoryIds
    .filter((memoryId) => memoryIds.has(memoryId))
    .slice(-RECENT_STICKY_WINDOW)
    .reverse();
  const stickyWeights = new Map<string, number>();

  recentSelectedIds.forEach((memoryId, index) => {
    mergeStickyWeight(stickyWeights, memoryId, Math.pow(STICKY_DECAY_FACTOR, index));
  });

  for (const memory of memories) {
    if (memory.parentId && stickyWeights.has(memory.parentId)) {
      mergeStickyWeight(
        stickyWeights,
        memory.id,
        (stickyWeights.get(memory.parentId) ?? 0) * RELATED_MEMORY_WEIGHT_FACTOR,
      );
    }

    if (memory.parentId && stickyWeights.has(memory.id)) {
      mergeStickyWeight(
        stickyWeights,
        memory.parentId,
        (stickyWeights.get(memory.id) ?? 0) * RELATED_MEMORY_WEIGHT_FACTOR,
      );
    }
  }

  return stickyWeights;
}

function mergeStickyWeight(weights: Map<string, number>, memoryId: string, weight: number): void {
  const existingWeight = weights.get(memoryId) ?? 0;
  if (weight > existingWeight) {
    weights.set(memoryId, weight);
  }
}

export function vectorizeWithLocalHash(text: string): number[] {
  const normalized = text.trim().toLowerCase();
  const vector = new Array<number>(VECTOR_DIMENSION).fill(0);

  if (!normalized) {
    return vector;
  }

  const padded = normalized.length >= 3 ? normalized : normalized.padEnd(3, ' ');
  for (let index = 0; index <= padded.length - 3; index += 1) {
    const trigram = padded.slice(index, index + 3);
    const bucket = fnv1a(trigram) % VECTOR_DIMENSION;
    vector[bucket] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dotProduct = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dotProduct += left[index]! * right[index]!;
  }

  return Math.max(0, Math.min(1, dotProduct));
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}