import type { MemoryRecord, MemoryScope } from '../shared/schema';
import { MemoryQueries } from './memory-queries';
import type { MemoryStore } from './memory-repository';

export class MemoryService {
  private readonly queries: MemoryQueries;

  constructor(private readonly repository: MemoryStore) {
    this.queries = new MemoryQueries(repository);
  }

  createMemory(title: string, content: string, scope: MemoryScope): MemoryRecord {
    return this.repository.create(title, content, scope);
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
}
