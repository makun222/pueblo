// ---------------------------------------------------------------------------
// Feishu Long Connection — extends LongConnectionBase for the feishu
// WebSocket event stream. Frame formats are based on existing knowledge of
// the feishu long-connection protocol; TODOs mark spots to verify against
// the official docs once available.
// ---------------------------------------------------------------------------

import type { ChannelKind, ChannelEventHandler } from '../../channel-types';
import { LongConnectionBase } from '../../channel-connection';
import type { FeishuEventFrame, FeishuReceivedMessage } from './feishu-types';
import type { FeishuClient } from './feishu-client';

export interface FeishuLongConnectionOptions {
  readonly channelId: string;
  readonly client: FeishuClient;
  readonly verificationToken?: string;
  readonly startupTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  /** Override the WebSocket constructor (for tests) */
  readonly webSocketCtor?: unknown;
}

export class FeishuLongConnection extends LongConnectionBase {
  private readonly client: FeishuClient;
  private readonly verificationToken?: string;
  /** Set by the service when connect() is invoked */
  private eventHandler: ChannelEventHandler | null = null;
  /** Current endpoint URL, refreshed on endpoint_change events */
  private currentUrl: string | null = null;

  constructor(options: FeishuLongConnectionOptions) {
    super({
      channelId: options.channelId,
      kind: 'feishu' as ChannelKind,
      startupTimeoutMs: options.startupTimeoutMs,
      pingIntervalMs: options.pingIntervalMs,
      webSocketCtor: options.webSocketCtor as never,
    });
    this.client = options.client;
    this.verificationToken = options.verificationToken;
  }

  /** Wire a handler that will receive parsed feishu receive events */
  setEventHandler(handler: ChannelEventHandler): void {
    this.eventHandler = handler;
    this.onStatusChange = (state) => handler.onStatusChange(state);
    this.onError = (error) => handler.onError(error);
  }

  // ─── Abstract hooks ──────────────────────────────────────────────────

  protected async buildUrl(): Promise<string> {
    // TODO: verify exact endpoint discovery request/response shape vs feishu docs
    if (!this.currentUrl) {
      this.currentUrl = await this.client.discoverEndpoint();
    }
    return this.currentUrl;
  }

  protected async startHandshake(): Promise<void> {
    // TODO: feishu long-connection expects an initial handshake/registration
    // frame after the WebSocket opens. Sending a lightweight "register" payload;
    // adjust fields once the official frame schema is confirmed.
    const handshake = JSON.stringify({
      type: 'register',
      app_id: (this.client as unknown as { appId: string }).appId,
      token: this.verificationToken,
    });
    this.sendFrame(handshake);
  }

  protected sendHeartbeat(): void {
    // Feishu long connections use a `PING` text frame; the server replies `PONG`.
    this.sendFrame('PING');
  }

  protected shouldReconnect(_code: number | undefined, _reason: string | undefined): boolean {
    return true;
  }

  protected handleFrame(data: string): void {
    let frame: FeishuEventFrame;
    try {
      frame = JSON.parse(data) as FeishuEventFrame;
    } catch {
      // Non-JSON frames (e.g. PONG) are silently ignored.
      return;
    }

    const type = frame.type;
    if (type === 'event' && frame.header?.event_type === 'im.message.receive_v1') {
      const parsed = parseReceiveEvent(frame);
      if (parsed) {
        this.eventHandler?.onMessage({
          channelId: this.channelId,
          externalConversationId: parsed.chatId,
          externalMessageId: parsed.messageId,
          senderId: parsed.senderId,
          senderName: parsed.senderName,
          text: parsed.text,
          raw: frame,
          receivedAt: Date.now(),
        });
      }
      return;
    }

    if (type === 'event' && frame.header?.event_type === 'endpoint_change') {
      // Server signaled a new endpoint; reset cached URL and reconnect.
      this.currentUrl = null;
      void this.disconnect().then(() => {
        if (!this.disposed) {
          void this.connect();
        }
      });
      return;
    }
  }
}

/** Extract chatId/messageId/sender/text from a receive_v1 event payload */
export function parseReceiveEvent(frame: FeishuEventFrame): FeishuReceivedMessage | null {
  // TODO: confirm exact payload nesting against feishu docs. Current shape
  // mirrors the documented event v2 `event.message` / `event.sender` structure.
  const event = ((frame.payload ?? frame.data) as Record<string, unknown> | undefined)?.event
    ?? (frame.payload ?? frame.data) as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object') return null;

  const message = (event as { message?: Record<string, unknown> }).message;
  const sender = (event as { sender?: Record<string, unknown> }).sender;
  if (!message) return null;

  const chatId = readString(message.chat_id) ?? readString(message.receive_id);
  const messageId = readString(message.message_id);
  const text = extractMessageText(message.content) ?? '';
  if (!chatId || !messageId) return null;

  const senderIdObj = (sender as { sender_id?: Record<string, unknown> } | undefined)?.sender_id;
  const senderId = senderIdObj ? readString(senderIdObj.open_id) ?? readString(senderIdObj.user_id) ?? '' : '';
  const senderName = (sender as { name?: unknown } | undefined)?.name;

  return {
    chatId,
    messageId,
    senderId,
    senderName: typeof senderName === 'string' ? senderName : undefined,
    text,
    raw: frame,
  };
}

function extractMessageText(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return content;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
