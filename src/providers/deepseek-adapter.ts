import {
  createLegacyStepContext,
  normalizeProviderToolName,
  parseProviderEditCompatibleToolArgs,
  parseProviderToolArgs,
  type ProviderAdapter,
  type ProviderGrepToolArgs,
  type ProviderMessage,
  type ProviderRunRequest,
  type ProviderRunResult,
  type ProviderRequestMetrics,
  type ProviderStepContext,
  type ProviderStepResult,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderToolName,
  type ProviderUsage,
} from './provider-adapter';
import { createLlmResponseLogger, type LlmResponseLogger } from './llm-response-logger';
import { ProviderAuthError, ProviderError, ProviderInvalidToolArgumentsError, ProviderUnknownToolError } from './provider-errors';
import { consumeServerSentEventStream } from './server-sent-events';
import { isTaskCancellationError, toTaskCancellationError } from '../shared/task-cancellation';
import { ZodError } from 'zod';

const ESTIMATED_TOKENS_PER_CHAR = 0.25;

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

interface DeepSeekRequestPayload {
  readonly model: string;
  readonly user_id: string;
  readonly stream: boolean;
  readonly stream_options?: {
    readonly include_usage: true;
  };
  readonly messages: ReturnType<typeof toDeepSeekMessage>[];
  readonly tools?: ReturnType<typeof toDeepSeekToolDefinition>[];
  readonly tool_choice?: 'auto';
}

interface DeepSeekRequestLogContext {
  readonly requestBody: string;
  readonly requestPayload: DeepSeekRequestPayload;
  readonly promptMessages: ProviderMessage[];
  readonly requestMetrics: ProviderRequestMetrics;
}

type DeepSeekCompactionStageName = 'preview' | 'aggressive-preview' | 'summary-only';

interface DeepSeekCompactionStage {
  readonly name: DeepSeekCompactionStageName;
  readonly defaultPreviewItems: number;
  readonly readPreviewItems: number;
  readonly previewItemMaxChars: number;
}

