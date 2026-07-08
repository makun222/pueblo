import { failureResult, successResult, type CommandResult } from '../shared/result';
import type { ProviderProfile } from '../providers/provider-profile';
import type { ProviderModel } from '../shared/schema';

export interface ProviderCommandDependencies {
  readonly listProviderProfiles: () => ProviderProfile[];
  readonly setSelection: (providerId: string, modelId?: string) => void;
  readonly getSelection: () => { providerId: string | null; modelId: string | null };
}

export function createProviderCommand(
  dependencies: ProviderCommandDependencies,
): (args: string[]) => Promise<CommandResult> {
  const { listProviderProfiles, setSelection, getSelection } = dependencies;

  function getProfileModels(profile: ProviderProfile): string[] {
    if (profile.models && profile.models.length > 0) {
      return profile.models.map((m: ProviderModel) => (typeof m === 'string' ? m : m.id ?? m.name ?? ''));
    }
    if (profile.defaultModelId) {
      return [profile.defaultModelId];
    }
    return [];
  }

  return async (args: string[]): Promise<CommandResult> => {
    try {
      if (args.length === 0) {
        // /provider list — show available provider profiles
        const profiles = listProviderProfiles();
        if (profiles.length === 0) {
          return successResult('PROVIDER_LIST', 'No provider profiles available.', { profiles: [] });
        }
        const { providerId: currentProviderId, modelId: currentModelId } = getSelection();
        const lines = profiles.map((p) => {
          const isActive = p.id === currentProviderId;
          const marker = isActive ? ' *' : '  ';
          const models = getProfileModels(p);
          const modelPart =
            models.length > 0
              ? `  models: [${models.join(', ')}]`
              : '';
          const currentModelPart =
            isActive && currentModelId ? `  active: ${currentModelId}` : '';
          return `${marker} ${p.id}${p.name !== p.id ? `  (${p.name})` : ''}${modelPart}${currentModelPart}`;
        });
        return successResult(
          'PROVIDER_LIST',
          `Available provider profiles (${profiles.length}):\n${lines.join('\n')}`,
          { profiles },
        );
      }

      // /provider switch <providerId> [modelId]
      const [providerId, modelId] = args;
      const profiles = listProviderProfiles();
      const profile = profiles.find((p) => p.id === providerId || p.name === providerId);
      if (!profile) {
        return failureResult('PROVIDER_NOT_FOUND', `Provider profile "${providerId}" not found.`, [
          'Use /provider to list available provider profiles.',
        ]);
      }

      if (modelId) {
        const availableModels = getProfileModels(profile);
        if (availableModels.length > 0 && !availableModels.includes(modelId)) {
          return failureResult(
            'MODEL_NOT_FOUND',
            `Model "${modelId}" not found in provider "${profile.id}".`,
            [`Available models: ${availableModels.join(', ')}`],
          );
        }
      }

      setSelection(profile.id, modelId);
      return successResult(
        'PROVIDER_SWITCHED',
        `Switched to provider "${profile.id}"${modelId ? `, model "${modelId}"` : ''}.`,
        { providerId: profile.id, modelId: modelId ?? null },
      );
    } catch (error) {
      return failureResult(
        'PROVIDER_SWITCH_FAILED',
        `Failed to switch provider: ${(error as Error).message}`,
        ['Use /provider to list available provider profiles.'],
      );
    }
  };
}
