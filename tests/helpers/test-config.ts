import path from 'node:path';
import type { AppConfig } from '../../src/shared/config';

type TestAppConfigOverrides = Partial<Omit<AppConfig, 'desktopWindow' | 'deepseek' | 'pepe' | 'githubCopilot'>> & {
  desktopWindow?: Partial<AppConfig['desktopWindow']>;
  deepseek?: Partial<AppConfig['deepseek']>;
  pepe?: Partial<AppConfig['pepe']>;
  githubCopilot?: Partial<AppConfig['githubCopilot']>;
};

export function createTestAppConfig(overrides: TestAppConfigOverrides = {}): AppConfig {
  return {
    databasePath: overrides.databasePath ?? path.join(process.cwd(), '.pueblo', 'test.db'),
    defaultProviderId: overrides.defaultProviderId ?? 'openai',
    defaultAgentProfileId: overrides.defaultAgentProfileId ?? 'code-master',
    defaultSessionId: overrides.defaultSessionId ?? null,
    providers: overrides.providers ?? [
      {
        providerId: 'openai',
        defaultModelId: 'gpt-4.1-mini',
        enabled: true,
        credentialSource: 'env',
      },
    ],
    desktopWindow: {
      enabled: overrides.desktopWindow?.enabled ?? true,
      title: overrides.desktopWindow?.title ?? 'Pueblo',
      width: overrides.desktopWindow?.width ?? 1200,
      height: overrides.desktopWindow?.height ?? 820,
    },
    deepseek: {
      apiKey: overrides.deepseek?.apiKey,
      credentialTarget: overrides.deepseek?.credentialTarget,
      baseUrl: overrides.deepseek?.baseUrl ?? 'https://api.deepseek.com',
    },
    pepe: {
      enabled: overrides.pepe?.enabled ?? true,
      providerId: overrides.pepe?.providerId ?? null,
      modelId: overrides.pepe?.modelId ?? null,
      embeddingProviderId: overrides.pepe?.embeddingProviderId ?? null,
      embeddingModelId: overrides.pepe?.embeddingModelId ?? null,
      embeddingBackend: overrides.pepe?.embeddingBackend ?? 'sentence-transformers',
      localEmbeddingModel: overrides.pepe?.localEmbeddingModel ?? 'all-MiniLM-L6-v2',
      pythonCommand: overrides.pepe?.pythonCommand ?? 'python',
      flushIntervalMs: overrides.pepe?.flushIntervalMs ?? 2_000,
      summaryIntervalMs: overrides.pepe?.summaryIntervalMs ?? 5_000,
      resultTopK: overrides.pepe?.resultTopK ?? 8,
      similarityThreshold: overrides.pepe?.similarityThreshold ?? 0.2,
      workingDirectoryPattern: overrides.pepe?.workingDirectoryPattern ?? 'agent-{agentInstanceId}',
    },
    githubCopilot: {
      apiUrl: overrides.githubCopilot?.apiUrl ?? 'https://api.githubcopilot.com/chat/completions',
      exchangeUrl: overrides.githubCopilot?.exchangeUrl ?? 'https://api.github.com/copilot_internal/v2/token',
      deviceCodeUrl: overrides.githubCopilot?.deviceCodeUrl ?? 'https://github.com/login/device/code',
      oauthAccessTokenUrl: overrides.githubCopilot?.oauthAccessTokenUrl ?? 'https://github.com/login/oauth/access_token',
      oauthClientId: overrides.githubCopilot?.oauthClientId,
      scopes: overrides.githubCopilot?.scopes ?? [],
      credentialTarget: overrides.githubCopilot?.credentialTarget,
      tokenType: overrides.githubCopilot?.tokenType,
      token: overrides.githubCopilot?.token,
      userAgent: overrides.githubCopilot?.userAgent ?? 'Pueblo/0.1.0',
      editorVersion: overrides.githubCopilot?.editorVersion ?? 'vscode/1.99.0',
      editorPluginVersion: overrides.githubCopilot?.editorPluginVersion ?? 'copilot-chat/0.43.0',
      integrationId: overrides.githubCopilot?.integrationId ?? 'vscode-chat',
    },
  };
}