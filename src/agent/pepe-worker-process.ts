import type { PepeConfig } from '../shared/config';
import type { PepeLocalEmbeddingClient } from './pepe-local-embedding-client';
import type { PepeSemanticClient } from './pepe-semantic-client';
import type { MemoryRecord } from '../shared/schema';
import type { PepeWorkerProcessResult, PepeWorkerSessionSnapshot, PepeWorkerSummary } from './pepe-worker-protocol';
import { buildQueryText, rankMemoryCandidatesWithVectors, summarizeMemory } from './pepe-result-ranking';

export async function processPepeSessionSnapshot(
  snapshot: PepeWorkerSessionSnapshot,
  semanticClient: Pick<PepeSemanticClient, 'isConfigured' | 'summarizeMemory'>,
  embeddingClient: Pick<PepeLocalEmbeddingClient, 'embedTexts'>,
  config: Pick<PepeConfig, 'resultTopK' | 'similarityThreshold'>,
): Promise<PepeWorkerProcessResult> {
  const existingSummaryParents = new Set(
    snapshot.memories
      .filter((memory) => memory.tags.includes('pepe-summary') && memory.parentId)
      .map((memory) => memory.parentId!),
  );

  const summaries: PepeWorkerSummary[] = [];
  const summaryOverrides = new Map<string, string>();

  if (semanticClient.isConfigured()) {
    for (const memory of snapshot.memories) {
      if (!shouldSummarizeMemory(memory, existingSummaryParents)) {
        continue;
      }

      const summary = await semanticClient.summarizeMemory({
        memory,
        currentInput: snapshot.pendingInput,
      });
      if (!summary) {
        continue;
      }

      summaries.push({
        parentMemoryId: memory.id,
        summary,
      });
      summaryOverrides.set(memory.id, summary);
      existingSummaryParents.add(memory.id);
    }
  }

  const memorySummaries = snapshot.memories.map((memory) => summaryOverrides.get(memory.id) ?? summarizeMemory(memory));
  const embeddingBatch = await embeddingClient.embedTexts([
    buildQueryText(snapshot.pendingInput),
    ...memorySummaries,
  ]);

  const resultCandidates = (await rankMemoryCandidatesWithVectors({
    memories: snapshot.memories,
    pendingUserInput: snapshot.pendingInput,
    resultTopK: config.resultTopK,
    similarityThreshold: config.similarityThreshold,
    summaryOverrides,
    selectedMemoryIds: snapshot.selectedMemoryIds,
    vectors: embeddingBatch.vectors,
    vectorVersion: embeddingBatch.vectorVersion,
  })).map((candidate) => {
    if (!summaryOverrides.has(candidate.memoryId ?? '')) {
      return candidate;
    }

    return {
      ...candidate,
      memoryId: null,
      parentMemoryId: candidate.memoryId,
    };
  });

  return {
    sessionId: snapshot.sessionId,
    summaries,
    resultCandidates,
    lastSummaryAt: summaries.length > 0 ? new Date().toISOString() : null,
    lastSummaryMemoryId: summaries.at(-1)?.parentMemoryId ?? null,
  };
}

function shouldSummarizeMemory(memory: MemoryRecord, existingSummaryParents: Set<string>): boolean {
  if (memory.tags.includes('pepe-summary')) {
    return false;
  }

  if (!memory.tags.includes('conversation-turn')) {
    return false;
  }

  return !existingSummaryParents.has(memory.id);
}