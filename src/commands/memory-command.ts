import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { MemoryService } from '../memory/memory-service';
import type { SessionService } from '../sessions/session-service';

export interface MemoryCommandDependencies {
  readonly memoryService: MemoryService;
  readonly sessionService: SessionService;
  readonly getCurrentSessionId: () => string | null;
}

export function createMemoryListCommand(dependencies: MemoryCommandDependencies) {
  return (): CommandResult => successResult('MEMORY_LIST', 'Memories loaded', { memories: dependencies.memoryService.listMemories() });
}

export function createMemoryAddCommand(dependencies: MemoryCommandDependencies) {
  return (args: string[]): CommandResult => {
    const [scope, title, ...contentParts] = args;
    const content = contentParts.join(' ').trim();

    if (!scope || !title || !content) {
      return failureResult('MEMORY_ADD_INVALID', 'Memory scope, title, and content are required', [
        'Use /memory-add <scope> <title> <content>.',
      ]);
    }

    return successResult('MEMORY_CREATED', 'Memory created', dependencies.memoryService.createMemory(title, content, scope as never));
  };
}

export function createMemorySelectCommand(dependencies: MemoryCommandDependencies) {
  return (args: string[]): CommandResult => {
    const memoryId = args[0];

    if (!memoryId) {
      return failureResult('MEMORY_ID_REQUIRED', 'Memory id is required', ['Use /memory-sel <id>.']);
    }

    const memory = dependencies.memoryService.selectMemory(memoryId);
    const sessionId = dependencies.getCurrentSessionId();

    if (!sessionId) {
      return failureResult('SESSION_REQUIRED', 'Create or select a session before selecting a memory', [
        'Use /new to create a session, then retry /memory-sel.',
      ]);
    }

    dependencies.sessionService.addSelectedMemory(sessionId, memory.id);
    return successResult('MEMORY_SELECTED', 'Memory selected', memory);
  };
}

export function createMemorySearchCommand(dependencies: MemoryCommandDependencies) {
  return (args: string[]): CommandResult => {
    const query = args.join(' ').trim();

    if (!query) {
      return failureResult('MEMORY_QUERY_REQUIRED', 'Search query is required', ['Use /memory-search <query>.']);
    }

    return successResult('MEMORY_SEARCH', 'Memory search completed', {
      memories: dependencies.memoryService.searchMemories(query),
    });
  };
}
