import { describe, expect, it } from 'vitest';
import { PromptService } from '../../src/prompts/prompt-service';
import { InMemoryPromptRepository } from '../../src/prompts/prompt-repository';
import { MemoryService } from '../../src/memory/memory-service';
import { InMemoryMemoryRepository } from '../../src/memory/memory-repository';

describe('context command contract', () => {
  it('lists and selects prompt and memory records', () => {
    const promptService = new PromptService(new InMemoryPromptRepository());
    const memoryService = new MemoryService(new InMemoryMemoryRepository());

    const prompt = promptService.createPrompt('Debug prompt', 'code', 'Inspect the issue');
    const memory = memoryService.createMemory('Remember scope', 'keep session focused', 'session');

    expect(promptService.listPrompts()).toHaveLength(1);
    expect(memoryService.listMemories()).toHaveLength(1);
    expect(prompt.id).toBeTruthy();
    expect(memory.id).toBeTruthy();
  });
});
