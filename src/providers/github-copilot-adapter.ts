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
import { ProviderAuthError, ProviderError } from './provider-errors';
import type { GitHubCopilotTokenType } from './github-copilot-auth';
import { createLlmResponseLogger, type LlmResponseLogger } from './llm-response-logger';

interface GitHubCopilotResponsePayload {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | Array<{ readonly text?: string }>;
      readonly tool_calls?: GitHubCopilotToolCall[];
    };
  }>;
}

interface GitHubCopilotToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface GitHubCopilotExchangePayload {
  readonly token?: string;
  readonly access_token?: string;
  readonly expires_at?: number | string;
}

export interface GitHubCopilotAdapterOptions {
  readonly token: string;
  readonly tokenType?: GitHubCopilotTokenType;
  readonly apiUrl?: string;
  readonly exchangeUrl?: string;
  readonly userAgent?: string;
  readonly editorVersion?: string;
  readonly editorPluginVersion?: string;
  readonly integrationId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logDir?: string;
}

interface CachedExchangeToken {
  readonly token: string;
  readonly expiresAt: number | null;
}

export class GitHubCopilotAdapter implements ProviderAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly exchangeUrl: string;
  private readonly userAgent: string;
  private readonly editorVersion: string;
  private readonly editorPluginVersion: string;
  private readonly integrationId: string;
  private readonly responseLogger: LlmResponseLogger;
  private cachedExchangeToken: CachedExchangeToken | null = null;

  constructor(private readonly options: GitHubCopilotAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? 'https://api.githubcopilot.com/chat/completions';
    this.exchangeUrl = options.exchangeUrl ?? 'https://api.github.com/copilot_internal/v2/token';
    this.userAgent = options.userAgent ?? 'Pueblo/0.1.0';
    this.editorVersion = options.editorVersion ?? 'vscode/1.99.0';
    this.editorPluginVersion = options.editorPluginVersion ?? 'copilot-chat/0.43.0';
    this.integrationId = options.integrationId ?? 'vscode-chat';
    this.responseLogger = createLlmResponseLogger({ baseDir: options.logDir });
  }

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (!this.options.token.trim()) {
      throw new ProviderAuthError('github-copilot', 'GitHub Copilot token is missing');
    }

    const tokenType = this.options.tokenType ?? 'copilot-access-token';

    if (tokenType === 'github-pat') {
      throw new ProviderAuthError(
        'github-copilot',
        'GitHub Personal Access Tokens are not supported. Use a GitHub auth token or a Copilot access token.',
      );
    }

    let response = await this.sendChatRequest(context, this.options.token);

    if (!response.ok && tokenType === 'github-auth-token' && shouldFallbackToExchange(response.status)) {
      const exchangedToken = await this.resolveExchangedAccessToken();
      response = await this.sendChatRequest(context, exchangedToken);
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.responseLogger.log({
        providerId: 'github-copilot',
        category: 'http-error',
        message: `GitHub Copilot request failed (${response.status})`,
        requestUrl: this.apiUrl,
        modelId: context.modelId,
        status: response.status,
        statusText: response.statusText,
        responseText: errorText,
      });
      throw new ProviderError(`GitHub Copilot request failed (${response.status}): ${errorText || response.statusText}`);
    }

    const responseText = await response.text();
    const payload = parseGitHubCopilotResponsePayload(responseText, {
      logger: this.responseLogger,
      requestUrl: this.apiUrl,
      modelId: context.modelId,
    });

    try {
      return extractGitHubCopilotStepResult(payload);
    } catch (error) {
      this.responseLogger.log({
        providerId: 'github-copilot',
        category: 'response-structure-invalid',
        message: error instanceof Error ? error.message : 'GitHub Copilot response payload was invalid',
        requestUrl: this.apiUrl,
        modelId: context.modelId,
        payload,
        details: error,
      });
      throw error;
    }
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const stepResult = await this.runStep(createLegacyStepContext(request));

    if (stepResult.type !== 'final') {
      this.responseLogger.log({
        providerId: 'github-copilot',
        category: 'compatibility-mode-tool-call',
        message: 'GitHub Copilot returned a tool call in compatibility mode',
        modelId: request.modelId,
        payload: stepResult,
      });
      throw new ProviderError('GitHub Copilot returned a tool call in compatibility mode');
    }

    return {
      outputSummary: stepResult.outputSummary,
    };
  }

  private async resolveExchangedAccessToken(): Promise<string> {
    if (this.cachedExchangeToken && !isTokenExpired(this.cachedExchangeToken.expiresAt)) {
      return this.cachedExchangeToken.token;
    }

    const exchanged = await this.exchangeGitHubToken(this.options.token);
    this.cachedExchangeToken = exchanged;
    return exchanged.token;
  }

  private sendChatRequest(request: ProviderStepContext, accessToken: string): Promise<Response> {
    return this.fetchWithProviderError(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.userAgent,
        'Editor-Version': this.editorVersion,
        'Editor-Plugin-Version': this.editorPluginVersion,
        'Copilot-Integration-Id': this.integrationId,
      },
      body: JSON.stringify({
        model: request.modelId,
        stream: false,
        messages: request.messages.map(toGitHubCopilotMessage),
        tools: request.availableTools.length > 0 ? request.availableTools.map(toGitHubCopilotToolDefinition) : undefined,
        tool_choice: request.availableTools.length > 0 ? 'auto' : undefined,
      }),
    });
  }

  private async exchangeGitHubToken(token: string): Promise<CachedExchangeToken> {
    let lastErrorMessage = 'GitHub Copilot token exchange failed';

    for (const authorization of [`token ${token}`, `Bearer ${token}`]) {
      const response = await this.fetchWithProviderError(this.exchangeUrl, {
        method: 'GET',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          'Editor-Version': this.editorVersion,
          'Editor-Plugin-Version': this.editorPluginVersion,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.responseLogger.log({
          providerId: 'github-copilot',
          category: 'token-exchange-http-error',
          message: `GitHub Copilot token exchange failed (${response.status})`,
          requestUrl: this.exchangeUrl,
          status: response.status,
          statusText: response.statusText,
          responseText: errorText,
        });
        lastErrorMessage = `GitHub Copilot token exchange failed (${response.status}): ${errorText || response.statusText}`;
        continue;
      }

      const exchangeText = await response.text();
      const payload = parseGitHubCopilotExchangePayload(exchangeText, this.responseLogger, this.exchangeUrl);
      const exchangedToken = payload.token ?? payload.access_token;

      if (!exchangedToken?.trim()) {
        this.responseLogger.log({
          providerId: 'github-copilot',
          category: 'token-exchange-structure-invalid',
          message: 'GitHub Copilot token exchange succeeded but no access token was returned',
          requestUrl: this.exchangeUrl,
          payload,
        });
        throw new ProviderError('GitHub Copilot token exchange succeeded but no access token was returned');
      }

      return {
        token: exchangedToken.trim(),
        expiresAt: parseExchangeExpiration(payload.expires_at),
      };
    }

    throw new ProviderAuthError('github-copilot', lastErrorMessage);
  }

  private async fetchWithProviderError(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(input, init);
    } catch (error) {
      this.responseLogger.log({
        providerId: 'github-copilot',
        category: 'network-error',
        message: 'GitHub Copilot network request failed',
        requestUrl: input,
        details: error,
      });
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`GitHub Copilot network request failed to ${input}: ${reason}`);
    }
  }
}

