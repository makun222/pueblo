// ---------------------------------------------------------------------------
// Feishu Client — HTTP calls: tenant_access_token refresh + send/reply
// ---------------------------------------------------------------------------

import {
  type FeishuEndpointResponse,
  type FeishuMsgType,
  type FeishuSendMessageResponse,
  type FeishuTenantTokenResponse,
} from './feishu-types';
import { ChannelAuthError, ChannelError } from '../../channel-errors';
import { DEFAULT_ENDPOINT_DISCOVERY_PATH, DEFAULT_IM_API_BASE_URL, type FeishuOptions } from './feishu-config';

/** Injectable fetch implementation (defaults to global fetch) */
export type FeishuFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface FeishuClientOptions {
  readonly channelId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly imApiBaseUrl?: string;
  readonly endpointDiscoveryPath?: string;
  readonly fetchImpl?: FeishuFetch;
}

const TOKEN_REFRESH_LEAD_TIME_MS = 60_000;

export class FeishuClient {
  private readonly channelId: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly imApiBaseUrl: string;
  private readonly endpointDiscoveryPath: string;
  private readonly fetchImpl: FeishuFetch;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: FeishuClientOptions) {
    this.channelId = options.channelId;
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.imApiBaseUrl = (options.imApiBaseUrl ?? DEFAULT_IM_API_BASE_URL).replace(/\/$/, '');
    this.endpointDiscoveryPath = options.endpointDiscoveryPath ?? DEFAULT_ENDPOINT_DISCOVERY_PATH;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  // ─── tenant_access_token ─────────────────────────────────────────────

  /** Obtain a tenant_access_token, caching it until shortly before expiry */
  async getTenantAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && !forceRefresh && now < this.tokenExpiresAt - TOKEN_REFRESH_LEAD_TIME_MS) {
      return this.cachedToken;
    }

    const url = `${this.imApiBaseUrl}/auth/v3/tenant_access_token/internal`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    const payload = await parseJson<FeishuTenantTokenResponse>(response);
    if (payload.code !== 0) {
      throw new ChannelAuthError(this.channelId, `tenant_access_token failed: ${payload.msg}`);
    }

    this.cachedToken = payload.tenant_access_token;
    this.tokenExpiresAt = now + payload.expire * 1000;
    return payload.tenant_access_token;
  }

  // ─── Long-connection endpoint discovery ──────────────────────────────

  /** Discover the WebSocket endpoint URL for the long connection */
  async discoverEndpoint(): Promise<string> {
    const token = await this.getTenantAccessToken();
    const url = `${this.imApiBaseUrl}${this.endpointDiscoveryPath}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ app_id: this.appId }),
    });

    const payload = await parseJson<FeishuEndpointResponse>(response);
    if (payload.code !== 0) {
      throw new ChannelError(`Feishu endpoint discovery failed: ${payload.msg}`);
    }
    return payload.data.URL;
  }

  // ─── Send / reply ────────────────────────────────────────────────────

  /** Send a message to a receive_id (chat_id / open_id / user_id / email) */
  async sendMessage(
    receiveId: string,
    receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'email' | 'union_id',
    msgType: FeishuMsgType,
    content: string,
  ): Promise<FeishuSendMessageResponse> {
    const token = await this.getTenantAccessToken();
    const url = `${this.imApiBaseUrl}/im/v1/messages?receive_id_type=${receiveIdType}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
    });

    const payload = await parseJson<FeishuSendMessageResponse>(response);
    if (payload.code !== 0) {
      throw new ChannelError(`Feishu send message failed: ${payload.msg}`);
    }
    return payload;
  }

  /** Reply to a specific message id (threaded reply) */
  async replyMessage(
    messageId: string,
    msgType: FeishuMsgType,
    content: string,
  ): Promise<FeishuSendMessageResponse> {
    const token = await this.getTenantAccessToken();
    const url = `${this.imApiBaseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ msg_type: msgType, content }),
    });

    const payload = await parseJson<FeishuSendMessageResponse>(response);
    if (payload.code !== 0) {
      throw new ChannelError(`Feishu reply message failed: ${payload.msg}`);
    }
    return payload;
  }

  /** Build a text message content payload */
  static buildTextContent(text: string): string {
    return JSON.stringify({ text });
  }

  /** Build a card (interactive) message content payload from a raw card object */
  static buildCardContent(card: unknown): string {
    return JSON.stringify(card);
  }
}

async function parseJson<T>(response: { ok: boolean; status: number; text: () => Promise<string> }): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ChannelError(`Feishu API returned non-JSON response (status=${response.status}): ${body.slice(0, 200)}`);
  }
}

async function defaultFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: init?.body,
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
}

/** Resolve the feishu appSecret from a CredentialStore (target = pueblo:feishu:<id>) */
export function resolveFeishuAppSecret(credentialTarget: string, readSecret: (target: string) => string | null): string {
  const secret = readSecret(credentialTarget);
  if (!secret) {
    throw new ChannelAuthError(credentialTarget, 'feishu appSecret not found in credential store');
  }
  return secret;
}

export type { FeishuOptions };
