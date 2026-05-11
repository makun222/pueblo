import {
  createLegacyStepContext,
  normalizeProviderToolName,
  parseProviderEditCompatibleToolArgs,
  parseProviderToolArgs,
  type ProviderAdapter,
  type ProviderMessage,
  type ProviderRunRequest,
  type ProviderRunResult,
  type ProviderStepContext,
  type ProviderStepResult,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderToolName,
  type ProviderUsage,
} from './provider-adapter';
import { createLlmResponseLogger, type LlmResponseLogger } from './llm-response-logger';
import { ProviderAuthError, ProviderError } from './provider-errors';
import { consumeServerSentEventStream } from './server-sent-events';

interface DeepSeekResponsePayload {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | Array<{ readonly text?: string; readonly type?: string }> | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: DeepSeekToolCall[];
    };
  }>;
  readonly usage?: DeepSeekUsagePayload;
}

interface DeepSeekStreamPayload {
  readonly choices?: Array<{
    readonly delta?: {
      readonly content?: string | Array<{ readonly text?: string; readonly type?: string }> | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: DeepSeekStreamToolCallDelta[];
    };
  }>;
  readonly usage?: DeepSeekUsagePayload;
}

type DeepSeekMessageContent = string | Array<{ readonly text?: string; readonly type?: string }> | null | undefined;

interface DeepSeekToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface DeepSeekStreamToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface DeepSeekUsagePayload {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
  };
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number;
  };
}

export interface DeepSeekAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logDir?: string;
}

export class DeepSeekAdapter implements ProviderAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly responseLogger: LlmResponseLogger;

  constructor(private readonly options: DeepSeekAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = normalizeDeepSeekBaseUrl(options.baseUrl);
    this.responseLogger = createLlmResponseLogger({ baseDir: options.logDir });
  }

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (!this.options.apiKey.trim()) {
      throw new ProviderAuthError('deepseek', 'DeepSeek API key is missing');
    }

    const requestUrl = `${this.baseUrl}/chat/completions`;
    const streamingEnabled = Boolean(context.onTextDelta);
    const response = await this.fetchWithProviderError(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: context.modelId,
        stream: streamingEnabled,
        stream_options: streamingEnabled ? { include_usage: true } : undefined,
        messages: context.messages.map(toDeepSeekMessage),
        tools: context.availableTools.length > 0 ? context.availableTools.map(toDeepSeekToolDefinition) : undefined,
        tool_choice: context.availableTools.length > 0 ? 'auto' : undefined,
      }),
    });

    if (streamingEnabled) {
      return this.readStreamingStepResult(response, requestUrl, context);
    }

    const responseText = await response.text();

    if (!response.ok) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'http-error',
        message: `DeepSeek request failed (${response.status})`,
        requestUrl,
        modelId: context.modelId,
        status: response.status,
        statusText: response.statusText,
        responseText,
      });
      throw new ProviderError(`DeepSeek request failed (${response.status}): ${responseText || response.statusText}`);
    }

    const payload = parseDeepSeekResponsePayload(responseText, {
      logger: this.responseLogger,
      requestUrl,
      modelId: context.modelId,
    });

    try {
      return extractDeepSeekStepResult(payload);
    } catch (error) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'response-structure-invalid',
        message: error instanceof Error ? error.message : 'DeepSeek response payload was invalid',
        requestUrl,
        modelId: context.modelId,
        payload,
        details: error,
      });
      throw error;
    }
  }

  private async readStreamingStepResult(
    response: Response,
    requestUrl: string,
    context: ProviderStepContext,
  ): Promise<ProviderStepResult> {
    if (!response.ok) {
      const errorText = await response.text();
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'http-error',
        message: `DeepSeek request failed (${response.status})`,
        requestUrl,
        modelId: context.modelId,
        status: response.status,
        statusText: response.statusText,
        responseText: errorText,
      });
      throw new ProviderError(`DeepSeek request failed (${response.status}): ${errorText || response.statusText}`);
    }

    const aggregate = createDeepSeekStreamingAggregate();

    try {
      await consumeServerSentEventStream(response, (eventData) => {
        if (eventData === '[DONE]') {
          return;
        }

        const payload = parseDeepSeekStreamingPayload(eventData, this.responseLogger, requestUrl, context.modelId);
        applyDeepSeekStreamingChunk(aggregate, payload, context.onTextDelta);
      });
    } catch (error) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'stream-read-failed',
        message: error instanceof Error ? error.message : 'DeepSeek stream read failed',
        requestUrl,
        modelId: context.modelId,
        details: error,
      });
      throw error;
    }

    return extractDeepSeekStepResult(buildDeepSeekResponsePayloadFromStream(aggregate));
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await this.runStep(createLegacyStepContext(request));

    if (result.type !== 'final') {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'compatibility-mode-tool-call',
        message: 'DeepSeek returned a tool call in compatibility mode',
        modelId: request.modelId,
        payload: result,
      });
      throw new ProviderError('DeepSeek returned a tool call in compatibility mode');
    }

    return {
      outputSummary: result.outputSummary,
      usage: result.usage,
    };
  }

  private async fetchWithProviderError(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(input, init);
    } catch (error) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'network-error',
        message: 'DeepSeek network request failed',
        requestUrl: input,
        details: error,
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`DeepSeek network request failed to ${input}: ${reason}`);
    }
  }
}

