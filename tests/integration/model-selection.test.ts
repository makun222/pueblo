import { describe, expect, it } from 'vitest';
import { createInMemoryProviderRegistry, createProviderProfile } from '../../src/providers/provider-profile';
import { ModelService } from '../../src/providers/model-service';

describe('model selection integration', () => {
  it('switches the active provider model through the shared service', () => {
    const registry = createInMemoryProviderRegistry([
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
      }),
      createProviderProfile({
        id: 'anthropic',
        name: 'Anthropic',
        defaultModelId: 'claude-sonnet-4',
        models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', supportsTools: true }],
      }),
    ]);

    const service = new ModelService(registry);
    const selection = service.selectModel('anthropic', 'claude-sonnet-4');

    expect(selection.provider.id).toBe('anthropic');
    expect(selection.model.id).toBe('claude-sonnet-4');
  });
});
