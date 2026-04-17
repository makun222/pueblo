import type { MemoryRecord } from '../shared/schema';
import type { MemoryStore } from './memory-repository';

export class MemoryQueries {
  constructor(private readonly repository: MemoryStore) {}

  listMemories(): MemoryRecord[] {
    return this.repository.list();
  }

  searchMemories(query: string): MemoryRecord[] {
    return this.repository.search(query);
  }
}