function parseGitHubCopilotResponsePayload(
  responseText: string,
  options: {
    readonly logger: LlmResponseLogger;
    readonly requestUrl: string;
    readonly modelId: string;
  },
): GitHubCopilotResponsePayload {
  try {
    return JSON.parse(responseText) as GitHubCopilotResponsePayload;
  } catch (error) {
    options.logger.log({
      providerId: 'github-copilot',
      category: 'invalid-json',
      message: 'GitHub Copilot returned invalid JSON',
      requestUrl: options.requestUrl,
      modelId: options.modelId,
      responseText,
      details: error,
    });
    throw new ProviderError('GitHub Copilot returned an invalid JSON response');
  }
}

function parseGitHubCopilotExchangePayload(
  responseText: string,
  logger: LlmResponseLogger,
  requestUrl: string,
): GitHubCopilotExchangePayload {
  try {
    return JSON.parse(responseText) as GitHubCopilotExchangePayload;
  } catch (error) {
    logger.log({
      providerId: 'github-copilot',
      category: 'token-exchange-invalid-json',
      message: 'GitHub Copilot token exchange returned invalid JSON',
      requestUrl,
      responseText,
      details: error,
    });
    throw new ProviderError('GitHub Copilot token exchange returned an invalid JSON response');
  }
}

