import { describe, expect, it } from 'vitest';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { ModelService } from '../../src/providers/model-service';

describe('provider service', () => {
  it('selects the default model when model id is omitted', () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new InMemoryProviderAdapter(profile.id, 'ok'));

    const service = new ModelService(registry);
    const selection = service.selectModel('openai');

    expect(selection.model.id).toBe('gpt-4.1-mini');
  });
});
