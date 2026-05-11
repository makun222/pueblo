import type { AppConfig, PepeConfig, ProviderSetting } from '../shared/config';
import type { MemoryRecord } from '../shared/schema';
import type { ProviderRegistry } from '../providers/provider-registry';
import { resolveDeepSeekModelId } from '../providers/deepseek-profile';

export interface PepeSemanticTarget {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SummarizePepeMemoryInput {
  readonly memory: MemoryRecord;
  readonly currentInput?: string;
}

export interface PepeSemanticClientConfig extends Pick<AppConfig, 'defaultProviderId' | 'providers'> {
  readonly pepe: Pick<PepeConfig, 'providerId' | 'modelId' | 'embeddingProviderId' | 'embeddingModelId'>;
}

export class PepeSemanticClient {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly config: PepeSemanticClientConfig,
  ) {}

  getSummaryTarget(): PepeSemanticTarget | null {
    if (this.config.pepe.providerId && this.config.pepe.modelId) {
      return {
        providerId: this.config.pepe.providerId,
        modelId: this.config.pepe.modelId,
      };
    }

    return resolveDeepSeekSummaryTarget(this.config);
  }

  getEmbeddingTarget(): PepeSemanticTarget | null {
    if (this.config.pepe.embeddingProviderId && this.config.pepe.embeddingModelId) {
      return {
        providerId: this.config.pepe.embeddingProviderId,
        modelId: this.config.pepe.embeddingModelId,
      };
    }

    return this.getSummaryTarget();
  }

  isConfigured(): boolean {
    return this.getSummaryTarget() !== null;
  }

  async summarizeMemory(input: SummarizePepeMemoryInput): Promise<string | null> {
    const target = this.getSummaryTarget();
    if (!target) {
      return null;
    }

    this.providerRegistry.ensureModel(target.providerId, target.modelId);
    const adapter = this.providerRegistry.getAdapter(target.providerId);
    const summaryPrompt = buildSummaryPrompt(input.memory, input.currentInput);
    const result = await adapter.runTask({
      modelId: target.modelId,
      inputContextSummary: [
/*         'You are Pepe, a memory distillation service.',
        'Summarize the memory into a concise technical note for future retrieval.',
        'Prefer one or two sentences. Keep important entities and decisions.', */
        '你是Pepe，一个记忆提炼服务。',
        '将记忆总结为简明的技术笔记以便将来检索。',
        '最好使用一到两句话。保留重要的实体和决策，路径及文件名。',
      ].join('\n'),
      goal: summaryPrompt,
    });

    const normalized = result.outputSummary.trim();
    return normalized.length > 0 ? normalized : null;
  }
}

function buildSummaryPrompt(memory: MemoryRecord, currentInput?: string): string {
  const contextHint = currentInput?.trim()
    ? `Current input to relate against:\n${currentInput.trim()}\n\n`
    : '';

  return [
    contextHint,
    `Memory title: ${memory.title}`,
    `Memory content:\n${memory.content}`,
    '',
    'Return only the distilled summary text.',
  ].join('\n');
}

function resolveDeepSeekSummaryTarget(config: Pick<PepeSemanticClientConfig, 'defaultProviderId' | 'providers'>): PepeSemanticTarget | null {
  const enabledDeepSeekProvider = config.providers.find((provider) => provider.providerId === 'deepseek' && provider.enabled);
  if (enabledDeepSeekProvider) {
    return {
      providerId: 'deepseek',
      modelId: resolveDeepSeekProviderModelId(enabledDeepSeekProvider),
    };
  }

  if (config.defaultProviderId === 'deepseek') {
    return {
      providerId: 'deepseek',
      modelId: resolveDeepSeekModelId(null),
    };
  }

  return null;
}

function resolveDeepSeekProviderModelId(provider: ProviderSetting): string {
  return resolveDeepSeekModelId(provider.defaultModelId);
}