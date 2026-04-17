import type { ProviderCapability, ProviderModel, ProviderProfile } from '../shared/schema';
import { providerProfileSchema } from '../shared/schema';

export interface CreateProviderProfileInput {
  readonly id: string;
  readonly name: string;
  readonly defaultModelId: string;
  readonly models: ProviderModel[];
  readonly status?: ProviderProfile['status'];
  readonly authState?: ProviderProfile['authState'];
  readonly capabilities?: Partial<ProviderCapability>;
}

export function createProviderProfile(input: CreateProviderProfileInput): ProviderProfile {
  return providerProfileSchema.parse({
    id: input.id,
    name: input.name,
    status: input.status ?? 'active',
    authState: input.authState ?? 'configured',
    defaultModelId: input.defaultModelId,
    models: input.models,
    capabilities: {
      codeExecution: input.capabilities?.codeExecution ?? true,
      toolUse: input.capabilities?.toolUse ?? true,
      streaming: input.capabilities?.streaming ?? false,
    },
  });
}

export interface ProviderRegistryLike {
  listProfiles(): ProviderProfile[];
}

export function createInMemoryProviderRegistry(profiles: ProviderProfile[]): ProviderRegistryLike {
  return {
    listProfiles(): ProviderProfile[] {
      return [...profiles];
    },
  };
}
