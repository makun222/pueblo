import type { AppConfig, ProviderSetting } from '../shared/config';
import type { ProviderAuthState } from '../shared/schema';

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

function inferGitHubCopilotTokenType(token: string): GitHubCopilotTokenType {
  if (token.startsWith('ghp_') || token.startsWith('github_pat_')) {
    return 'github-pat';
  }

  if (token.startsWith('gho_') || token.startsWith('ghu_')) {
    return 'github-auth-token';
  }

  return 'copilot-access-token';
}

export function resolveGitHubCopilotToken(config: AppConfig): GitHubCopilotResolvedToken | null {
  const configToken = config.githubCopilot.token?.trim();
  const envToken = process.env.GITHUB_COPILOT_TOKEN?.trim();
  const token = configToken || envToken || null;

  if (!token) {
    return null;
  }

  return {
    token,
    tokenType: config.githubCopilot.tokenType ?? inferGitHubCopilotTokenType(token),
  };
}

export function resolveGitHubCopilotAuth(config: AppConfig): GitHubCopilotAuthStatus {
  const provider = config.providers.find((candidate) => candidate.providerId === 'github-copilot');
  const token = resolveGitHubCopilotToken(config);
  const authState: ProviderAuthState = !token
    ? 'missing'
    : token.tokenType === 'github-pat'
      ? 'invalid'
      : 'configured';

  if (!provider) {
    return {
      providerId: 'github-copilot',
      authState,
      credentialSource: 'env',
    };
  }

  return {
    providerId: 'github-copilot',
    authState,
    credentialSource: provider.credentialSource,
  };
}