const DEEPSEEK_NETWORK_RETRY_LIMIT = 1;
const DEEPSEEK_MAX_REQUEST_BODY_BYTES = 512_000;
const DEEPSEEK_COMPACTION_GUIDANCE = '该工具执行结果已被压缩。如果需要完整输出，请使用更窄的参数重新运行该工具。';
const DEEPSEEK_COMPACTION_STAGES: readonly DeepSeekCompactionStage[] = [
  {
    name: 'preview',
    defaultPreviewItems: 12,
    readPreviewItems: 24,
    previewItemMaxChars: 400,
  },
  {
    name: 'aggressive-preview',
    defaultPreviewItems: 4,
    readPreviewItems: 8,
    previewItemMaxChars: 200,
  },
  {
    name: 'summary-only',
    defaultPreviewItems: 0,
    readPreviewItems: 0,
    previewItemMaxChars: 0,
  },
] as const;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

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
    const requestLogContext = this.prepareRequestLogContext(context, requestUrl, streamingEnabled);
    const response = await this.fetchWithProviderError(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Connection: 'close',
      },
      body: requestLogContext.requestBody,
      signal: context.signal,
    }, requestLogContext);

    if (streamingEnabled) {
      return this.readStreamingStepResult(response, requestUrl, context, requestLogContext);
    }

    const responseText = await response.text();

    if (!response.ok) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'http-error',
        message: `DeepSeek request failed (${response.status})`,
        requestUrl,
        modelId: context.modelId,
        requestBody: requestLogContext.requestBody,
        requestPayload: requestLogContext.requestPayload,
        promptMessages: requestLogContext.promptMessages,
        requestMetrics: requestLogContext.requestMetrics,
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
      requestLogContext,
    });

    try {
      return extractDeepSeekStepResult(payload, requestLogContext.requestMetrics);
    } catch (error) {
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'response-structure-invalid',
        message: error instanceof Error ? error.message : 'DeepSeek response payload was invalid',
        requestUrl,
        modelId: context.modelId,
        requestBody: requestLogContext.requestBody,
        requestPayload: requestLogContext.requestPayload,
        promptMessages: requestLogContext.promptMessages,
        requestMetrics: requestLogContext.requestMetrics,
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
    requestLogContext: DeepSeekRequestLogContext,
  ): Promise<ProviderStepResult> {
    if (!response.ok) {
      const errorText = await response.text();
      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'http-error',
        message: `DeepSeek request failed (${response.status})`,
        requestUrl,
        modelId: context.modelId,
        requestBody: requestLogContext.requestBody,
        requestPayload: requestLogContext.requestPayload,
        promptMessages: requestLogContext.promptMessages,
        requestMetrics: requestLogContext.requestMetrics,
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

        const payload = parseDeepSeekStreamingPayload(
          eventData,
          this.responseLogger,
          requestUrl,
          context.modelId,
          requestLogContext,
        );
        applyDeepSeekStreamingChunk(aggregate, payload, context.onTextDelta);
      });
    } catch (error) {
      if (isTaskCancellationError(error)) {
        throw toTaskCancellationError(error, 'DeepSeek stream was cancelled.');
      }

      this.responseLogger.log({
        providerId: 'deepseek',
        category: 'stream-read-failed',
        message: error instanceof Error ? error.message : 'DeepSeek stream read failed',
        requestUrl,
        modelId: context.modelId,
        requestBody: requestLogContext.requestBody,
        requestPayload: requestLogContext.requestPayload,
        promptMessages: requestLogContext.promptMessages,
        requestMetrics: requestLogContext.requestMetrics,
        details: error,
      });
      throw error;
    }

    return extractDeepSeekStepResult(buildDeepSeekResponsePayloadFromStream(aggregate), requestLogContext.requestMetrics);
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
      requestMetrics: result.requestMetrics,
    };
  }

  private prepareRequestLogContext(
    context: ProviderStepContext,
    requestUrl: string,
    streamingEnabled: boolean,
  ): DeepSeekRequestLogContext {
    const originalPromptMessages = clonePromptMessages(context.messages);
    const originalRequestPayload = buildDeepSeekRequestPayload(context, streamingEnabled, originalPromptMessages);
    const originalRequestBody = JSON.stringify(originalRequestPayload);
    const originalBodyBytes = Buffer.byteLength(originalRequestBody, 'utf8');

    if (originalBodyBytes <= DEEPSEEK_MAX_REQUEST_BODY_BYTES) {
      return createDeepSeekRequestLogContext({
        promptMessages: originalPromptMessages,
        requestPayload: originalRequestPayload,
        requestBody: originalRequestBody,
        availableToolCount: context.availableTools.length,
        originalBodyBytes,
        compactedToolMessages: 0,
        compactionStage: 'none',
      });
    }

    let bestAttempt = createDeepSeekRequestLogContext({
      promptMessages: originalPromptMessages,
      requestPayload: originalRequestPayload,
      requestBody: originalRequestBody,
      availableToolCount: context.availableTools.length,
      originalBodyBytes,
      compactedToolMessages: 0,
      compactionStage: 'none',
    });

    for (const stage of DEEPSEEK_COMPACTION_STAGES) {
      const compacted = compactDeepSeekPromptMessages(originalPromptMessages, stage);
      if (compacted.compactedToolMessages === 0) {
        continue;
      }

      const requestPayload = buildDeepSeekRequestPayload(context, streamingEnabled, compacted.messages);
      const requestBody = JSON.stringify(requestPayload);
      const requestLogContext = createDeepSeekRequestLogContext({
        promptMessages: compacted.messages,
        requestPayload,
        requestBody,
        availableToolCount: context.availableTools.length,
        originalBodyBytes,
        compactedToolMessages: compacted.compactedToolMessages,
        compactionStage: stage.name,
      });

      if (requestLogContext.requestMetrics.bodyBytes <= bestAttempt.requestMetrics.bodyBytes) {
        bestAttempt = requestLogContext;
      }

      if (requestLogContext.requestMetrics.bodyBytes <= DEEPSEEK_MAX_REQUEST_BODY_BYTES) {
        this.responseLogger.log({
          providerId: 'deepseek',
          category: 'request-compacted',
          message: `DeepSeek request body exceeded the local limit and was compacted (${originalBodyBytes} bytes -> ${requestLogContext.requestMetrics.bodyBytes} bytes)`,
          requestUrl,
          modelId: context.modelId,
          requestBody: requestLogContext.requestBody,
          requestPayload: requestLogContext.requestPayload,
          promptMessages: requestLogContext.promptMessages,
          requestMetrics: requestLogContext.requestMetrics,
          details: {
            limitBytes: DEEPSEEK_MAX_REQUEST_BODY_BYTES,
            originalBodyBytes,
            savedBytes: Math.max(0, originalBodyBytes - requestLogContext.requestMetrics.bodyBytes),
          },
        });
        return requestLogContext;
      }
    }

    this.responseLogger.log({
      providerId: 'deepseek',
      category: 'request-too-large',
      message: `DeepSeek request body remained too large after local compaction (${bestAttempt.requestMetrics.bodyBytes} bytes)`,
      requestUrl,
      modelId: context.modelId,
      requestBody: bestAttempt.requestBody,
      requestPayload: bestAttempt.requestPayload,
      promptMessages: bestAttempt.promptMessages,
      requestMetrics: bestAttempt.requestMetrics,
    });

    throw new ProviderError(
      `DeepSeek request body remained too large after local compaction (${bestAttempt.requestMetrics.bodyBytes} bytes > ${DEEPSEEK_MAX_REQUEST_BODY_BYTES} bytes). Narrow the task scope or reduce attached context.`,
      { requestMetrics: bestAttempt.requestMetrics },
    );
  }

  private async fetchWithProviderError(
    input: string,
    init: RequestInit,
    requestLogContext: DeepSeekRequestLogContext,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= DEEPSEEK_NETWORK_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.fetchImpl(input, init);
      } catch (error) {
        if (isTaskCancellationError(error)) {
          throw toTaskCancellationError(error, 'DeepSeek request was cancelled.');
        }

        const canRetry = attempt < DEEPSEEK_NETWORK_RETRY_LIMIT && isRetryableNetworkError(error);
        if (canRetry) {
          this.responseLogger.log({
            providerId: 'deepseek',
            category: 'network-error-retry',
            message: 'DeepSeek network request failed; retrying once',
            requestUrl: input,
            requestBody: requestLogContext.requestBody,
            requestPayload: requestLogContext.requestPayload,
            promptMessages: requestLogContext.promptMessages,
            requestMetrics: requestLogContext.requestMetrics,
            details: {
              attempt: attempt + 1,
              error,
            },
          });
          continue;
        }

        this.responseLogger.log({
          providerId: 'deepseek',
          category: 'network-error',
          message: 'DeepSeek network request failed',
          requestUrl: input,
          requestBody: requestLogContext.requestBody,
          requestPayload: requestLogContext.requestPayload,
          promptMessages: requestLogContext.promptMessages,
          requestMetrics: requestLogContext.requestMetrics,
          details: {
            attempt: attempt + 1,
            error,
          },
        });
        const reason = describeNetworkError(error);
        throw new ProviderError(`DeepSeek network request failed to ${input}: ${reason}`);
      }
    }

    throw new ProviderError(`DeepSeek network request failed to ${input}: exhausted retries`);
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.trim().toLowerCase() === 'fetch failed') {
    return true;
  }

  const causeCode = resolveErrorCode(error.cause);
  return causeCode ? RETRYABLE_NETWORK_ERROR_CODES.has(causeCode) : false;
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const message = error.message.trim() || error.name;
  const cause = describeNetworkErrorCause(error.cause);
  return cause ? `${message} (cause: ${cause})` : message;
}

