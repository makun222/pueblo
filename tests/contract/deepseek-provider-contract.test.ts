import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/providers/deepseek-adapter';
import { resolveDeepSeekAuth } from '../../src/providers/deepseek-auth';
import { createDeepSeekProfile } from '../../src/providers/deepseek-profile';
import type { ProviderAdapter } from '../../src/providers/provider-adapter';
import { createTestAppConfig } from '../helpers/test-config';

describe('DeepSeek Provider Contract', () => {
  it('should implement ProviderAdapter interface', () => {
    const adapter: ProviderAdapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      fetchImpl: vi.fn(),
    });

    const profile = createDeepSeekProfile('configured');

    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    expect(profile.id).toBe('deepseek');
    expect(profile.defaultModelId).toBe('deepseek-v4-flash');
  });

  it('should handle task execution requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'DeepSeek output',
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    const adapter = new DeepSeekAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl,
    });

    const result = await adapter.runTask({
      modelId: 'deepseek-v4-flash',
      goal: 'Inspect repository state',
      inputContextSummary: 'Task execution test',
    });

    expect(result.outputSummary).toBe('DeepSeek output');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/chat/completions');
  });

  it('should validate DeepSeek credentials', () => {
    const config = createTestAppConfig({
      providers: [
        {
          providerId: 'deepseek',
          defaultModelId: 'deepseek-v4-flash',
          enabled: true,
          credentialSource: 'config-file',
        },
      ],
      deepseek: {
        apiKey: 'deepseek-key',
      },
    });

    expect(resolveDeepSeekAuth(config).authState).toBe('configured');
  });
});