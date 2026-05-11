import { sessionSchema, type Session } from '../shared/schema';

export interface CreateSessionInput {
  readonly id: string;
  readonly title: string;
  readonly currentModelId?: string | null;
  readonly agentInstanceId?: string | null;
  readonly sessionKind?: Session['sessionKind'];
  readonly originSessionId?: string | null;
  readonly triggerReason?: Session['triggerReason'];
}

export function createSessionModel(input: CreateSessionInput): Session {
  const now = new Date().toISOString();

  return sessionSchema.parse({
    id: input.id,
    title: input.title,
    status: 'active',
    sessionKind: input.sessionKind ?? 'user',
    agentInstanceId: input.agentInstanceId ?? null,
    currentModelId: input.currentModelId ?? null,
    messageHistory: [],
    selectedPromptIds: [],
    selectedMemoryIds: [],
    providerUsageStats: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      promptTokensSent: 0,
      cacheHitRatio: null,
    },
    originSessionId: input.originSessionId ?? null,
    triggerReason: input.triggerReason ?? null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    failedAt: null,
    archivedAt: null,
  });
}