function parseDeepSeekResponsePayload(
  responseText: string,
  options: {
    readonly logger: LlmResponseLogger;
    readonly requestUrl: string;
    readonly modelId: string;
  },
): DeepSeekResponsePayload {
  try {
    return JSON.parse(responseText) as DeepSeekResponsePayload;
  } catch (error) {
    options.logger.log({
      providerId: 'deepseek',
      category: 'invalid-json',
      message: 'DeepSeek returned invalid JSON',
      requestUrl: options.requestUrl,
      modelId: options.modelId,
      responseText,
      details: error,
    });
    throw new ProviderError('DeepSeek returned an invalid JSON response');
  }
}

function normalizeDeepSeekBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : 'https://api.deepseek.com';
}

function toDeepSeekToolDefinition(tool: ProviderToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toDeepSeekMessage(message: ProviderMessage) {
  const reasoningContent = message.reasoningContent?.trim();
  const groupedToolCalls = message.toolCalls?.map((toolCall) => ({
    id: toolCall.toolCallId,
    type: 'function',
    function: {
      name: toolCall.toolName,
      arguments: JSON.stringify(toolCall.args),
    },
  }));

  if (message.role === 'assistant' && groupedToolCalls && groupedToolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      reasoning_content: reasoningContent || undefined,
      tool_calls: groupedToolCalls,
    };
  }

  if (message.role === 'assistant' && message.toolCallId && message.toolName && message.toolArgs) {
    return {
      role: 'assistant',
      content: message.content,
      reasoning_content: reasoningContent || undefined,
      tool_calls: [
        {
          id: message.toolCallId,
          type: 'function',
          function: {
            name: message.toolName,
            arguments: JSON.stringify(message.toolArgs),
          },
        },
      ],
    };
  }

  if (message.role === 'tool' && message.toolCallId) {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.toolName,
    };
  }

  return {
    role: message.role,
    content: message.content,
    reasoning_content: message.role === 'assistant' && reasoningContent ? reasoningContent : undefined,
  };
}

function extractDeepSeekStepResult(payload: DeepSeekResponsePayload): ProviderStepResult {
  const message = payload.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  const reasoningContent = normalizeReasoningContent(message?.reasoning_content);
  const usage = normalizeDeepSeekUsage(payload.usage);

  if (toolCalls.length > 0) {
    return parseDeepSeekToolCalls(toolCalls, message?.content, reasoningContent, usage);
  }

  if (typeof message?.content === 'string' && message.content.trim()) {
    return {
      type: 'final',
      outputSummary: message.content.trim(),
      usage,
    };
  }

  if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n');

    if (text) {
      return {
        type: 'final',
        outputSummary: text,
        usage,
      };
    }
  }

  throw new ProviderError('DeepSeek response payload did not include message content');
}

function parseDeepSeekToolCall(
  toolCall: DeepSeekToolCall,
): ProviderToolCall {
  const rawToolName = toolCall.function?.name?.trim();
  const toolName = normalizeProviderToolName(rawToolName);
  if (!toolName) {
    throw new ProviderError(`DeepSeek returned unsupported tool call: ${rawToolName ?? 'unknown'}`);
  }

  const rawArguments = toolCall.function?.arguments?.trim();
  if (!rawArguments) {
    throw new ProviderError(`DeepSeek tool call ${toolName} did not include arguments`);
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments);
  } catch {
    throw new ProviderError(`DeepSeek tool call ${toolName} returned invalid JSON arguments`);
  }

  const toolCallId = toolCall.id?.trim();
  if (!toolCallId) {
    throw new ProviderError(`DeepSeek tool call ${toolName} did not include an id`);
  }

  switch (toolName) {
    case 'glob':
      return {
        toolCallId,
        toolName,
        args: parseProviderToolArgs('glob', parsedArguments),
      };
    case 'grep':
      return {
        toolCallId,
        toolName,
        args: parseProviderToolArgs('grep', parsedArguments),
      };
    case 'exec':
      return {
        toolCallId,
        toolName,
        args: parseProviderToolArgs('exec', parsedArguments),
      };
    case 'read':
      return {
        toolCallId,
        toolName,
        args: parseProviderToolArgs('read', parsedArguments),
      };
    case 'edit':
      return {
        toolCallId,
        toolName,
        args: parseProviderEditCompatibleToolArgs(parsedArguments),
      };
  }
}