function describeNetworkErrorCause(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const parts: string[] = [];
  const code = resolveErrorCode(value);
  const message = resolveErrorMessage(value);
  const errno = resolveScalar(value, 'errno');
  const syscall = resolveScalar(value, 'syscall');
  const host = resolveScalar(value, 'hostname') ?? resolveScalar(value, 'host');
  const address = resolveScalar(value, 'address');
  const port = resolveScalar(value, 'port');
  const nestedCause = describeNetworkErrorCause(resolveProperty(value, 'cause'));

  if (code) {
    parts.push(code);
  }

  if (message && message !== 'fetch failed') {
    parts.push(message);
  }

  if (errno && errno !== code) {
    parts.push(`errno=${errno}`);
  }

  if (syscall) {
    parts.push(`syscall=${syscall}`);
  }

  if (host) {
    parts.push(`host=${host}`);
  }

  if (address) {
    parts.push(`address=${address}`);
  }

  if (port) {
    parts.push(`port=${port}`);
  }

  if (nestedCause) {
    parts.push(`cause=${nestedCause}`);
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

function resolveErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const code = 'code' in value ? value.code : undefined;
  return typeof code === 'string' && code.trim().length > 0 ? code : null;
}

function resolveErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const message = 'message' in value ? value.message : undefined;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
}

