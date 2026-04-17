import type { ProviderModel, ProviderProfile } from '../shared/schema';
import type { ProviderRegistryLike } from './provider-profile';
import { ModelNotFoundError, ProviderNotFoundError } from './provider-errors';
import { ProviderRegistry } from './provider-registry';

export interface ListedModel extends ProviderModel {
  readonly providerId: string;
  readonly providerName: string;
}

export interface SelectedModel {
  readonly provider: ProviderProfile;
  readonly model: ProviderModel;
}

export class ModelService {
  constructor(private readonly registry: ProviderRegistry | ProviderRegistryLike) {}

  listModels(): ListedModel[] {
    return this.registry.listProfiles().flatMap((profile) =>
      profile.models.map((model) => ({
        ...model,
        providerId: profile.id,
        providerName: profile.name,
      })),
    );
  }

  selectModel(providerId: string, modelId?: string): SelectedModel {
    const profile = this.registry instanceof ProviderRegistry
      ? this.registry.getProfile(providerId)
      : this.registry.listProfiles().find((candidate) => candidate.id === providerId);

    if (!profile) {
      throw new ProviderNotFoundError(providerId);
    }

    const resolvedModelId = modelId ?? profile.defaultModelId;
    const model = profile.models.find((candidate) => candidate.id === resolvedModelId);

    if (!model) {
      throw new ModelNotFoundError(providerId, resolvedModelId);
    }

    return { provider: profile, model };
  }
}
