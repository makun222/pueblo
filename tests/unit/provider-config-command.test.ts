import { describe, expect, it, vi } from 'vitest';
import { createProviderConfigCommand } from '../../src/commands/provider-config-command';
import { createTestAppConfig } from '../helpers/test-config';

describe('provider config command', () => {
  it('runs GitHub Copilot login through the unified provider-config command', async () => {
    const nextConfig = createTestAppConfig({
      providers: [
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: 'windows-credential-manager',
        },
      ],
      githubCopilot: {
        credentialTarget: 'Pueblo:GitHubCopilot:test',
      },
    });
    const setCurrentConfig = vi.fn();
    const onConfigured = vi.fn();
    const command = createProviderConfigCommand({
      getCurrentConfig: () => createTestAppConfig(),
      setCurrentConfig,
      runGitHubCopilotLogin: async () => ({
        performed: true,
        configured: true,
        config: nextConfig,
      }),
      onConfigured,
    });

    const result = await command(['github-copilot', 'login']);

    expect(result.ok).toBe(true);
    expect(result.code).toBe('AUTH_LOGIN_COMPLETED');
    expect(setCurrentConfig).toHaveBeenCalledWith(nextConfig);
    expect(onConfigured).toHaveBeenCalledWith('github-copilot', nextConfig);
  });

  it('stores DeepSeek configuration through the unified provider-config command', async () => {
    const secrets = new Map<string, string>();
    let currentConfig = createTestAppConfig({
      providers: [],
      defaultProviderId: null,
      deepseek: {
        apiKey: undefined,
      },
    });
    const command = createProviderConfigCommand({
      getCurrentConfig: () => currentConfig,
      setCurrentConfig: (nextConfig) => {
        currentConfig = nextConfig;
      },
      runGitHubCopilotLogin: async () => ({
        performed: false,
        configured: true,
        config: currentConfig,
      }),
      credentialStore: {
        kind: 'windows-credential-manager',
        isSupported: () => true,
        readSecret: (target: string) => secrets.get(target) ?? null,
        writeSecret: (target: string, secret: string) => {
          secrets.set(target, secret);
        },
      },
    });

    const result = await command(['deepseek', 'set-key', 'deepseek-secret', 'deepseek-v4-pro', 'https://api.deepseek.com']);

    expect(result.ok).toBe(true);
    expect(result.code).toBe('DEEPSEEK_AUTH_COMPLETED');
    expect(currentConfig.providers.find((provider) => provider.providerId === 'deepseek')).toMatchObject({
      defaultModelId: 'deepseek-v4-pro',
      credentialSource: 'windows-credential-manager',
    });
    expect(currentConfig.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(currentConfig.deepseek.credentialTarget).toBeTruthy();
    expect(secrets.get(currentConfig.deepseek.credentialTarget ?? '')).toBe('deepseek-secret');
  });

  it('surfaces the detailed GitHub Copilot login error', async () => {
    const command = createProviderConfigCommand({
      getCurrentConfig: () => createTestAppConfig(),
      setCurrentConfig: vi.fn(),
      runGitHubCopilotLogin: async () => ({
        performed: true,
        configured: false,
        config: createTestAppConfig(),
        errorMessage: 'GitHub OAuth client id is missing. Set githubCopilot.oauthClientId in .pueblo/config.json.',
      }),
    });

    const result = await command(['github-copilot', 'login']);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_LOGIN_FAILED');
    expect(result.message).toBe('GitHub OAuth client id is missing. Set githubCopilot.oauthClientId in .pueblo/config.json.');
  });
});