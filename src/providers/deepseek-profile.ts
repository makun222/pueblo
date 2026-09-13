import type { ProviderModel, ProviderProfile } from '../shared/schema';
import { createProviderProfile } from './provider-profile';

//const DEEPSEEK_CONTEXT_WINDOW = 64_000;
const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_MODELS: readonly ProviderModel[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    supportsTools: true,
    // 2026-09-13 实测：deepseek-v4-flash 接受 image_url content part（HTTP 200，模型正确描述了图片内容，
    // 上游响应的 model 字段为 deepseek-flash）。此前的 false 是过时标记，会让工具读图/素材目录注入整条链路被闸门拦掉。
    supportsVision: true,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    supportsTools: true,
    supportsVision: false,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision (Experimental)',
    supportsTools: true,
    supportsVision: true,
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