import { afterEach, describe, expect, it } from 'vitest';
import { resolveDeepSeekApiKey, resolveDeepSeekAuth } from '../../src/providers/deepseek-auth';
import { createTestAppConfig } from '../helpers/test-config';

const previousEnvApiKey = process.env.DEEPSEEK_API_KEY;

const inMemoryCredentialStore = {
  kind: 'windows-credential-manager' as const,
  isSupported: () => true,
  readSecret: (target: string) => (target === 'Pueblo:DeepSeek:test' ? 'stored-deepseek-key' : null),
  writeSecret: () => {},
};

afterEach(() => {
  if (previousEnvApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
    return;
  }

  process.env.DEEPSEEK_API_KEY = previousEnvApiKey;
});

describe('deepseek auth', () => {
  it('reads api key from the credential store before env fallback', () => {
    process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
    const config = createTestAppConfig({
      deepseek: {
        credentialTarget: 'Pueblo:DeepSeek:test',
      },
    });

    const resolved = resolveDeepSeekApiKey(config, { credentialStore: inMemoryCredentialStore });

    expect(resolved).toEqual({
      apiKey: 'stored-deepseek-key',
    });
  });

  it('falls back to environment api key when config and credential store are empty', () => {
    process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
    const config = createTestAppConfig({
      deepseek: {
        apiKey: undefined,
        credentialTarget: undefined,
      },
    });

    const resolved = resolveDeepSeekApiKey(config);

    expect(resolved).toEqual({
      apiKey: 'env-deepseek-key',
    });
  });

  it('reports windows credential manager auth source when a stored key is configured', () => {
    const config = createTestAppConfig({
      providers: [],
      deepseek: {
        credentialTarget: 'Pueblo:DeepSeek:test',
      },
    });

    const status = resolveDeepSeekAuth(config, { credentialStore: inMemoryCredentialStore });

    expect(status).toEqual({
      providerId: 'deepseek',
      authState: 'configured',
      credentialSource: 'windows-credential-manager',
    });
  });
});