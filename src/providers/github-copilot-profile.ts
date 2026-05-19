import type { ProviderProfile } from '../shared/schema';
import { createProviderProfile } from './provider-profile';

const GITHUB_COPILOT_CONTEXT_WINDOW = 32_000;

export function createGitHubCopilotProfile(authState: ProviderProfile['authState']): ProviderProfile {
  return createProviderProfile({
    id: 'github-copilot',
    name: 'GitHub Copilot',
    authState,
    defaultModelId: 'copilot-chat',
    models: [
      {
        id: 'copilot-chat',
        name: 'GPT-5.4',
        supportsTools: true,
        contextWindow: GITHUB_COPILOT_CONTEXT_WINDOW,
      },
    ],
  });
}
