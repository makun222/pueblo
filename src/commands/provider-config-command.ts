import type { AppConfig } from '../shared/config';
import { failureResult, successResult, type CommandResult } from '../shared/result';
import { loadAppConfig } from '../shared/config';
import type { CliStartupSetupResult } from '../cli/index';
import type { CredentialStore } from '../providers/credential-store';
import { persistDeepSeekConfiguration } from '../providers/deepseek-auth';
import { isDeepSeekModelId, resolveDeepSeekModelId } from '../providers/deepseek-profile';

export interface ProviderConfigCommandDependencies {
  readonly getCurrentConfig: () => AppConfig;
  readonly setCurrentConfig: (config: AppConfig) => void;
  readonly runGitHubCopilotLogin: () => Promise<CliStartupSetupResult>;
  readonly credentialStore?: CredentialStore;
  readonly onConfigured?: (providerId: string, config: AppConfig) => void;
}

export function createProviderConfigCommand(dependencies: ProviderConfigCommandDependencies) {
  return async (args: string[]): Promise<CommandResult> => {
    if (args.length === 0) {
      return successResult('PROVIDER_CONFIG_HELP', 'Provider configuration commands', {
        commands: [
          '/provider-config github-copilot login',
          '/provider-config deepseek set-key <apiKey> [defaultModelId] [baseUrl]',
        ],
      });
    }

    const [providerId, action, ...rest] = args;

    if (providerId === 'github-copilot') {
      return configureGitHubCopilot(action, dependencies);
    }

    if (providerId === 'deepseek') {
      return configureDeepSeek(action, rest, dependencies);
    }

    return failureResult('PROVIDER_CONFIG_UNKNOWN_PROVIDER', `Unsupported provider: ${providerId}`, [
      'Use /provider-config with github-copilot or deepseek.',
    ]);
  };
}

async function configureGitHubCopilot(
  action: string | undefined,
  dependencies: ProviderConfigCommandDependencies,
): Promise<CommandResult> {
  if (action !== 'login') {
    return failureResult('PROVIDER_CONFIG_INVALID_ACTION', 'GitHub Copilot requires the login action', [
      'Use /provider-config github-copilot login.',
    ]);
  }

  const setup = await dependencies.runGitHubCopilotLogin();

  if (!setup.performed) {
    return successResult('AUTH_ALREADY_CONFIGURED', 'GitHub Copilot is already configured');
  }

  if (!setup.configured) {
    return failureResult('AUTH_LOGIN_FAILED', setup.errorMessage ?? 'GitHub Copilot login was not completed', [
      'Check githubCopilot.oauthClientId and network access, then retry.',
    ]);
  }

  dependencies.setCurrentConfig(setup.config);
  dependencies.onConfigured?.('github-copilot', setup.config);

  return successResult('AUTH_LOGIN_COMPLETED', 'GitHub Copilot login completed');
}

function configureDeepSeek(
  action: string | undefined,
  args: string[],
  dependencies: ProviderConfigCommandDependencies,
): CommandResult {
  if (action !== 'set-key') {
    return failureResult('PROVIDER_CONFIG_INVALID_ACTION', 'DeepSeek requires the set-key action', [
      'Use /provider-config deepseek set-key <apiKey> [defaultModelId] [baseUrl].',
    ]);
  }

  const [apiKey, requestedModelId, requestedBaseUrl] = args;

  if (!apiKey?.trim()) {
    return failureResult('DEEPSEEK_API_KEY_REQUIRED', 'DeepSeek API key is required', [
      'Use /provider-config deepseek set-key <apiKey> [defaultModelId] [baseUrl].',
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
  dependencies.onConfigured?.('deepseek', nextConfig);

  const resolvedConfig = loadAppConfig();

  return successResult('DEEPSEEK_AUTH_COMPLETED', 'DeepSeek configuration saved', {
    providerId: 'deepseek',
    defaultModelId: resolveDeepSeekModelId(requestedModelId),
    baseUrl: resolvedConfig.deepseek.baseUrl,
    credentialTarget: resolvedConfig.deepseek.credentialTarget ?? null,
  });
}