function resolveScalar(value: unknown, propertyName: string): string | null {
  const property = resolveProperty(value, propertyName);
  if (typeof property === 'string') {
    const trimmed = property.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof property === 'number' || typeof property === 'bigint') {
    return String(property);
  }

  return null;
}

function resolveProperty(value: unknown, propertyName: string): unknown {
  if (!value || typeof value !== 'object' || !(propertyName in value)) {
    return undefined;
  }

  return Reflect.get(value, propertyName);
}

function parseDeepSeekResponsePayload(
  responseText: string,
  options: {
    readonly logger: LlmResponseLogger;
    readonly requestUrl: string;
    readonly modelId: string;
    readonly requestLogContext: DeepSeekRequestLogContext;
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
      requestBody: options.requestLogContext.requestBody,
      requestPayload: options.requestLogContext.requestPayload,
      promptMessages: options.requestLogContext.promptMessages,
      requestMetrics: options.requestLogContext.requestMetrics,
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

function buildDeepSeekRequestPayload(
  context: ProviderStepContext,
  streamingEnabled: boolean,
  promptMessages: ProviderMessage[] = context.messages,
): DeepSeekRequestPayload {
  return {
    model: context.modelId,
    user_id: context.userId ?? String(process.pid),
    stream: streamingEnabled,
    stream_options: streamingEnabled ? { include_usage: true } : undefined,
    messages: promptMessages.map(toDeepSeekMessage),
    tools: context.availableTools.length > 0 ? context.availableTools.map(toDeepSeekToolDefinition) : undefined,
    tool_choice: context.availableTools.length > 0 ? 'auto' : undefined,
  };
}

function createDeepSeekRequestLogContext(input: {
  readonly promptMessages: ProviderMessage[];
  readonly requestPayload: DeepSeekRequestPayload;
  readonly requestBody: string;
  readonly availableToolCount: number;
  readonly originalBodyBytes: number;
  readonly compactedToolMessages: number;
  readonly compactionStage: DeepSeekCompactionStageName | 'none';
}): DeepSeekRequestLogContext {
  return {
    requestBody: input.requestBody,
    requestPayload: input.requestPayload,
    promptMessages: input.promptMessages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolArgs: message.toolArgs,
      toolCalls: message.toolCalls,
      reasoningContent: message.reasoningContent,
    })),
    requestMetrics: {
      submittedTokens: estimateDeepSeekSubmittedTokens(input.promptMessages, input.requestPayload.tools),
      bodyBytes: Buffer.byteLength(input.requestBody, 'utf8'),
      originalBodyBytes: input.originalBodyBytes,
      messageCount: input.promptMessages.length,
      toolCount: input.availableToolCount,
      roleCounts: countPromptRoles(input.promptMessages),
      compacted: input.compactedToolMessages > 0,
      compactedToolMessages: input.compactedToolMessages,
      compactionStage: input.compactionStage,
    },
  };
}

function clonePromptMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolArgs: message.toolArgs,
    toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
    reasoningContent: message.reasoningContent,
  }));
}

