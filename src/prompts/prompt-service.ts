import type { PromptAsset } from '../shared/schema';
import type { PromptStore } from './prompt-repository';

export class PromptService {
  constructor(private readonly repository: PromptStore) {}

  createPrompt(title: string, category: string, content: string): PromptAsset {
    return this.repository.create(title, category, content);
  }

  listPrompts(): PromptAsset[] {
    return this.repository.list().filter((prompt) => prompt.status !== 'deleted');
  }

  selectPrompt(promptId: string): PromptAsset {
    const prompt = this.repository.getById(promptId);

    if (!prompt || prompt.status === 'deleted') {
      throw new Error(`Prompt not found: ${promptId}`);
    }

    return prompt;
  }

  deletePrompt(promptId: string): PromptAsset {
    const prompt = this.selectPrompt(promptId);
    const updated: PromptAsset = {
      ...prompt,
      status: 'deleted',
      updatedAt: new Date().toISOString(),
    };

    return this.repository.save(updated);
  }
}
