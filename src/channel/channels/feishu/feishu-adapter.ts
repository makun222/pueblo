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
  InboundMessage,
  OutboundMessage,
} from '../../channel-types';
import { BaseChannelAdapter } from '../../channel-adapter';
import {
  createLarkChannel,
  type NormalizedMessage,
  type LarkChannel,
} from '@larksuite/channel';
import type { CredentialStore } from '../../../providers/credential-store';
import { channelDebugLog } from '../../channel-debug-log';
import { channelLogger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface FeishuSecret {
  appId: string;
  appSecret: string;
}

export async function safeParseFeishuOptions(
  options: ChannelConfig['options'],
): Promise<FeishuSecret> {
  if (!options || typeof options !== 'object') {
    throw new Error('Missing feishu options');
  }
  const opts = options as Record<string, unknown>;
  const appId = typeof opts.appId === 'string' ? opts.appId : '';
  const appSecret = typeof opts.appSecret === 'string' ? opts.appSecret : '';
  if (!appId || !appSecret) {
    throw new Error('feishu options must include appId and appSecret');
  }
  return { appId, appSecret };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class FeishuAdapter extends BaseChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    inboundEvents: true,
    outboundReply: true,
    card: true,
    longConnection: true,
  };

  private larkChannel: LarkChannel | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly credentialStore?: CredentialStore;

  constructor(channelId: string, kind: ChannelKind = 'feishu', credentialStore?: CredentialStore) {
    super(channelId, kind);
    this.credentialStore = credentialStore;
  }

  /**
   * Resolve feishu credentials for a connect attempt. Prefers inline
   * `options.appSecret`; when absent, falls back to the OS credential-store
   * entry written by `/channel secret <id> <appSecret>`
   * (target = `config.credentialTarget` or `pueblo:feishu:<id>`). This turns
   * `/channel secret` into a real (non-dead) code path.
   */
  private async resolveSecret(config: ChannelConfig): Promise<FeishuSecret> {
    const options: Record<string, unknown> = { ...config.options };
    const inlineSecret = typeof options.appSecret === 'string' ? options.appSecret : '';
    if (!inlineSecret && this.credentialStore?.isSupported()) {
      const target = config.credentialTarget ?? `pueblo:feishu:${config.id}`;
      const stored = this.credentialStore.readSecret(target);
      if (stored) {
        options.appSecret = stored;
        channelDebugLog(`FeishuAdapter: appSecret resolved from credential store target=${target}`);
      }
    }
    return safeParseFeishuOptions(options);
  }

  async connect(
    config: ChannelConfig,
    handler: ChannelEventHandler,
  ): Promise<void> {
    channelDebugLog(`FeishuAdapter.connect: BEGIN channelId=${this.channelId}`);
    try {
      const { appId, appSecret } = await this.resolveSecret(config);
      channelDebugLog(`FeishuAdapter.connect: options parsed OK, appId=${appId }`);
      this.handler = handler;
      this.setStatus('connecting');

      const larkChannel = createLarkChannel({ appId, appSecret });
      this.larkChannel = larkChannel;
      channelDebugLog('FeishuAdapter.connect: larkChannel created, binding events…');

      // Bind events
      const unsubMessage = larkChannel.on('message', (msg: NormalizedMessage) => {
        const inbound = this.toInboundMessage(msg);
        channelDebugLog(`FeishuAdapter: larkChannel message: ${JSON.stringify(inbound)}`);
        this.handler?.onMessage(inbound);
      });

      const unsubError = larkChannel.on('error', (err: unknown) => {
        channelDebugLog(`FeishuAdapter: larkChannel error: ${String(err)}`);
        channelLogger.error('feishu channel error', err);
        this.handler?.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      });

      this.unsubscribers = [unsubMessage, unsubError];

      try {
        channelDebugLog('FeishuAdapter.connect: calling larkChannel.connect()…');
        await larkChannel.connect();
        this.setStatus('connected');
        channelDebugLog('FeishuAdapter.connect: OK — WebSocket connected');
        channelLogger.info('feishu channel connected');
      } catch (err) {
        channelDebugLog(`FeishuAdapter.connect: larkChannel.connect() FAILED: ${String(err)}`);
        this.setStatus('disconnected', String(err));
        channelLogger.error('feishu connect failed', err);
        throw err;
      }
    } catch (err) {
      channelDebugLog(`FeishuAdapter.connect: FATAL early failure: ${String(err)}`);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.larkChannel) {
      try {
        await this.larkChannel.disconnect();
      } catch (err) {
        channelLogger.warn('feishu disconnect error', err);
      }
      this.larkChannel = null;
    }
    this.handler = null;
    this.setStatus('disconnected');
    channelLogger.info('feishu channel disconnected');
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    if (!this.larkChannel) {
      return { ok: false, error: 'channel not connected' };
    }

    try {
      const opts: { replyTo?: string } = {};
      if (message.replyToMessageId) {
        opts.replyTo = message.replyToMessageId;
      }

      let input: { text: string } | { card: object };
      if (message.card != null) {
        input = { card: message.card as object };
      } else {
        input = { text: message.text ?? '' };
      }

      const result = await this.larkChannel.send(
        message.externalConversationId,
        input,
        opts,
      );

      return { ok: true, externalMessageId: result.messageId };
    } catch (err) {
      channelLogger.error('feishu send failed', err);
      return { ok: false, error: String(err) };
    }
  }

  async testConnection(config: ChannelConfig): Promise<ChannelTestResult> {
    const { appId, appSecret } = await safeParseFeishuOptions(config.options);
    const testChannel = createLarkChannel({ appId, appSecret });
    try {
      await testChannel.connect();
      await testChannel.disconnect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.larkChannel) {
      this.larkChannel.disconnect().catch(() => {});
      this.larkChannel = null;
    }
    this.handler = null;
    this.setStatus('disconnected');
  }

  // -- Mapping ----------------------------------------------------------

  private toInboundMessage(msg: NormalizedMessage): InboundMessage {
    return {
      channelId: this.channelId,
      externalConversationId: msg.chatId,
      externalMessageId: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.content ?? '',
      raw: msg.raw,
      receivedAt: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFeishuChannelAdapter(
  config: ChannelConfig,
  credentialStore?: CredentialStore,
): FeishuAdapter {
  const channelId = config.id ?? `feishu-${Date.now()}`;
  return new FeishuAdapter(channelId, 'feishu', credentialStore);
}