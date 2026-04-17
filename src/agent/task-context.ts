import type { AppConfig } from '../shared/config';
import type { MemoryRecord, PromptAsset, Session } from '../shared/schema';

export interface TaskContext {
  readonly sessionId: string | null;
  readonly session: Session | null;
  readonly selectedModelId: string | null;
  readonly selectedPromptIds: string[];
  readonly selectedMemoryIds: string[];
  readonly prompts: PromptAsset[];
  readonly memories: MemoryRecord[];
  readonly config: AppConfig;
}

export interface TaskContextInput {
  readonly session?: Session | null;
  readonly prompts?: PromptAsset[];
  readonly memories?: MemoryRecord[];
  readonly selectedModelId?: string | null;
  readonly currentSessionId?: string | null;
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
    selectedModelId,
    selectedPromptIds: session?.selectedPromptIds ?? prompts.map((prompt) => prompt.id),
    selectedMemoryIds: session?.selectedMemoryIds ?? memories.map((memory) => memory.id),
    prompts,
    memories,
    config: input.config,
  };
}
