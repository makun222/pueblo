import type { PepeConfig } from '../shared/config';
import { pepeResultSetSchema, type MemoryRecord, type PepeResultItem, type PepeResultSet } from '../shared/schema';
import type { MemoryService } from '../memory/memory-service';
import { buildQueryText, fingerprintInput, rankMemoryCandidates, toPepeResultItem } from './pepe-result-ranking';

export interface ResolvePepeResultInput {
  readonly sessionId: string | null;
  readonly agentInstanceId: string | null;
  readonly selectedMemoryIds: string[];
  readonly pendingUserInput?: string;
}

export interface ResolvedPepeResult {
  readonly resultSet: PepeResultSet | null;
  readonly resultItems: PepeResultItem[];
  readonly sourceMemories: MemoryRecord[];
}

interface CachedPepeResult {
  readonly fingerprint: string;
  readonly resultSet: PepeResultSet;
  readonly resultItems: PepeResultItem[];
}

export class PepeResultService {
  private readonly cache = new Map<string, CachedPepeResult>();

  constructor(
    private readonly memoryService: Pick<MemoryService, 'resolveMemorySelection'>,
    private readonly config: Pick<PepeConfig, 'enabled' | 'resultTopK' | 'similarityThreshold'>,
  ) {}

  resolve(input: ResolvePepeResultInput): ResolvedPepeResult {
    const sourceMemories = this.memoryService.resolveMemorySelection(input.selectedMemoryIds);
    const queryText = buildQueryText(input.pendingUserInput);
    const inputFingerprint = fingerprintInput(queryText, input.selectedMemoryIds);

    if (!this.config.enabled || !input.sessionId || sourceMemories.length === 0) {
      return {
        resultSet: null,
        resultItems: [],
        sourceMemories,
      };
    }

    const cached = this.cache.get(input.sessionId);
    if (cached && cached.fingerprint === inputFingerprint) {
      return {
        resultSet: cached.resultSet,
        resultItems: cached.resultItems,
        sourceMemories,
      };
    }

    const resultItems = rankMemoryCandidates({
      memories: sourceMemories,
      pendingUserInput: input.pendingUserInput,
      resultTopK: this.config.resultTopK,
      similarityThreshold: this.config.similarityThreshold,
      selectedMemoryIds: input.selectedMemoryIds,
    }).map((candidate) => toPepeResultItem(candidate, candidate.memoryId ?? candidate.parentMemoryId ?? 'unknown-memory'));
    const resultSet = pepeResultSetSchema.parse({
      sessionId: input.sessionId,
      agentInstanceId: input.agentInstanceId,
      inputFingerprint,
      items: resultItems,
      generatedAt: new Date().toISOString(),
    });

    return {
      resultSet,
      resultItems,
      sourceMemories,
    };
  }

  cacheSessionResult(args: {
    readonly sessionId: string;
    readonly agentInstanceId: string | null;
    readonly selectedMemoryIds: string[];
    readonly pendingUserInput?: string;
    readonly resultItems: PepeResultItem[];
  }): void {
    const queryText = buildQueryText(args.pendingUserInput);
    const fingerprint = fingerprintInput(queryText, args.selectedMemoryIds);
    const resultSet = pepeResultSetSchema.parse({
      sessionId: args.sessionId,
      agentInstanceId: args.agentInstanceId,
      inputFingerprint: fingerprint,
      items: args.resultItems,
      generatedAt: new Date().toISOString(),
    });

    this.cache.set(args.sessionId, {
      fingerprint,
      resultSet,
      resultItems: args.resultItems,
    });
  }
}