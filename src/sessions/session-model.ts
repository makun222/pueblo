import { sessionSchema, type Session } from '../shared/schema';

export interface CreateSessionInput {
  readonly id: string;
  readonly title: string;
  readonly currentModelId?: string | null;
}

export function createSessionModel(input: CreateSessionInput): Session {
  const now = new Date().toISOString();

  return sessionSchema.parse({
    id: input.id,
    title: input.title,
    status: 'active',
    currentModelId: input.currentModelId ?? null,
    messageHistory: [],
    selectedPromptIds: [],
    selectedMemoryIds: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
}
