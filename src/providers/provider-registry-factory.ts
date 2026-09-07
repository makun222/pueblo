import type { AppConfig } from '../shared/config';
import { DeepSeekAdapter } from './deepseek-adapter';
import { resolveDeepSeekApiKey, resolveDeepSeekAuth } from './deepseek-auth';
import { createDeepSeekProfile } from './deepseek-profile';
import { GitHubCopilotAdapter } from './github-copilot-adapter';
import { resolveGitHubCopilotAuth, resolveGitHubCopilotToken } from './github-copilot-auth';
import { createDefaultCredentialStore, type CredentialStore } from './credential-store';
import { createGitHubCopilotProfile } from './github-copilot-profile';
import { InMemoryProviderAdapter } from './provider-adapter';
import { OpenAICompatibleAdapter } from './openai-compatible-adapter';
import { resolveGenericProviderApiKey } from './generic-provider-config';
import { createProviderProfile } from './provider-profile';
import { ProviderRegistry } from './provider-registry';

export interface CreateConfiguredProviderRegistryOptions {
  readonly credentialStore?: CredentialStore;
}

export function createConfiguredProviderRegistry(
  config: AppConfig,
  options: CreateConfiguredProviderRegistryOptions = {},
): ProviderRegistry {
  const credentialStore = options.credentialStore ?? createDefaultCredentialStore();
  const providerRegistry = new ProviderRegistry();
  const githubCopilotAuth = resolveGitHubCopilotAuth(config, { credentialStore });
  const deepSeekAuth = resolveDeepSeekAuth(config, { credentialStore });
  const fallbackProviders = config.providers.length > 0
    ? config.providers
    : [createFallbackProviderSetting(config.defaultProviderId, githubCopilotAuth.credentialSource, deepSeekAuth.credentialSource)];
  const providerSettings = fallbackProviders.some((provider) => provider.providerId === 'github-copilot')
    ? fallbackProviders
    : [
        ...fallbackProviders,
        {
          providerId: 'github-copilot',
          defaultModelId: 'copilot-chat',
          enabled: true,
          credentialSource: githubCopilotAuth.credentialSource,
        },
      ];

  for (const providerSetting of providerSettings) {
    if (!providerSetting.enabled) {
      continue;
    }

    if (providerSetting.providerId === 'github-copilot') {
      registerGitHubCopilotProvider(providerRegistry, config, credentialStore);
      continue;
    }

    if (providerSetting.providerId === 'deepseek') {
      registerDeepSeekProvider(providerRegistry, config, providerSetting.defaultModelId, credentialStore);
      continue;
    }

    const genericProvider = config.genericProviders.find((provider) => provider.id === providerSetting.providerId);
    if (genericProvider) {
      registerGenericProvider(providerRegistry, genericProvider, providerSetting.defaultModelId, credentialStore);
      continue;
    }

    const profile = createProviderProfile({
      id: providerSetting.providerId,
      name: providerSetting.providerId,
      authState: 'configured',
      defaultModelId: providerSetting.defaultModelId,
      models: [
        {
          id: providerSetting.defaultModelId,
          name: providerSetting.defaultModelId,
          supportsTools: true,
          supportsVision: false,
        },
      ],
    });

    providerRegistry.register(profile, new InMemoryProviderAdapter(profile.id, 'Task completed'));
  }

  return providerRegistry;
}

export function registerGenericProvider(
  providerRegistry: ProviderRegistry,
  provider: AppConfig['genericProviders'][number],
  defaultModelId: string | null | undefined,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): void {
  const apiKey = resolveGenericProviderApiKey(provider, credentialStore);
  const resolvedDefaultModelId = defaultModelId && provider.models.some((model) => model.id === defaultModelId)
    ? defaultModelId
    : provider.models[0]!.id;

  providerRegistry.register(
    createProviderProfile({
      id: provider.id,
      name: provider.displayName,
      authState: apiKey ? 'configured' : 'missing',
      defaultModelId: resolvedDefaultModelId,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        supportsTools: model.supportsTools,
        supportsVision: false,
        contextWindow: model.contextWindow,
      })),
    }),
    new OpenAICompatibleAdapter({
      apiKey: apiKey ?? '',
      baseUrl: provider.baseUrl,
    }),
  );
}

function registerGitHubCopilotProvider(
  providerRegistry: ProviderRegistry,
  config: AppConfig,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): void {
  const githubCopilotAuth = resolveGitHubCopilotAuth(config, { credentialStore });
  const resolvedToken = resolveGitHubCopilotToken(config, { credentialStore });

  providerRegistry.register(
    createGitHubCopilotProfile(githubCopilotAuth.authState),
    new GitHubCopilotAdapter({
      token: resolvedToken?.token ?? '',
      tokenType: resolvedToken?.tokenType,
      apiUrl: config.githubCopilot.apiUrl,
      exchangeUrl: config.githubCopilot.exchangeUrl,
      userAgent: config.githubCopilot.userAgent,
      editorVersion: config.githubCopilot.editorVersion,
      editorPluginVersion: config.githubCopilot.editorPluginVersion,
      integrationId: config.githubCopilot.integrationId,
    }),
  );
}

function registerDeepSeekProvider(
  providerRegistry: ProviderRegistry,
  config: AppConfig,
  defaultModelId?: string | null,
  credentialStore: CredentialStore = createDefaultCredentialStore(),
): void {
  const deepSeekAuth = resolveDeepSeekAuth(config, { credentialStore });
  const resolvedApiKey = resolveDeepSeekApiKey(config, { credentialStore });

  providerRegistry.register(
    createDeepSeekProfile(deepSeekAuth.authState, defaultModelId),
    new DeepSeekAdapter({
      apiKey: resolvedApiKey?.apiKey ?? '',
      baseUrl: config.deepseek.baseUrl,
    }),
  );
}

function createFallbackProviderSetting(
  providerId: string | null,
  githubCredentialSource: ReturnType<typeof resolveGitHubCopilotAuth>['credentialSource'],
  deepseekCredentialSource: ReturnType<typeof resolveDeepSeekAuth>['credentialSource'],
) {
  if (providerId === 'github-copilot') {
    return {
      providerId,
      defaultModelId: 'copilot-chat',
      enabled: true,
      credentialSource: githubCredentialSource,
    };
  }

  if (providerId === 'deepseek') {
    return {
      providerId,
      defaultModelId: 'deepseek-v4-flash',
      enabled: true,
      credentialSource: deepseekCredentialSource,
    };
  }

  return {
    providerId: providerId ?? 'openai',
    defaultModelId: 'gpt-4.1-mini',
    enabled: true,
    credentialSource: 'env' as const,
  };
}