import { describe, expect, it } from 'vitest';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';
import { MemoryService } from '../../src/memory/memory-service';

describe('memory service', () => {
  it('searches active memories by content', () => {
    const service = new MemoryService(new InMemoryMemoryRepository());
    service.createMemory('SQLite note', 'remember sqlite session storage', 'project');

    const matches = service.searchMemories('sqlite');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.title).toBe('SQLite note');
  });
});
