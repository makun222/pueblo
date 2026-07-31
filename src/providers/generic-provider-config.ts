import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, GenericProviderConfig, ProviderSetting } from '../shared/config';
import { loadAppConfig, resolveConfigPath } from '../shared/config';
import { createDefaultCredentialStore, type CredentialStore } from './credential-store';

export interface GenericProviderConfigurationInput {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly modelIds: readonly string[];
  readonly defaultModelId: string;
  readonly enabled: boolean;
  readonly setAsDefault: boolean;
}

export interface GenericProviderConfiguration {
  readonly providerId: string;
  readonly providerType: 'openai-compatible';
  readonly displayName: string;
  readonly baseUrl: string;
  readonly modelIds: string[];
  readonly defaultModelId: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly apiKeyConfigured: boolean;
}

export interface GenericProviderConfigurationOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly credentialStore?: CredentialStore;
}

const RESERVED_PROVIDER_IDS = new Set(['github-copilot', 'deepseek']);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function listGenericProviderConfigurations(
  config: AppConfig,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): GenericProviderConfiguration[] {
  const settings = new Map(config.providers.map((provider) => [provider.providerId, provider]));

  return config.genericProviders.map((provider) => {
    const setting = settings.get(provider.id);
    const apiKeyConfigured = credentialStore.isSupported()
      ? Boolean(credentialStore.readSecret(provider.credentialTarget)?.trim())
      : false;

    return {
      providerId: provider.id,
      providerType: 'openai-compatible',
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      modelIds: provider.models.map((model) => model.id),
      defaultModelId: setting?.defaultModelId ?? provider.models[0]!.id,
      enabled: setting?.enabled ?? true,
      isDefault: config.defaultProviderId === provider.id,
      apiKeyConfigured,
    };
  });
}

export function resolveGenericProviderApiKey(
  provider: GenericProviderConfig,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): string | null {
  if (!credentialStore.isSupported()) {
    return null;
  }

  return credentialStore.readSecret(provider.credentialTarget)?.trim() || null;
}

export function persistGenericProviderConfiguration(
  config: AppConfig,
  input: GenericProviderConfigurationInput,
  options: GenericProviderConfigurationOptions = {},
): AppConfig {
  const normalized = normalizeInput(input);
  const credentialStore = options.credentialStore ?? createDefaultCredentialStore();
  if (!credentialStore.isSupported()) {
    throw new Error('Generic provider API keys require Windows Credential Manager.');
  }

  const existingProvider = config.genericProviders.find((provider) => provider.id === normalized.id);
  if (!existingProvider && !normalized.apiKey) {
    throw new Error('An API key is required when creating a provider.');
  }

  const credentialTarget = existingProvider?.credentialTarget ?? createCredentialTarget(normalized.id);
  if (normalized.apiKey) {
    credentialStore.writeSecret(credentialTarget, normalized.apiKey);
  }

  const genericProvider: GenericProviderConfig = {
    id: normalized.id,
    displayName: normalized.displayName,
    baseUrl: normalized.baseUrl,
    credentialTarget,
    models: normalized.modelIds.map((id) => ({
      id,
      name: id,
      supportsTools: true,
    })),
  };
  const providerSetting: ProviderSetting = {
    providerId: normalized.id,
    defaultModelId: normalized.defaultModelId,
    enabled: normalized.enabled,
    credentialSource: 'windows-credential-manager',
  };
  const nextConfig: AppConfig = {
    ...config,
    defaultProviderId: normalized.setAsDefault ? normalized.id : config.defaultProviderId,
    genericProviders: replaceById(config.genericProviders, genericProvider),
    providers: replaceByProviderId(config.providers, providerSetting),
  };

  writeConfig(nextConfig, options);
  return loadAppConfig({ cwd: options.cwd, configPath: options.configPath });
}

export function removeGenericProviderConfiguration(
  config: AppConfig,
  providerId: string,
  options: GenericProviderConfigurationOptions = {},
): AppConfig {
  const id = providerId.trim();
  const provider = config.genericProviders.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new Error(`Generic provider "${id}" was not found.`);
  }

  const credentialStore = options.credentialStore ?? createDefaultCredentialStore();
  credentialStore.deleteSecret?.(provider.credentialTarget);
  const remainingGenericProviders = config.genericProviders.filter((candidate) => candidate.id !== id);
  const remainingProviders = config.providers.filter((candidate) => candidate.providerId !== id);
  const nextDefaultProviderId = config.defaultProviderId === id
    ? remainingProviders.find((candidate) => candidate.enabled)?.providerId ?? null
    : config.defaultProviderId;
  const nextConfig: AppConfig = {
    ...config,
    defaultProviderId: nextDefaultProviderId,
    genericProviders: remainingGenericProviders,
    providers: remainingProviders,
  };

  writeConfig(nextConfig, options);
  return loadAppConfig({ cwd: options.cwd, configPath: options.configPath });
}

function normalizeInput(input: GenericProviderConfigurationInput): GenericProviderConfigurationInput {
  const id = input.id.trim();
  const displayName = input.displayName.trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const modelIds = Array.from(new Set(input.modelIds.map((modelId) => modelId.trim()).filter(Boolean)));
  const defaultModelId = input.defaultModelId.trim();
  const apiKey = input.apiKey?.trim() || null;

  if (!PROVIDER_ID_PATTERN.test(id) || RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error('Provider id must use lowercase letters, numbers, "-" or "_", and cannot use a built-in provider id.');
  }
  if (!displayName) {
    throw new Error('Provider display name is required.');
  }
  if (modelIds.length === 0 || !modelIds.includes(defaultModelId)) {
    throw new Error('Default model id must match one configured model id.');
  }
  if (input.setAsDefault && !input.enabled) {
    throw new Error('A default provider must be enabled.');
  }

  return { ...input, id, displayName, baseUrl, modelIds, defaultModelId, apiKey };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Provider base URL must use HTTP or HTTPS.');
  }
  return url.toString().replace(/\/+$/, '');
}

function replaceById<T extends { readonly id: string }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  return index === -1 ? [...values, value] : values.map((candidate) => candidate.id === value.id ? value : candidate);
}

function replaceByProviderId(values: readonly ProviderSetting[], value: ProviderSetting): ProviderSetting[] {
  const index = values.findIndex((candidate) => candidate.providerId === value.providerId);
  return index === -1 ? [...values, value] : values.map((candidate) => candidate.providerId === value.providerId ? value : candidate);
}

function createCredentialTarget(providerId: string): string {
  return `Pueblo:Provider:${providerId}:${Date.now()}`;
}

function writeConfig(config: AppConfig, options: GenericProviderConfigurationOptions): void {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ cwd, configPath: options.configPath });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
