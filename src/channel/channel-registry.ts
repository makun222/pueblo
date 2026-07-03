// ---------------------------------------------------------------------------
// Channel Registry — Register adapter factories by kind (mirrors
// ProviderRegistry's register/get pattern, adapted to ChannelAdapterFactory).
// ---------------------------------------------------------------------------

import type { ChannelAdapterFactory, ChannelConfig, ChannelKind } from './channel-types';
import { ChannelNotFoundError } from './channel-errors';

export class ChannelRegistry {
  private readonly factories = new Map<ChannelKind, ChannelAdapterFactory>();

  register(kind: ChannelKind, factory: ChannelAdapterFactory): void {
    this.factories.set(kind, factory);
  }

  listKinds(): ChannelKind[] {
    return [...this.factories.keys()];
  }

  hasKind(kind: string): boolean {
    return this.factories.has(kind as ChannelKind);
  }

  /** Build an adapter instance for a given channel config */
  getAdapter(config: ChannelConfig): ReturnType<ChannelAdapterFactory> {
    const factory = this.factories.get(config.kind);
    if (!factory) {
      throw new ChannelNotFoundError(config.kind);
    }
    return factory(config);
  }

  getFactory(kind: ChannelKind): ChannelAdapterFactory {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new ChannelNotFoundError(kind);
    }
    return factory;
  }
}
