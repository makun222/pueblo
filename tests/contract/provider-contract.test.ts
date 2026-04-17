import { describe, expect, it } from 'vitest';
import { createInMemoryProviderRegistry, createProviderProfile } from '../../src/providers/provider-profile';
import { ModelService } from '../../src/providers/model-service';

describe('provider contract', () => {
  it('lists models from multiple supported providers', () => {
    const registry = createInMemoryProviderRegistry([
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [
          { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true },
          { id: 'gpt-4.1', name: 'GPT-4.1', supportsTools: true },
        ],
      }),
      createProviderProfile({
        id: 'anthropic',
        name: 'Anthropic',
        defaultModelId: 'claude-sonnet-4',
        models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', supportsTools: true }],
      }),
    ]);

    const service = new ModelService(registry);
    const models = service.listModels();

    expect(models).toHaveLength(3);
    expect(models.map((model) => model.providerId)).toEqual(['openai', 'openai', 'anthropic']);
  });
});
