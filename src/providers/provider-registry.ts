import type { ProviderProfile } from '../shared/schema';
import { ModelNotFoundError, ProviderAuthError, ProviderNotFoundError, ProviderUnavailableError } from './provider-errors';
import type { ProviderAdapter } from './provider-adapter';

interface ProviderEntry {
  readonly profile: ProviderProfile;
  readonly adapter: ProviderAdapter;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();

  register(profile: ProviderProfile, adapter: ProviderAdapter): void {
    this.entries.set(profile.id, { profile, adapter });
  }

  listProfiles(): ProviderProfile[] {
    return [...this.entries.values()].map((entry) => entry.profile);
  }

  getProfile(providerId: string): ProviderProfile {
    const entry = this.entries.get(providerId);

    if (!entry) {
      throw new ProviderNotFoundError(providerId);
    }

    if (entry.profile.status !== 'active') {
      throw new ProviderUnavailableError(providerId);
    }

    if (entry.profile.authState !== 'configured') {
      throw new ProviderAuthError(providerId);
    }

    return entry.profile;
  }

  getAdapter(providerId: string): ProviderAdapter {
    const entry = this.entries.get(providerId);

    if (!entry) {
      throw new ProviderNotFoundError(providerId);
    }

    return entry.adapter;
  }

  ensureModel(providerId: string, modelId: string): ProviderProfile {
    const profile = this.getProfile(providerId);
    const model = profile.models.find((candidate) => candidate.id === modelId);

    if (!model) {
      throw new ModelNotFoundError(providerId, modelId);
    }

    return profile;
  }
}
