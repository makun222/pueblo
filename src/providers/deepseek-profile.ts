import type { ProviderModel, ProviderProfile } from '../shared/schema';
import { createProviderProfile } from './provider-profile';

const DEEPSEEK_CONTEXT_WINDOW = 64_000;

export const DEEPSEEK_MODELS: readonly ProviderModel[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    supportsTools: true,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    supportsTools: true,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  },
];

export type DeepSeekModelId = typeof DEEPSEEK_MODELS[number]['id'];

export function isDeepSeekModelId(value: string | null | undefined): value is DeepSeekModelId {
  return DEEPSEEK_MODELS.some((model) => model.id === value);
}

export function resolveDeepSeekModelId(value: string | null | undefined): DeepSeekModelId {
  return isDeepSeekModelId(value) ? value : 'deepseek-v4-flash';
}

export function createDeepSeekProfile(
  authState: ProviderProfile['authState'],
  defaultModelId?: string | null,
): ProviderProfile {
  return createProviderProfile({
    id: 'deepseek',
    name: 'DeepSeek',
    authState,
    defaultModelId: resolveDeepSeekModelId(defaultModelId),
    models: [...DEEPSEEK_MODELS],
  });
}