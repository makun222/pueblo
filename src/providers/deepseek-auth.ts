import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, ProviderSetting } from '../shared/config';
import { loadAppConfig, resolveConfigPath } from '../shared/config';
import type { ProviderAuthState } from '../shared/schema';
import { createDefaultCredentialStore, type CredentialStore } from './credential-store';
import { resolveDeepSeekModelId, type DeepSeekModelId } from './deepseek-profile';

export interface DeepSeekResolvedApiKey {
  readonly apiKey: string;
}

export interface DeepSeekAuthStatus {
  readonly providerId: 'deepseek';
  readonly authState: ProviderAuthState;
  readonly credentialSource: ProviderSetting['credentialSource'];
}

export interface DeepSeekAuthDependencies {
  readonly credentialStore?: CredentialStore;
}

export interface PersistDeepSeekConfigurationOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly credentialStore?: CredentialStore;
  readonly defaultModelId?: string | null;
  readonly baseUrl?: string | null;
}

const DEEPSEEK_ENV_API_KEY = 'DEEPSEEK_API_KEY';

export function resolveDeepSeekApiKey(
  config: AppConfig,
  dependencies: DeepSeekAuthDependencies = {},
): DeepSeekResolvedApiKey | null {
  const credentialStore = dependencies.credentialStore ?? createDefaultCredentialStore();
  const credentialTarget = config.deepseek.credentialTarget?.trim();
  const storedApiKey = credentialTarget && credentialStore.isSupported()
    ? credentialStore.readSecret(credentialTarget)
    : null;
  const configApiKey = config.deepseek.apiKey?.trim();
  const envApiKey = process.env[DEEPSEEK_ENV_API_KEY]?.trim();
  const apiKey = storedApiKey || configApiKey || envApiKey || null;

  if (!apiKey) {
    return null;
  }

  return { apiKey };
}

export function resolveDeepSeekAuth(
  config: AppConfig,
  dependencies: DeepSeekAuthDependencies = {},
): DeepSeekAuthStatus {
  const provider = config.providers.find((candidate) => candidate.providerId === 'deepseek');
  const apiKey = resolveDeepSeekApiKey(config, dependencies);
  const authState: ProviderAuthState = apiKey ? 'configured' : 'missing';

  if (!provider) {
    return {
      providerId: 'deepseek',
      authState,
      credentialSource: config.deepseek.credentialTarget ? 'windows-credential-manager' : 'env',
    };
  }

  return {
    providerId: 'deepseek',
    authState,
    credentialSource: provider.credentialSource,
  };
}

export function persistDeepSeekConfiguration(
  config: AppConfig,
  apiKey: string,
  options: PersistDeepSeekConfigurationOptions = {},
): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ cwd, configPath: options.configPath });
  const configDir = path.dirname(configPath);
  const credentialStore = options.credentialStore ?? createDefaultCredentialStore();
  const current = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    : {};
  const defaultModelId = resolveDeepSeekModelId(options.defaultModelId);
  const baseUrl = normalizeDeepSeekBaseUrl(options.baseUrl ?? config.deepseek.baseUrl);

  if (credentialStore.isSupported()) {
    const credentialTarget = config.deepseek.credentialTarget?.trim() || createDeepSeekCredentialTarget();
    credentialStore.writeSecret(credentialTarget, apiKey);

    const currentDeepSeek = typeof current.deepseek === 'object' && current.deepseek !== null
      ? current.deepseek as Record<string, unknown>
      : {};
    const { apiKey: _discardedCurrentApiKey, ...currentDeepSeekWithoutKey } = currentDeepSeek;
    const { apiKey: _discardedConfigApiKey, ...configDeepSeekWithoutKey } = config.deepseek;

    const nextConfig = {
      ...current,
      databasePath: config.databasePath,
      defaultProviderId: config.defaultProviderId ?? 'deepseek',
      defaultAgentProfileId: config.defaultAgentProfileId,
      defaultSessionId: config.defaultSessionId,
      providers: ensureDeepSeekProviderConfig(current.providers, 'windows-credential-manager', defaultModelId),
      desktopWindow: config.desktopWindow,
      githubCopilot: {
        ...(typeof current.githubCopilot === 'object' && current.githubCopilot !== null ? current.githubCopilot : {}),
        ...config.githubCopilot,
      },
      deepseek: {
        ...currentDeepSeekWithoutKey,
        ...configDeepSeekWithoutKey,
        baseUrl,
        credentialTarget,
      },
    };

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
    return loadAppConfig({ cwd, configPath: options.configPath });
  }

  const nextConfig = {
    ...current,
    databasePath: config.databasePath,
    defaultProviderId: config.defaultProviderId ?? 'deepseek',
    defaultAgentProfileId: config.defaultAgentProfileId,
    defaultSessionId: config.defaultSessionId,
    providers: ensureDeepSeekProviderConfig(current.providers, 'config-file', defaultModelId),
    desktopWindow: config.desktopWindow,
    githubCopilot: {
      ...(typeof current.githubCopilot === 'object' && current.githubCopilot !== null ? current.githubCopilot : {}),
      ...config.githubCopilot,
    },
    deepseek: {
      ...(typeof current.deepseek === 'object' && current.deepseek !== null ? current.deepseek : {}),
      ...config.deepseek,
      baseUrl,
      apiKey,
    },
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
  return loadAppConfig({ cwd, configPath: options.configPath });
}

function ensureDeepSeekProviderConfig(
  currentProviders: unknown,
  credentialSource: 'config-file' | 'windows-credential-manager',
  defaultModelId: DeepSeekModelId,
): Array<Record<string, unknown>> {
  const providers = Array.isArray(currentProviders) ? [...currentProviders] as Array<Record<string, unknown>> : [];
  const index = providers.findIndex((provider) => provider.providerId === 'deepseek');
  const deepSeekProvider = {
    providerId: 'deepseek',
    defaultModelId,
    enabled: true,
    credentialSource,
  };

  if (index === -1) {
    providers.push(deepSeekProvider);
    return providers;
  }

  providers[index] = {
    ...providers[index],
    ...deepSeekProvider,
  };

  return providers;
}

function createDeepSeekCredentialTarget(): string {
  return `Pueblo:DeepSeek:${Date.now()}`;
}

function normalizeDeepSeekBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : 'https://api.deepseek.com';
}