function compactDeepSeekPromptMessages(
  messages: ProviderMessage[],
  stage: DeepSeekCompactionStage,
): { readonly messages: ProviderMessage[]; readonly compactedToolMessages: number } {
  let compactedToolMessages = 0;

  return {
    messages: messages.map((message) => {
      if (message.role !== 'tool') {
        return clonePromptMessages([message])[0] as ProviderMessage;
      }

      const compactedContent = compactDeepSeekToolMessageContent(message, stage);
      if (compactedContent === message.content) {
        return clonePromptMessages([message])[0] as ProviderMessage;
      }

      compactedToolMessages += 1;
      return {
        ...message,
        content: compactedContent,
      };
    }),
    compactedToolMessages,
  };
}

function compactDeepSeekToolMessageContent(message: ProviderMessage, stage: DeepSeekCompactionStage): string {
  const parsed = parseDeepSeekSerializedToolMessage(message.content);
  if (!parsed) {
    return message.content;
  }

  const previewLimit = message.toolName === 'read' ? stage.readPreviewItems : stage.defaultPreviewItems;
  const preview = previewLimit > 0
    ? parsed.output.slice(0, previewLimit).map((entry) => truncateDeepSeekPreviewText(entry, stage.previewItemMaxChars))
    : [];

  return JSON.stringify({
    status: parsed.status,
    summary: truncateDeepSeekToolSummary(parsed.summary),
    outputPreview: previewLimit > 0 ? preview : undefined,
    outputCount: parsed.output.length,
    outputTruncated: preview.length < parsed.output.length,
    compression: 'deepseek-request-compacted',
    compactionStage: stage.name,
    guidance: DEEPSEEK_COMPACTION_GUIDANCE,
  });
}

function parseDeepSeekSerializedToolMessage(content: string): { status: string; summary: string; output: string[] } | null {
  try {
    const parsed = JSON.parse(content) as {
      status?: unknown;
      summary?: unknown;
      output?: unknown;
    };

    if (typeof parsed.status !== 'string' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.output)) {
      return null;
    }

    return {
      status: parsed.status,
      summary: parsed.summary,
      output: parsed.output.filter((entry): entry is string => typeof entry === 'string'),
    };
  } catch {
    return null;
  }
}

function truncateDeepSeekPreviewText(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const DEEPSEEK_TOOL_SUMMARY_CHAR_LIMIT = 320;

function truncateDeepSeekToolSummary(value: string): string {
  if (value.length <= DEEPSEEK_TOOL_SUMMARY_CHAR_LIMIT) {
    return value;
  }

  return `${value.slice(0, DEEPSEEK_TOOL_SUMMARY_CHAR_LIMIT - 3)}...`;
}

function countPromptRoles(messages: ProviderMessage[]): Record<ProviderMessage['role'], number> {
  const counts: Record<ProviderMessage['role'], number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };

  for (const message of messages) {
    counts[message.role] += 1;
  }

  return counts;
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

function extractDeepSeekStepResult(
  payload: DeepSeekResponsePayload,
  requestMetrics?: ProviderRequestMetrics,
): ProviderStepResult {
  const message = payload.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  const reasoningContent = normalizeReasoningContent(message?.reasoning_content);
  const usage = normalizeDeepSeekUsage(payload.usage);

  if (toolCalls.length > 0) {
    return parseDeepSeekToolCalls(toolCalls, message?.content, reasoningContent, usage, requestMetrics);
  }

  if (typeof message?.content === 'string' && message.content.trim()) {
    return {
      type: 'final',
      outputSummary: message.content.trim(),
      usage,
      requestMetrics,
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
        requestMetrics,
      };
    }
  }

  // DeepSeek may return reasoning_content while content is null/empty.
  // Treat this as a valid terminal response rather than a provider error.
  if (reasoningContent) {
    return {
      type: 'final',
      outputSummary: '',
      usage,
      requestMetrics,
    };
  }

  throw new ProviderError('DeepSeek response payload did not include message content');
}

