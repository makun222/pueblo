// ---------------------------------------------------------------------------
// Feishu Channel Adapter — implements ChannelAdapter for feishu
// ---------------------------------------------------------------------------

import type {
  ChannelCapabilities,
  ChannelConfig,
  ChannelEventHandler,
  ChannelKind,
  ChannelSendResult,
  ChannelTestResult,
  OutboundMessage,
} from '../../channel-types';
import { BaseChannelAdapter } from '../../channel-adapter';
import type { CredentialStore } from '../../../providers/credential-store';
import { createDefaultCredentialStore } from '../../../providers/credential-store';
import { ChannelAuthError, ChannelConnectionError } from '../../channel-errors';
import { safeParseFeishuOptions } from './feishu-config';
import { FeishuClient, resolveFeishuAppSecret } from './feishu-client';
import { FeishuLongConnection } from './feishu-connection';

const FEISHU_CAPABILITIES: ChannelCapabilities = {
  inboundEvents: true,
  outboundReply: true,
  card: true,
  longConnection: true,
};

export interface FeishuChannelAdapterOptions {
  readonly credentialStore?: CredentialStore;
  readonly clientFactory?: (options: import('./feishu-client').FeishuClientOptions) => FeishuClient;
  /** Inject a WebSocket constructor (for tests) */
  readonly webSocketCtor?: unknown;
}

export function createFeishuChannelAdapter(
  config: ChannelConfig,
  credentialStore?: CredentialStore,
): FeishuChannelAdapter {
  return new FeishuChannelAdapter(config, { credentialStore });
}

export class FeishuChannelAdapter extends BaseChannelAdapter {
  readonly capabilities: ChannelCapabilities = FEISHU_CAPABILITIES;

  private readonly store: CredentialStore;
  private readonly clientFactory?: (options: import('./feishu-client').FeishuClientOptions) => FeishuClient;
  private client: FeishuClient | null = null;
  private connection: FeishuLongConnection | null = null;
  private currentConfig: ChannelConfig | null = null;
  private disposed = false;

  constructor(config: ChannelConfig, options: FeishuChannelAdapterOptions = {}) {
    super(config.id, 'feishu');
    this.store = options.credentialStore ?? createDefaultCredentialStore();
    this.clientFactory = options.clientFactory;
  }

  async connect(config: ChannelConfig, handler: ChannelEventHandler): Promise<void> {
    this.currentConfig = config;
    const options = safeParseFeishuOptions(config.options ?? {});
    if (!options) {
      this.setStatus('error', 'invalid feishu config options');
      throw new ChannelConnectionError(config.id, 'invalid feishu config options');
    }

    const credentialTarget = config.credentialTarget ?? `pueblo:feishu:${config.id}`;
    const appSecret = this.store.isSupported()
      ? resolveFeishuAppSecret(credentialTarget, (target) => this.store.readSecret(target))
      : null;
    if (appSecret === null) {
      // When the credential store is unsupported, fall back to an options-supplied
      // secret (e.g. env or plain config) if present — otherwise fail.
      const optionsSecret = readOptionSecret(config.options);
      if (!optionsSecret) {
        this.setStatus('error', 'feishu appSecret not available');
        throw new ChannelAuthError(config.id, 'feishu appSecret not found');
      }
      return this.connectWith(config, options.appId, optionsSecret, handler);
    }

    return this.connectWith(config, options.appId, appSecret, handler);
  }

  private async connectWith(
    config: ChannelConfig,
    appId: string,
    appSecret: string,
    handler: ChannelEventHandler,
  ): Promise<void> {
    const options = safeParseFeishuOptions(config.options ?? {});
    if (!options) throw new ChannelConnectionError(config.id, 'invalid feishu config options');

    const clientOptions = {
      channelId: config.id,
      appId,
      appSecret,
      imApiBaseUrl: options.imApiBaseUrl,
    };
    this.client = this.clientFactory ? this.clientFactory(clientOptions) : new FeishuClient(clientOptions);

    this.connection = new FeishuLongConnection({
      channelId: config.id,
      client: this.client,
      verificationToken: options.verificationToken,
    });
    this.connection.setEventHandler(handler);

    try {
      this.setStatus('connecting');
      await this.connection.connect();
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.disconnect();
    }
    this.setStatus('disconnected');
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    if (!this.client || !this.currentConfig) {
      return { ok: false, error: 'feishu adapter not connected' };
    }
    const receiveId = message.externalConversationId;

    try {
      if (message.card !== undefined) {
        const content = FeishuClient.buildCardContent(message.card);
        const res = message.replyToMessageId
          ? await this.client.replyMessage(message.replyToMessageId, 'interactive', content)
          : await this.client.sendMessage(receiveId, 'chat_id', 'interactive', content);
        return { ok: res.code === 0, externalMessageId: res.data?.message_id };
      }
      const content = FeishuClient.buildTextContent(message.text ?? '');
      const res = message.replyToMessageId
        ? await this.client.replyMessage(message.replyToMessageId, 'text', content)
        : await this.client.sendMessage(receiveId, 'chat_id', 'text', content);
      return { ok: res.code === 0, externalMessageId: res.data?.message_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async testConnection(config: ChannelConfig): Promise<ChannelTestResult> {
    try {
      const options = safeParseFeishuOptions(config.options ?? {});
      if (!options) return { ok: false, error: 'invalid feishu config options' };

      const credentialTarget = config.credentialTarget ?? `pueblo:feishu:${config.id}`;
      const appSecret = this.store.isSupported()
        ? this.store.readSecret(credentialTarget)
        : readOptionSecret(config.options);
      if (!appSecret) return { ok: false, error: 'feishu appSecret not found' };

      const client = new FeishuClient({
        channelId: config.id,
        appId: options.appId,
        appSecret,
        imApiBaseUrl: options.imApiBaseUrl,
      });
      await client.getTenantAccessToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection?.dispose();
    this.connection = null;
    this.client = null;
    this.setStatus('disconnected');
  }
}

function readOptionSecret(options: Record<string, unknown>): string | null {
  const secret = options.appSecret;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}
