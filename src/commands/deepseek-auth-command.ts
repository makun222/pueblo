import type { AppConfig } from '../shared/config';
import { failureResult, successResult, type CommandResult } from '../shared/result';
import { loadAppConfig } from '../shared/config';
import type { CredentialStore } from '../providers/credential-store';
import { persistDeepSeekConfiguration } from '../providers/deepseek-auth';
import { isDeepSeekModelId, resolveDeepSeekModelId } from '../providers/deepseek-profile';

export interface DeepSeekAuthCommandDependencies {
  readonly getCurrentConfig: () => AppConfig;
  readonly setCurrentConfig: (config: AppConfig) => void;
  readonly credentialStore?: CredentialStore;
  readonly onConfigured?: (config: AppConfig) => void;
}

export function createDeepSeekAuthCommand(dependencies: DeepSeekAuthCommandDependencies) {
  return (args: string[]): CommandResult => {
    const [apiKey, requestedModelId, requestedBaseUrl] = args;

    if (!apiKey?.trim()) {
      return failureResult('DEEPSEEK_API_KEY_REQUIRED', 'DeepSeek API key is required', [
        'Use /auth-deepseek <apiKey> [defaultModelId] [baseUrl].',
      ]);
    }

    if (requestedModelId && !isDeepSeekModelId(requestedModelId)) {
      return failureResult('DEEPSEEK_MODEL_INVALID', `Unsupported DeepSeek model: ${requestedModelId}`, [
        'Use deepseek-v4-flash or deepseek-v4-pro.',
      ]);
    }

    const nextConfig = persistDeepSeekConfiguration(dependencies.getCurrentConfig(), apiKey.trim(), {
      credentialStore: dependencies.credentialStore,
      defaultModelId: resolveDeepSeekModelId(requestedModelId),
      baseUrl: requestedBaseUrl,
    });

    dependencies.setCurrentConfig(nextConfig);
    dependencies.onConfigured?.(nextConfig);

    const resolvedConfig = loadAppConfig();

    return successResult('DEEPSEEK_AUTH_COMPLETED', 'DeepSeek configuration saved', {
      providerId: 'deepseek',
      defaultModelId: resolveDeepSeekModelId(requestedModelId),
      baseUrl: resolvedConfig.deepseek.baseUrl,
      credentialTarget: resolvedConfig.deepseek.credentialTarget ?? null,
    });
  };
}