function parseDeepSeekToolCalls(
  toolCalls: DeepSeekToolCall[],
  content: DeepSeekMessageContent,
  reasoningContent: string | undefined,
  usage: ProviderUsage | undefined,
): ProviderStepResult {
  const parsedToolCalls = toolCalls.map((toolCall) => parseDeepSeekToolCall(toolCall));
  const rationale = extractMessageText(content);

  if (parsedToolCalls.length === 1) {
    return {
      type: 'tool-call',
      ...parsedToolCalls[0],
      rationale,
      reasoningContent,
      usage,
    };
  }

  return {
    type: 'tool-calls',
    toolCalls: parsedToolCalls,
    rationale,
    reasoningContent,
    usage,
  };
}

function extractMessageText(content: DeepSeekMessageContent): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => part.text?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim();

  return text || undefined;
}

function normalizeReasoningContent(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseDeepSeekStreamingPayload(
  responseText: string,
  logger: LlmResponseLogger,
  requestUrl: string,
  modelId: string,
): DeepSeekStreamPayload {
  try {
    return JSON.parse(responseText) as DeepSeekStreamPayload;
  } catch (error) {
    logger.log({
      providerId: 'deepseek',
      category: 'invalid-json',
      message: 'DeepSeek returned invalid streaming JSON',
      requestUrl,
      modelId,
      responseText,
      details: error,
    });
    throw new ProviderError('DeepSeek returned an invalid streaming JSON response');
  }
}

function createDeepSeekStreamingAggregate(): {
  readonly contentParts: string[];
  readonly reasoningParts: string[];
  readonly toolCalls: Map<number, DeepSeekToolCall>;
  usage?: DeepSeekUsagePayload;
} {
  return {
    contentParts: [],
    reasoningParts: [],
    toolCalls: new Map<number, DeepSeekToolCall>(),
  };
}

function applyDeepSeekStreamingChunk(
  aggregate: ReturnType<typeof createDeepSeekStreamingAggregate>,
  payload: DeepSeekStreamPayload,
  onTextDelta: ProviderStepContext['onTextDelta'],
): void {
  const delta = payload.choices?.[0]?.delta;
  if (!delta) {
    return;
  }

  const textDelta = extractStreamingMessageText(delta.content);
  if (textDelta) {
    aggregate.contentParts.push(textDelta);
    onTextDelta?.(textDelta);
  }

  const reasoningDelta = normalizeReasoningContent(delta.reasoning_content);
  if (reasoningDelta) {
    aggregate.reasoningParts.push(reasoningDelta);
  }

  for (const toolCallDelta of delta.tool_calls ?? []) {
    const index = toolCallDelta.index ?? aggregate.toolCalls.size;
    const current = aggregate.toolCalls.get(index) ?? { function: {} };
    aggregate.toolCalls.set(index, {
      id: toolCallDelta.id ?? current.id,
      type: toolCallDelta.type ?? current.type,
      function: {
        name: `${current.function?.name ?? ''}${toolCallDelta.function?.name ?? ''}` || undefined,
        arguments: `${current.function?.arguments ?? ''}${toolCallDelta.function?.arguments ?? ''}` || undefined,
      },
    });
  }

  if (payload.usage) {
    aggregate.usage = payload.usage;
  }
}

function buildDeepSeekResponsePayloadFromStream(
  aggregate: ReturnType<typeof createDeepSeekStreamingAggregate>,
): DeepSeekResponsePayload {
  return {
    choices: [
      {
        message: {
          content: aggregate.contentParts.join(''),
          reasoning_content: aggregate.reasoningParts.join('') || undefined,
          tool_calls: [...aggregate.toolCalls.entries()]
            .sort((left, right) => left[0] - right[0])
            .map(([, toolCall]) => toolCall),
        },
      },
    ],
    usage: aggregate.usage,
  };
}

function normalizeDeepSeekUsage(usage: DeepSeekUsagePayload | undefined): ProviderUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    promptCacheHitTokens: usage.prompt_cache_hit_tokens,
    promptCacheMissTokens: usage.prompt_cache_miss_tokens,
    promptTokensDetails: usage.prompt_tokens_details
      ? {
          cachedTokens: usage.prompt_tokens_details.cached_tokens,
        }
      : undefined,
    completionTokensDetails: usage.completion_tokens_details
      ? {
          reasoningTokens: usage.completion_tokens_details.reasoning_tokens,
        }
      : undefined,
  };
}

function extractStreamingMessageText(content: DeepSeekMessageContent): string | undefined {
  if (typeof content === 'string') {
    return content || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => part.text ?? '')
    .join('');

  return text || undefined;
}