function parseDeepSeekToolCall(
  toolCall: DeepSeekToolCall,
): ProviderToolCall {
  const rawToolName = toolCall.function?.name?.trim();
  const toolName = normalizeProviderToolName(rawToolName);
  if (!toolName) {
    throw new ProviderUnknownToolError('deepseek', rawToolName ?? 'unknown');
  }

  const rawArguments = toolCall.function?.arguments?.trim();
  if (!rawArguments) {
    throw new ProviderError(`DeepSeek tool call ${toolName} did not include arguments`);
  }

  const parsedArguments = parseDeepSeekToolArguments(toolName, rawArguments);

  const toolCallId = toolCall.id?.trim();
  if (!toolCallId) {
    throw new ProviderError(`DeepSeek tool call ${toolName} did not include an id`);
  }

  switch (toolName) {
    case 'glob':
      return {
        toolCallId,
        toolName: 'glob' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'glob', parsedArguments),
      };
    case 'grep':
      return {
        toolCallId,
        toolName: 'grep' as const,
        args: normalizeDeepSeekGrepArgs(parseProviderToolArgsOrThrow('deepseek', 'grep', parsedArguments)),
      };
    case 'exec':
      return {
        toolCallId,
        toolName: 'exec' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'exec', parsedArguments),
      };
    case 'shell_exec':
      return {
        toolCallId,
        toolName: 'shell_exec' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'shell_exec', parsedArguments),
      };
    case 'read':
      return {
        toolCallId,
        toolName: 'read' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'read', parsedArguments),
      };
    case 'edit':
      return {
        toolCallId,
        toolName: 'edit' as const,
        args: parseProviderEditCompatibleToolArgsOrThrow('deepseek', parsedArguments),
      };
    case 'write':
      return {
        toolCallId,
        toolName: 'edit' as const,
        args: parseProviderEditCompatibleToolArgsOrThrow('deepseek', parsedArguments),
      };
    case 'undo_edit':
      return {
        toolCallId,
        toolName: 'undo_edit' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'undo_edit', parsedArguments),
      };
    case 'memo_recall':
      return {
        toolCallId,
        toolName: 'memo_recall' as const,
        args: parseProviderToolArgsOrThrow('deepseek', 'memo_recall', parsedArguments),
      };
    default:
      if (toolName.startsWith('mcp__')) {
        return {
          toolCallId,
          toolName,
          args: parsedArguments as Record<string, unknown>,
        } as unknown as ProviderToolCall;
      }
      throw new ProviderError(`Unsupported tool name: ${toolName}`);
  }
}

