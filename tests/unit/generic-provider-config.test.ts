import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listGenericProviderConfigurations,
  persistGenericProviderConfiguration,
  removeGenericProviderConfiguration,
} from '../../src/providers/generic-provider-config';
import { createConfiguredProviderRegistry } from '../../src/providers/provider-registry-factory';
import { createTestAppConfig } from '../helpers/test-config';

const temporaryDirectories: string[] = [];

function createCredentialStore() {
  const secrets = new Map<string, string>();
  return {
    kind: 'windows-credential-manager' as const,
    isSupported: () => true,
    readSecret: (target: string) => secrets.get(target) ?? null,
    writeSecret: (target: string, secret: string) => {
      secrets.set(target, secret);
    },
    deleteSecret: (target: string) => {
      secrets.delete(target);
    },
    secrets,
  };
}

function createTemporaryConfigPath(): { cwd: string; configPath: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-provider-'));
  temporaryDirectories.push(cwd);
  return { cwd, configPath: '.pueblo/config.json' };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('generic provider configuration', () => {
  it('stores an API key in the credential store and keeps it out of config.json', () => {
    const credentialStore = createCredentialStore();
    const location = createTemporaryConfigPath();
    const config = createTestAppConfig({ genericProviders: [] });

    const nextConfig = persistGenericProviderConfiguration(config, {
      id: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'provider-secret',
      modelIds: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4'],
      defaultModelId: 'openai/gpt-4.1-mini',
      enabled: true,
      setAsDefault: true,
    }, { ...location, credentialStore });

    expect(nextConfig.defaultProviderId).toBe('openrouter');
    expect(nextConfig.genericProviders[0]).toMatchObject({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(credentialStore.secrets.get(nextConfig.genericProviders[0]!.credentialTarget)).toBe('provider-secret');
    expect(fs.readFileSync(path.join(location.cwd, location.configPath), 'utf8')).not.toContain('provider-secret');
  });

  it('registers configured generic providers with their declared models', () => {
    const credentialStore = createCredentialStore();
    const config = createTestAppConfig({
      defaultProviderId: 'openrouter',
      providers: [{
        providerId: 'openrouter',
        defaultModelId: 'openai/gpt-4.1-mini',
        enabled: true,
        credentialSource: 'windows-credential-manager',
      }],
      genericProviders: [{
        id: 'openrouter',
        displayName: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        credentialTarget: 'Pueblo:Provider:openrouter:test',
        models: [{ id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
      }],
    });
    credentialStore.writeSecret('Pueblo:Provider:openrouter:test', 'provider-secret');

    const registry = createConfiguredProviderRegistry(config, { credentialStore });

    expect(registry.getProfile('openrouter')).toMatchObject({
      name: 'OpenRouter',
      defaultModelId: 'openai/gpt-4.1-mini',
    });
  });

  it('deletes both the provider setting and its credential', () => {
    const credentialStore = createCredentialStore();
    const location = createTemporaryConfigPath();
    const config = createTestAppConfig({
      defaultProviderId: 'openrouter',
      providers: [{
        providerId: 'openrouter',
        defaultModelId: 'gpt-4.1-mini',
        enabled: true,
        credentialSource: 'windows-credential-manager',
      }],
      genericProviders: [{
        id: 'openrouter',
        displayName: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        credentialTarget: 'Pueblo:Provider:openrouter:test',
        models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
      }],
    });
    credentialStore.writeSecret('Pueblo:Provider:openrouter:test', 'provider-secret');

    const nextConfig = removeGenericProviderConfiguration(config, 'openrouter', { ...location, credentialStore });

    expect(nextConfig.genericProviders).toEqual([]);
    expect(nextConfig.providers).toEqual([]);
    expect(credentialStore.secrets.has('Pueblo:Provider:openrouter:test')).toBe(false);
    expect(listGenericProviderConfigurations(nextConfig, credentialStore)).toEqual([]);
  });
});
