import type { AppConfig, ProviderSetting } from '../shared/config';
import type { ProviderAuthState } from '../shared/schema';
import { createDefaultCredentialStore, type CredentialStore } from './credential-store';

export type GitHubCopilotTokenType = 'copilot-access-token' | 'github-auth-token' | 'github-pat';

export interface GitHubCopilotResolvedToken {
  readonly token: string;
  readonly tokenType: GitHubCopilotTokenType;
}

export interface GitHubCopilotAuthStatus {
  readonly providerId: 'github-copilot';
  readonly authState: ProviderAuthState;
  readonly credentialSource: ProviderSetting['credentialSource'];
}

export interface GitHubCopilotAuthDependencies {
  readonly credentialStore?: CredentialStore;
}

function inferGitHubCopilotTokenType(token: string): GitHubCopilotTokenType {
  if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
    return 'github-pat';
  }

  if (token.startsWith('gho_') || token.startsWith('ghu_')) {
    return 'github-auth-token';
  }

  return 'copilot-access-token';
}

export function resolveGitHubCopilotToken(
  config: AppConfig,
  dependencies: GitHubCopilotAuthDependencies = {},
): GitHubCopilotResolvedToken | null {
  const credentialStore = dependencies.credentialStore ?? createDefaultCredentialStore();
  const credentialTarget = config.githubCopilot.credentialTarget?.trim();
  const storedToken = credentialTarget && credentialStore.isSupported()
    ? credentialStore.readSecret(credentialTarget)
    : null;
  const configToken = config.githubCopilot.token?.trim();
  const envToken = process.env.GITHUB_COPILOT_TOKEN?.trim();
  const token = storedToken || configToken || envToken || null;

  if (!token) {
    return null;
  }

  return {
    token,
    tokenType: config.githubCopilot.tokenType ?? inferGitHubCopilotTokenType(token),
  };
}

export function resolveGitHubCopilotAuth(
  config: AppConfig,
  dependencies: GitHubCopilotAuthDependencies = {},
): GitHubCopilotAuthStatus {
  const provider = config.providers.find((candidate) => candidate.providerId === 'github-copilot');
  const token = resolveGitHubCopilotToken(config, dependencies);
  const authState: ProviderAuthState = !token
    ? 'missing'
    : token.tokenType === 'github-pat'
      ? 'invalid'
      : 'configured';

  if (!provider) {
    return {
      providerId: 'github-copilot',
      authState,
      credentialSource: config.githubCopilot.credentialTarget ? 'windows-credential-manager' : 'env',
    };
  }

  return {
    providerId: 'github-copilot',
    authState,
    credentialSource: provider.credentialSource,
  };
}
