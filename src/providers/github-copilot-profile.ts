import type { ProviderProfile } from '../shared/schema';
import { createProviderProfile } from './provider-profile';

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
      },
    ],
  });
}
