import {
  createLegacyStepContext,
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
} from './provider-adapter';
import { createLlmResponseLogger, type LlmResponseLogger } from './llm-response-logger';
import { ProviderAuthError, ProviderError } from './provider-errors';

interface DeepSeekResponsePayload {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | Array<{ readonly text?: string; readonly type?: string }> | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: DeepSeekToolCall[];
    };
  }>;
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
    const response = await this.fetchWithProviderError(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: context.modelId,
        stream: false,
        messages: context.messages.map(toDeepSeekMessage),
        tools: context.availableTools.length > 0 ? context.availableTools.map(toDeepSeekToolDefinition) : undefined,
        tool_choice: context.availableTools.length > 0 ? 'auto' : undefined,
      }),
    });

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

  if (toolCalls.length > 0) {
    return parseDeepSeekToolCalls(toolCalls, message?.content, reasoningContent);
  }

  if (typeof message?.content === 'string' && message.content.trim()) {
    return {
      type: 'final',
      outputSummary: message.content.trim(),
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
      };
    }
  }

  throw new ProviderError('DeepSeek response payload did not include message content');
}

function parseDeepSeekToolCall(
  toolCall: DeepSeekToolCall,
): ProviderToolCall {
  const toolName = toolCall.function?.name;
  if (!isProviderToolName(toolName)) {
    throw new ProviderError(`DeepSeek returned unsupported tool call: ${toolName ?? 'unknown'}`);
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
  }
}

function parseDeepSeekToolCalls(
  toolCalls: DeepSeekToolCall[],
  content: DeepSeekMessageContent,
  reasoningContent: string | undefined,
): ProviderStepResult {
  const parsedToolCalls = toolCalls.map((toolCall) => parseDeepSeekToolCall(toolCall));
  const rationale = extractMessageText(content);

  if (parsedToolCalls.length === 1) {
    return {
      type: 'tool-call',
      ...parsedToolCalls[0],
      rationale,
      reasoningContent,
    };
  }

  return {
    type: 'tool-calls',
    toolCalls: parsedToolCalls,
    rationale,
    reasoningContent,
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

function isProviderToolName(value: string | undefined): value is ProviderToolName {
  return value === 'glob' || value === 'grep' || value === 'exec' || value === 'read';
}