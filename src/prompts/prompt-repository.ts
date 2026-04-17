import { randomUUID } from 'node:crypto';
import { RepositoryBase, fromJson, toJson, type RepositoryContext } from '../persistence/repository-base';
import { promptAssetSchema, type PromptAsset } from '../shared/schema';
import { createPromptModel } from './prompt-model';

interface PromptRow {
  id: string;
  title: string;
  category: string;
  content: string;
  status: PromptAsset['status'];
  tags_json: string;
  created_at: string;
  updated_at: string;
}

export interface PromptStore {
  create(title: string, category: string, content: string): PromptAsset;
  list(): PromptAsset[];
  getById(promptId: string): PromptAsset | null;
  save(prompt: PromptAsset): PromptAsset;
}

export class InMemoryPromptRepository implements PromptStore {
  private readonly prompts = new Map<string, PromptAsset>();

  create(title: string, category: string, content: string): PromptAsset {
    const prompt = createPromptModel(randomUUID(), title, category, content);
    this.prompts.set(prompt.id, prompt);
    return prompt;
  }

  list(): PromptAsset[] {
    return [...this.prompts.values()];
  }

  getById(promptId: string): PromptAsset | null {
    return this.prompts.get(promptId) ?? null;
  }

  save(prompt: PromptAsset): PromptAsset {
    this.prompts.set(prompt.id, prompt);
    return prompt;
  }
}

export class PromptRepository extends RepositoryBase implements PromptStore {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(title: string, category: string, content: string): PromptAsset {
    const prompt = createPromptModel(randomUUID(), title, category, content);
    this.save(prompt);
    return prompt;
  }

  list(): PromptAsset[] {
    return this.all<PromptRow>('SELECT * FROM prompt_assets ORDER BY updated_at DESC').map((row) => this.mapRow(row));
  }

  getById(promptId: string): PromptAsset | null {
    const row = this.get<PromptRow>('SELECT * FROM prompt_assets WHERE id = ?', [promptId]);
    return row ? this.mapRow(row) : null;
  }

  save(prompt: PromptAsset): PromptAsset {
    const existing = this.getById(prompt.id);
    const params = {
      id: prompt.id,
      title: prompt.title,
      category: prompt.category,
      content: prompt.content,
      status: prompt.status,
      tags_json: toJson(prompt.tags),
      created_at: prompt.createdAt,
      updated_at: prompt.updatedAt,
    };

    if (existing) {
      this.run(
        `UPDATE prompt_assets
         SET title=@title, category=@category, content=@content, status=@status,
             tags_json=@tags_json, created_at=@created_at, updated_at=@updated_at
         WHERE id=@id`,
        params,
      );
    } else {
      this.run(
        `INSERT INTO prompt_assets (id, title, category, content, status, tags_json, created_at, updated_at)
         VALUES (@id, @title, @category, @content, @status, @tags_json, @created_at, @updated_at)`,
        params,
      );
    }

    return prompt;
  }

  private mapRow(row: PromptRow): PromptAsset {
    return promptAssetSchema.parse({
      id: row.id,
      title: row.title,
      category: row.category,
      content: row.content,
      status: row.status,
      tags: fromJson<string[]>(row.tags_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
