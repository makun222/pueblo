import type { AppConfig } from '../shared/config';
import type {
  BackgroundSummaryStatus,
  ContextCount,
  MemoryRecord,
  PromptAsset,
  PuebloProfile,
  Session,
} from '../shared/schema';

export interface TaskContext {
  readonly sessionId: string | null;
  readonly session: Session | null;
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly selectedModelId: string | null;
  readonly selectedModelName: string | null;
  readonly selectedPromptIds: string[];
  readonly selectedMemoryIds: string[];
  readonly prompts: PromptAsset[];
  readonly memories: MemoryRecord[];
  readonly recentMessages: string[];
  readonly puebloProfile: PuebloProfile;
  readonly contextCount: ContextCount;
  readonly backgroundSummaryStatus: BackgroundSummaryStatus;
  readonly config: AppConfig;
}

export interface TaskContextInput {
  readonly session?: Session | null;
  readonly prompts?: PromptAsset[];
  readonly memories?: MemoryRecord[];
  readonly selectedModelId?: string | null;
  readonly providerId?: string | null;
  readonly providerName?: string | null;
  readonly selectedModelName?: string | null;
  readonly currentSessionId?: string | null;
  readonly recentMessages?: string[];
  readonly puebloProfile: PuebloProfile;
  readonly contextCount: ContextCount;
  readonly backgroundSummaryStatus?: BackgroundSummaryStatus;
  readonly config: AppConfig;
}

export function createTaskContext(input: TaskContextInput): TaskContext {
  const session = input.session ?? null;
  const prompts = input.prompts ?? [];
  const memories = input.memories ?? [];
  const selectedModelId = input.selectedModelId ?? session?.currentModelId ?? null;

  return {
    sessionId: input.currentSessionId ?? session?.id ?? null,
    session,
    providerId: input.providerId ?? null,
    providerName: input.providerName ?? null,
    selectedModelId,
    selectedModelName: input.selectedModelName ?? null,
    selectedPromptIds: session?.selectedPromptIds ?? prompts.map((prompt) => prompt.id),
    selectedMemoryIds: session?.selectedMemoryIds ?? memories.map((memory) => memory.id),
    prompts,
    memories,
    recentMessages: input.recentMessages ?? session?.messageHistory ?? [],
    puebloProfile: input.puebloProfile,
    contextCount: input.contextCount,
    backgroundSummaryStatus: input.backgroundSummaryStatus ?? {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    },
    config: input.config,
  };
}