function parseDeepSeekToolArguments(
  toolName: string,
  rawArguments: string,
): unknown {
  const fail = (detail: string): ProviderInvalidToolArgumentsError =>
    new ProviderInvalidToolArgumentsError('deepseek', toolName, [
      { path: '(arguments)', message: detail },
    ]);

  try {
    return JSON.parse(rawArguments);
  } catch (error) {
    const repairedArguments = repairCommonJsonStringEscapes(rawArguments);
    if (!repairedArguments || repairedArguments === rawArguments) {
      throw fail(
        'DeepSeek tool call arguments are not valid JSON: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      return JSON.parse(repairedArguments);
    } catch {
      throw fail(
        'DeepSeek tool call arguments could not be parsed even after JSON repair',
      );
    }
  }
}

function repairCommonJsonStringEscapes(rawJson: string): string | null {
  let repaired = '';
  let changed = false;
  let inString = false;

  for (let index = 0; index < rawJson.length;) {
    const character = rawJson[index]!;

    if (!inString) {
      repaired += character;
      inString = character === '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      repaired += character;
      inString = false;
      index += 1;
      continue;
    }

    if (character === '\\') {
      const nextCharacter = rawJson[index + 1];
      if (!nextCharacter) {
        repaired += '\\\\';
        changed = true;
        index += 1;
        continue;
      }

      if (isValidJsonEscape(rawJson, index + 1)) {
        if (nextCharacter === 'u') {
          repaired += rawJson.slice(index, index + 6);
          index += 6;
          continue;
        }

        repaired += rawJson.slice(index, index + 2);
        index += 2;
        continue;
      }

      repaired += '\\\\';
      changed = true;
      index += 1;
      continue;
    }

    if (character === '\n') {
      repaired += '\\n';
      changed = true;
      index += 1;
      continue;
    }

    if (character === '\r') {
      repaired += '\\r';
      changed = true;
      index += 1;
      continue;
    }

    if (character === '\t') {
      repaired += '\\t';
      changed = true;
      index += 1;
      continue;
    }

    repaired += character;
    index += 1;
  }

  return changed ? repaired : null;
}

function isValidJsonEscape(rawJson: string, escapeCharacterIndex: number): boolean {
  const escapeCharacter = rawJson[escapeCharacterIndex];
  if (!escapeCharacter) {
    return false;
  }

  if (escapeCharacter === 'u') {
    return /^[0-9a-fA-F]{4}$/.test(rawJson.slice(escapeCharacterIndex + 1, escapeCharacterIndex + 5));
  }

  return escapeCharacter === '"'
    || escapeCharacter === '\\'
    || escapeCharacter === '/'
    || escapeCharacter === 'b'
    || escapeCharacter === 'f'
    || escapeCharacter === 'n'
    || escapeCharacter === 'r'
    || escapeCharacter === 't';
}

function parseProviderToolArgsOrThrow<TToolName extends ProviderToolName>(
  providerId: 'deepseek',
  toolName: TToolName,
  parsedArguments: unknown,
) {
  try {
    return parseProviderToolArgs(toolName, parsedArguments);
  } catch (error) {
    throw wrapToolArgumentValidationError(providerId, toolName, error);
  }
}

function normalizeDeepSeekGrepArgs(args: ProviderGrepToolArgs): ProviderGrepToolArgs {
  const normalizedPattern = args.pattern
    .replace(/\u0008/g, '\\b')
    .replace(/\f/g, '\\f')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  if (normalizedPattern === args.pattern) {
    return args;
  }

  return {
    ...args,
    pattern: normalizedPattern,
  };
}

function parseProviderEditCompatibleToolArgsOrThrow(
  providerId: 'deepseek',
  parsedArguments: unknown,
) {
  try {
    return parseProviderEditCompatibleToolArgs(parsedArguments);
  } catch (error) {
    throw wrapToolArgumentValidationError(providerId, 'edit', error);
  }
}

function wrapToolArgumentValidationError(
  providerId: 'deepseek',
  toolName: ProviderToolName,
  error: unknown,
): Error {
  if (error instanceof ZodError) {
    return new ProviderInvalidToolArgumentsError(
      providerId,
      toolName,
      error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
      })),
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function parseDeepSeekToolCalls(
  toolCalls: DeepSeekToolCall[],
  content: DeepSeekMessageContent,
  reasoningContent: string | undefined,
  usage: ProviderUsage | undefined,
  requestMetrics: ProviderRequestMetrics | undefined,
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
      requestMetrics,
    };
  }

  return {
    type: 'tool-calls',
    toolCalls: parsedToolCalls,
    rationale,
    reasoningContent,
    usage,
    requestMetrics,
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
  requestLogContext: DeepSeekRequestLogContext,
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
      requestBody: requestLogContext.requestBody,
      requestPayload: requestLogContext.requestPayload,
      promptMessages: requestLogContext.promptMessages,
      requestMetrics: requestLogContext.requestMetrics,
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

function estimateDeepSeekSubmittedTokens(
  promptMessages: readonly ProviderMessage[],
  toolDefinitions: DeepSeekRequestPayload['tools'] | undefined,
): number {
  const serializedMessages = promptMessages
    .map((message) => [
      message.role,
      message.content,
      message.toolCallId ?? '',
      message.toolName ?? '',
      message.reasoningContent ?? '',
      message.toolCalls ? JSON.stringify(message.toolCalls) : '',
    ].join('\n'))
    .join('\n\n');
  const serializedTools = toolDefinitions ? JSON.stringify(toolDefinitions) : '';
  const estimatedChars = `${serializedMessages}\n${serializedTools}`.length;
  return Math.max(0, Math.ceil(estimatedChars * ESTIMATED_TOKENS_PER_CHAR));
}
