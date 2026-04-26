import {
  createLegacyStepContext,
  parseProviderToolArgs,
  type ProviderAdapter,
  type ProviderMessage,
  type ProviderRunRequest,
  type ProviderRunResult,
  type ProviderStepContext,
  type ProviderStepResult,
  type ProviderToolDefinition,
  type ProviderToolName,
} from './provider-adapter';
import { ProviderAuthError, ProviderError } from './provider-errors';

interface DeepSeekResponsePayload {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | Array<{ readonly text?: string; readonly type?: string }> | null;
      readonly tool_calls?: DeepSeekToolCall[];
    };
  }>;
}

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
}

export class DeepSeekAdapter implements ProviderAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: DeepSeekAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = normalizeDeepSeekBaseUrl(options.baseUrl);
  }

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (!this.options.apiKey.trim()) {
      throw new ProviderAuthError('deepseek', 'DeepSeek API key is missing');
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError(`DeepSeek request failed (${response.status}): ${errorText || response.statusText}`);
    }

    const payload = await response.json() as DeepSeekResponsePayload;
    return extractDeepSeekStepResult(payload);
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const result = await this.runStep(createLegacyStepContext(request));

    if (result.type !== 'final') {
      throw new ProviderError('DeepSeek returned a tool call in compatibility mode');
    }

    return {
      outputSummary: result.outputSummary,
    };
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
  if (message.role === 'assistant' && message.toolCallId && message.toolName && message.toolArgs) {
    return {
      role: 'assistant',
      content: message.content,
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
  };
}

function extractDeepSeekStepResult(payload: DeepSeekResponsePayload): ProviderStepResult {
  const message = payload.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];

  if (toolCall?.function?.name) {
    return parseDeepSeekToolCall(toolCall);
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

function parseDeepSeekToolCall(toolCall: DeepSeekToolCall): ProviderStepResult {
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
        type: 'tool-call',
        toolCallId,
        toolName,
        args: parseProviderToolArgs('glob', parsedArguments),
      };
    case 'grep':
      return {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: parseProviderToolArgs('grep', parsedArguments),
      };
    case 'exec':
      return {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: parseProviderToolArgs('exec', parsedArguments),
      };
  }
}

function isProviderToolName(value: string | undefined): value is ProviderToolName {
  return value === 'glob' || value === 'grep' || value === 'exec';
}