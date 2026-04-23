import {
  createLegacyStepContext,
  type ProviderAdapter,
  type ProviderMessage,
  type ProviderRunRequest,
  type ProviderRunResult,
  type ProviderStepContext,
  type ProviderStepResult,
} from './provider-adapter';
import { ProviderAuthError, ProviderError } from './provider-errors';
import type { GitHubCopilotTokenType } from './github-copilot-auth';

interface GitHubCopilotResponsePayload {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | Array<{ readonly text?: string }>;
    };
  }>;
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
  private cachedExchangeToken: CachedExchangeToken | null = null;

  constructor(private readonly options: GitHubCopilotAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? 'https://api.githubcopilot.com/chat/completions';
    this.exchangeUrl = options.exchangeUrl ?? 'https://api.github.com/copilot_internal/v2/token';
    this.userAgent = options.userAgent ?? 'Pueblo/0.1.0';
    this.editorVersion = options.editorVersion ?? 'vscode/1.99.0';
    this.editorPluginVersion = options.editorPluginVersion ?? 'copilot-chat/0.43.0';
    this.integrationId = options.integrationId ?? 'vscode-chat';
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
      throw new ProviderError(`GitHub Copilot request failed (${response.status}): ${errorText || response.statusText}`);
    }

    const payload = await response.json() as GitHubCopilotResponsePayload;
    const outputSummary = extractGitHubCopilotOutput(payload);

    return {
      type: 'final',
      outputSummary,
    };
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const stepResult = await this.runStep(createLegacyStepContext(request));

    if (stepResult.type !== 'final') {
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
    return this.fetchImpl(this.apiUrl, {
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
      }),
    });
  }

  private async exchangeGitHubToken(token: string): Promise<CachedExchangeToken> {
    let lastErrorMessage = 'GitHub Copilot token exchange failed';

    for (const authorization of [`token ${token}`, `Bearer ${token}`]) {
      const response = await this.fetchImpl(this.exchangeUrl, {
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
        lastErrorMessage = `GitHub Copilot token exchange failed (${response.status}): ${errorText || response.statusText}`;
        continue;
      }

      const payload = await response.json() as GitHubCopilotExchangePayload;
      const exchangedToken = payload.token ?? payload.access_token;

      if (!exchangedToken?.trim()) {
        throw new ProviderError('GitHub Copilot token exchange succeeded but no access token was returned');
      }

      return {
        token: exchangedToken.trim(),
        expiresAt: parseExchangeExpiration(payload.expires_at),
      };
    }

    throw new ProviderAuthError('github-copilot', lastErrorMessage);
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

function toGitHubCopilotMessage(message: ProviderMessage): { role: string; content: string } {
  return {
    role: message.role,
    content: message.content,
  };
}

function extractGitHubCopilotOutput(payload: GitHubCopilotResponsePayload): string {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => part.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n');

    if (text) {
      return text;
    }
  }

  throw new ProviderError('GitHub Copilot response payload did not include message content');
}
