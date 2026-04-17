import { promptAssetSchema, type PromptAsset } from '../shared/schema';

export function createPromptModel(id: string, title: string, category: string, content: string): PromptAsset {
  const now = new Date().toISOString();

  return promptAssetSchema.parse({
    id,
    title,
    category,
    content,
    status: 'active',
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
}
