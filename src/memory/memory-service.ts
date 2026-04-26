import type { MemoryRecord, MemoryScope } from '../shared/schema';
import { MemoryQueries } from './memory-queries';
import type { MemoryStore } from './memory-repository';
import type { CreateMemoryModelOptions } from './memory-model';

export class MemoryService {
  private readonly queries: MemoryQueries;

  constructor(private readonly repository: MemoryStore) {
    this.queries = new MemoryQueries(repository);
  }

  createMemory(title: string, content: string, scope: MemoryScope, options: CreateMemoryModelOptions = {}): MemoryRecord {
    return this.repository.create(title, content, scope, options);
  }

  listMemories(): MemoryRecord[] {
    return this.queries.listMemories().filter((memory) => memory.status === 'active');
  }

  selectMemory(memoryId: string): MemoryRecord {
    const memory = this.repository.getById(memoryId);

    if (!memory || memory.status !== 'active') {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    return memory;
  }

  searchMemories(query: string): MemoryRecord[] {
    return this.queries.searchMemories(query).filter((memory) => memory.status === 'active');
  }

  resolveMemorySelection(memoryIds: string[]): MemoryRecord[] {
    return memoryIds.flatMap((memoryId) => {
      try {
        return [this.selectMemory(memoryId)];
      } catch {
        return [];
      }
    });
  }

  listSessionMemories(sessionId: string): MemoryRecord[] {
    return this.listMemories().filter((memory) => memory.sourceSessionId === sessionId);
  }

  createConversationTurnMemory(args: {
    readonly sessionId: string;
    readonly turnNumber: number;
    readonly userInput: string;
    readonly assistantOutput: string;
  }): MemoryRecord {
    return this.createMemory(
      `Turn ${args.turnNumber}`,
      ['User:', args.userInput.trim(), '', 'Assistant:', args.assistantOutput.trim()].join('\n'),
      'session',
      {
        tags: ['conversation-turn', 'auto-captured'],
        derivationType: 'summary',
        sourceSessionId: args.sessionId,
      },
    );
  }
}
