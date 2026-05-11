import { randomUUID } from 'node:crypto';
import type { Session } from '../shared/schema';
import type { SessionMessage, SessionMessageRole } from '../shared/schema';
import { SessionCommandError } from '../commands/command-errors';
import type { MemoryService } from '../memory/memory-service';
import type { ProviderUsage } from '../providers/provider-adapter';
import { SessionQueries } from './session-queries';
import type { SessionStore } from './session-repository';

export interface AppendSessionMessageInput {
  readonly role: SessionMessageRole;
  readonly content: string;
  readonly taskId?: string | null;
  readonly toolName?: string | null;
  readonly createdAt?: string;
}

export class SessionService {
  private readonly queries: SessionQueries;

  constructor(
    private readonly repository: SessionStore,
    private readonly memoryService?: MemoryService,
  ) {
    this.queries = new SessionQueries(repository);
  }

  createSession(title?: string, currentModelId?: string | null, agentInstanceId?: string | null): Session {
    const resolvedTitle = title?.trim() || 'Untitled session';
    const session = this.repository.create(resolvedTitle, currentModelId ?? null, agentInstanceId ?? null);
    this.repository.setCurrentSession(session.id);
    return session;
  }

  listSessions(): Session[] {
    return this.queries.listSessions();
  }

  selectSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be selected');
    }

    const updated = this.updateSession(session, {
      status: 'active',
      archivedAt: null,
    });
    this.repository.setCurrentSession(updated.id);
    return updated;
  }

  archiveSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be archived');
    }

    const updated = this.updateSession(session, {
      status: 'archived',
      archivedAt: new Date().toISOString(),
    });

    if (this.repository.getCurrentSession()?.id === updated.id) {
      this.repository.setCurrentSession(null);
    }

    return updated;
  }

  restoreSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);

    if (session.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot be restored');
    }

    const updated = this.updateSession(session, {
      status: 'active',
      archivedAt: null,
    });
    this.repository.setCurrentSession(updated.id);
    return updated;
  }

  deleteSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);
    const updated = this.updateSession(session, {
      status: 'deleted',
      archivedAt: session.archivedAt,
    });

    if (this.repository.getCurrentSession()?.id === updated.id) {
      this.repository.setCurrentSession(null);
    }

    return updated;
  }

  setCurrentModel(sessionId: string, modelId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      currentModelId: modelId,
    });
  }

  getSession(sessionId: string): Session | null {
    return this.repository.getById(sessionId);
  }

  appendMessage(sessionId: string, input: AppendSessionMessageInput): Session {
    const session = this.requireSession(sessionId);
    const normalizedContent = input.content.trim();

    if (!normalizedContent) {
      throw new SessionCommandError('Session message content is required');
    }

    const message: SessionMessage = {
      id: randomUUID(),
      role: input.role,
      content: normalizedContent,
      createdAt: input.createdAt ?? new Date().toISOString(),
      taskId: input.taskId ?? null,
      toolName: input.toolName ?? null,
    };

    return this.updateSession(session, {
      messageHistory: [...session.messageHistory, message],
    });
  }

  addUserMessage(sessionId: string, content: string, taskId?: string | null): Session {
    return this.appendMessage(sessionId, {
      role: 'user',
      content,
      taskId,
    });
  }

  addAssistantMessage(sessionId: string, content: string, taskId?: string | null): Session {
    return this.appendMessage(sessionId, {
      role: 'assistant',
      content,
      taskId,
    });
  }

  addToolMessage(sessionId: string, toolName: string, content: string, taskId?: string | null): Session {
    return this.appendMessage(sessionId, {
      role: 'tool',
      content,
      taskId,
      toolName,
    });
  }

  addProviderUsage(sessionId: string, usage?: ProviderUsage | null): Session {
    if (!usage) {
      return this.requireSession(sessionId);
    }

    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      providerUsageStats: accumulateProviderUsageStats(session.providerUsageStats, usage),
    });
  }

  addSelectedPrompt(sessionId: string, promptId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: uniqueValues([...session.selectedPromptIds, promptId]),
    });
  }

  removeSelectedPrompt(sessionId: string, promptId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: session.selectedPromptIds.filter((id) => id !== promptId),
    });
  }

  setSelectedPromptIds(sessionId: string, promptIds: string[]): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedPromptIds: uniqueValues(promptIds),
    });
  }

  addSelectedMemory(sessionId: string, memoryId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: uniqueValues([...session.selectedMemoryIds, memoryId]),
    });
  }

  removeSelectedMemory(sessionId: string, memoryId: string): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: session.selectedMemoryIds.filter((id) => id !== memoryId),
    });
  }

  setSelectedMemoryIds(sessionId: string, memoryIds: string[]): Session {
    const session = this.requireSession(sessionId);
    return this.updateSession(session, {
      selectedMemoryIds: uniqueValues(memoryIds),
    });
  }

  importSelectedMemoriesFromSession(targetSessionId: string, sourceSessionId: string): Session {
    const targetSession = this.requireSession(targetSessionId);
    const sourceSession = this.requireSession(sourceSessionId);

    if (targetSession.status === 'deleted' || sourceSession.status === 'deleted') {
      throw new SessionCommandError('Deleted session cannot participate in memory import');
    }

    const importedMemoryIds = this.memoryService
      ?.listSessionMemories(sourceSession.id)
      .map((memory) => memory.id) ?? [];

    return this.updateSession(targetSession, {
      selectedMemoryIds: uniqueValues([...targetSession.selectedMemoryIds, ...importedMemoryIds]),
    });
  }

  getCurrentSession(): Session | null {
    return this.queries.getCurrentSession();
  }

  getMostRecentSessionForAgentInstance(agentInstanceId: string | null | undefined): Session | null {
    if (!agentInstanceId) {
      return null;
    }

    return this.queries.listSessions()
      .filter((session) => session.agentInstanceId === agentInstanceId && session.status !== 'deleted')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  private requireSession(sessionId: string): Session {
    const session = this.repository.getById(sessionId);

    if (!session) {
      throw new SessionCommandError(`Session not found: ${sessionId}`);
    }

    return session;
  }

  private updateSession(session: Session, patch: Partial<Session>): Session {
    const updated: Session = {
      ...session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    return this.repository.save(updated);
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function accumulateProviderUsageStats(
  current: Session['providerUsageStats'],
  usage: ProviderUsage,
): Session['providerUsageStats'] {
  const promptTokens = current.promptTokens + (usage.promptTokens ?? 0);
  const completionTokens = current.completionTokens + (usage.completionTokens ?? 0);
  const totalTokens = current.totalTokens + (usage.totalTokens ?? 0);
  const promptCacheHitTokens = current.promptCacheHitTokens + (usage.promptCacheHitTokens ?? 0);
  const promptCacheMissTokens = current.promptCacheMissTokens + (usage.promptCacheMissTokens ?? 0);
  const cachedPromptTokens = current.cachedPromptTokens + (usage.promptTokensDetails?.cachedTokens ?? 0);
  const reasoningTokens = current.reasoningTokens + (usage.completionTokensDetails?.reasoningTokens ?? 0);
  const promptTokensSent = promptCacheHitTokens + promptCacheMissTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedPromptTokens,
    reasoningTokens,
    promptTokensSent,
    cacheHitRatio: promptTokensSent > 0 ? Number((promptCacheHitTokens / promptTokensSent).toFixed(4)) : null,
  };
}
