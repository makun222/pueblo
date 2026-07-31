import { DeepSeekAdapter, type DeepSeekAdapterOptions } from './deepseek-adapter';

/**
 * OpenAI-compatible services use the same chat-completions and tool-call
 * protocol as DeepSeek. The dedicated DeepSeek adapter remains the provider
 * registered for DeepSeek; this adapter names the generic integration point.
 */
export class OpenAICompatibleAdapter extends DeepSeekAdapter {
  constructor(options: DeepSeekAdapterOptions) {
    super(options);
  }
}