function parseExchangeExpiration(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * 1000;
  }

  if (typeof value === 'string') {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue * 1000;
    }

    const parsedDate = Date.parse(value);
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
  }

  return null;
}

function isTokenExpired(expiresAt: number | null): boolean {
  if (!expiresAt) {
    return false;
  }

  return Date.now() >= expiresAt - 60_000;
}

function shouldFallbackToExchange(status: number): boolean {
  return status === 401 || status === 403;
}

function toGitHubCopilotToolDefinition(tool: ProviderToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toGitHubCopilotMessage(message: ProviderMessage): { role: string; content: string } {
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
      tool_calls: groupedToolCalls,
    } as unknown as { role: string; content: string };
  }

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
    } as unknown as { role: string; content: string };
  }

  if (message.role === 'tool' && message.toolCallId) {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.toolName,
    } as unknown as { role: string; content: string };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function extractGitHubCopilotOutput(payload: GitHubCopilotResponsePayload): string {
  const result = extractGitHubCopilotStepResult(payload);

  if (result.type !== 'final') {
    throw new ProviderError('GitHub Copilot returned a tool call where final output was required');
  }

  return result.outputSummary;
}

function extractGitHubCopilotStepResult(payload: GitHubCopilotResponsePayload): ProviderStepResult {
  const message = payload.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];

  if (toolCalls.length > 0) {
    return parseGitHubCopilotToolCalls(toolCalls);
  }

  const content = message?.content;

  if (typeof content === 'string' && content.trim()) {
    return {
      type: 'final',
      outputSummary: content.trim(),
    };
  }

  if (Array.isArray(content)) {
    const text = content
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

  throw new ProviderError('GitHub Copilot response payload did not include message content');
}

function parseGitHubCopilotToolCall(toolCall: GitHubCopilotToolCall): ProviderToolCall {
  const toolName = toolCall.function?.name;
  if (!isProviderToolName(toolName)) {
    throw new ProviderError(`GitHub Copilot returned unsupported tool call: ${toolName ?? 'unknown'}`);
  }

  const rawArguments = toolCall.function?.arguments?.trim();
  if (!rawArguments) {
    throw new ProviderError(`GitHub Copilot tool call ${toolName} did not include arguments`);
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments);
  } catch {
    throw new ProviderError(`GitHub Copilot tool call ${toolName} returned invalid JSON arguments`);
  }

  const toolCallId = toolCall.id?.trim();
  if (!toolCallId) {
    throw new ProviderError(`GitHub Copilot tool call ${toolName} did not include an id`);
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
        args: parseProviderToolArgs('edit', parsedArguments),
      };
  }
}

function parseGitHubCopilotToolCalls(toolCalls: GitHubCopilotToolCall[]): ProviderStepResult {
  const parsedToolCalls = toolCalls.map((toolCall) => parseGitHubCopilotToolCall(toolCall));

  if (parsedToolCalls.length === 1) {
    return {
      type: 'tool-call',
      ...parsedToolCalls[0],
    };
  }

  return {
    type: 'tool-calls',
    toolCalls: parsedToolCalls,
  };
}

function isProviderToolName(value: string | undefined): value is ProviderToolName {
  return value === 'glob' || value === 'grep' || value === 'exec' || value === 'read';
}
