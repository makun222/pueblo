import type { MemoryRecord } from "../shared/schema";
import type { ProviderAdapter, ProviderMessage } from "../providers/provider-adapter";

export interface PepeConfig {
  readonly threshold: number;
  readonly relevanceCutoff: number;
  readonly minMemoryCount: number;
  readonly cooldownMs: number;
  readonly maxKeptMemories: number;
}