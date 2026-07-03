// ---------------------------------------------------------------------------
// Channel Registry Factory — Builds a ChannelRegistry with built-in adapters.
// Mirrors provider-registry-factory's role of registering known providers.
// ---------------------------------------------------------------------------

import type { ChannelConfig } from './channel-types';
import { ChannelRegistry } from './channel-registry';
import { createFeishuChannelAdapter } from './channels/feishu/feishu-adapter';
import type { CredentialStore } from '../providers/credential-store';

export interface CreateChannelRegistryOptions {
  readonly credentialStore?: CredentialStore;
}

export function createChannelRegistry(options: CreateChannelRegistryOptions = {}): ChannelRegistry {
  const registry = new ChannelRegistry();
  const credentialStore = options.credentialStore;

  registry.register('feishu', (config: ChannelConfig) =>
    createFeishuChannelAdapter(config, credentialStore),
  );

  return registry;
}
