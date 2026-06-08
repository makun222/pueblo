import type { AppConfig, PepeConfig, ProviderSetting } from '../shared/config';
import type { MemoryRecord } from '../shared/schema';
import { ProviderError } from '../providers/provider-errors';
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
    const target = this.getSummaryTarget();
    return target !== null && this.canRunTarget(target);
  }

  async summarizeMemory(input: SummarizePepeMemoryInput): Promise<string | null> {
    const target = this.getSummaryTarget();
    if (!target || !this.canRunTarget(target)) {
      return null;
    }

    try {
      const adapter = this.providerRegistry.getAdapter(target.providerId);
      const summaryPrompt = buildSummaryPrompt(input.memory, input.currentInput);
      const result = await adapter.runTask({
        modelId: target.modelId,
        inputContextSummary: [
          '-你是Pepe，一个记忆提炼服务。',
          '-将一轮或多轮记忆总结为简明的技术笔记以便将来检索和回顾。',
          '-使用尽量简短的文字进行总结，包括完成的工作、决策信息，与涉及重要的实体、路径、文件名。',
          '-涉及tool-results的，主要总结影响了哪些文件，不要保留低价值的细节。',
        ].join('\n'),
        goal: summaryPrompt,
      });

      const normalized = result.outputSummary.trim();
      return normalized.length > 0 ? normalized : null;
    } catch (error) {
      if (error instanceof ProviderError) {
        return null;
      }

      throw error;
    }
  }

  private canRunTarget(target: PepeSemanticTarget): boolean {
    try {
      this.providerRegistry.ensureModel(target.providerId, target.modelId);
      return true;
    } catch {
      return false;
    }
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