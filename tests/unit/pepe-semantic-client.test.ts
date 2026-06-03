import { describe, expect, it } from 'vitest';
import { PepeSemanticClient } from '../../src/agent/pepe-semantic-client';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { createTestAppConfig } from '../helpers/test-config';

describe('pepe semantic client', () => {
  it('returns null when no pepe summary provider is configured', async () => {
    const registry = new ProviderRegistry();
    const client = new PepeSemanticClient(registry, createTestAppConfig());

    const summary = await client.summarizeMemory({
      memory: {
        id: 'memory-1',
        type: 'short-term',
        memoryKind: 'turn',
        title: 'Turn 1',
        content: 'User: inspect issue\n\nAssistant: issue inspected',
        scope: 'session',
        status: 'active',
        tags: ['conversation-turn'],
        parentId: null,
        derivationType: 'summary',
        summaryDepth: 0,
        weight: 0.8,
        lastAccessedAt: new Date().toISOString(),
        sourceSessionId: 'session-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      currentInput: 'inspect issue',
    });

    expect(summary).toBeNull();
  });

  it('uses the configured provider and model for semantic summaries', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      createProviderProfile({
        id: 'openai',
        name: 'OpenAI',
        defaultModelId: 'gpt-4.1-mini',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
      }),
      new InMemoryProviderAdapter('openai', 'Semantic summary'),
    );

    const client = new PepeSemanticClient(
      registry,
      createTestAppConfig({
        pepe: {
          providerId: 'openai',
          modelId: 'gpt-4.1-mini',
        },
      }),
    );

    const summary = await client.summarizeMemory({
      memory: {
        id: 'memory-1',
        type: 'short-term',
        memoryKind: 'generic',
        title: 'Repo fact',
        content: 'Repository uses sqlite persistence.',
        scope: 'project',
        status: 'active',
        tags: [],
        parentId: null,
        derivationType: 'manual',
        summaryDepth: 0,
        weight: 0,
        lastAccessedAt: new Date().toISOString(),
        sourceSessionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      currentInput: 'how is data persisted',
    });

    expect(summary).toContain('Semantic summary:');
    expect(client.getSummaryTarget()).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    });
  });

  it('inherits the current deepseek provider configuration when pepe provider is unset', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      createProviderProfile({
        id: 'deepseek',
        name: 'DeepSeek',
        defaultModelId: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsTools: true }],
      }),
      new InMemoryProviderAdapter('deepseek', 'DeepSeek semantic summary'),
    );

    const client = new PepeSemanticClient(
      registry,
      createTestAppConfig({
        providers: [
          {
            providerId: 'deepseek',
            defaultModelId: 'deepseek-v4-pro',
            enabled: true,
            credentialSource: 'env',
          },
        ],
        pepe: {
          providerId: null,
          modelId: null,
        },
      }),
    );

    expect(client.getSummaryTarget()).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });
  });

  it('treats an auth-missing fallback provider as unavailable for summaries', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      createProviderProfile({
        id: 'deepseek',
        name: 'DeepSeek',
        authState: 'missing',
        defaultModelId: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsTools: true }],
      }),
      new InMemoryProviderAdapter('deepseek', 'DeepSeek semantic summary'),
    );

    const client = new PepeSemanticClient(
      registry,
      createTestAppConfig({
        providers: [
          {
            providerId: 'deepseek',
            defaultModelId: 'deepseek-v4-pro',
            enabled: true,
            credentialSource: 'windows-credential-manager',
          },
        ],
        pepe: {
          providerId: null,
          modelId: null,
        },
      }),
    );

    expect(client.isConfigured()).toBe(false);
    await expect(client.summarizeMemory({
      memory: {
        id: 'memory-1',
        type: 'short-term',
        memoryKind: 'turn',
        title: 'Turn 1',
        content: 'User: inspect issue\n\nAssistant: issue inspected',
        scope: 'session',
        status: 'active',
        tags: ['conversation-turn'],
        parentId: null,
        derivationType: 'summary',
        summaryDepth: 0,
        weight: 0.8,
        lastAccessedAt: new Date().toISOString(),
        sourceSessionId: 'session-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      currentInput: 'inspect issue',
    })).resolves.toBeNull();
  });
});