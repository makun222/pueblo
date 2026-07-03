// ---------------------------------------------------------------------------
// Channel Adapter — In-memory adapter for tests + adapter helpers
// ---------------------------------------------------------------------------

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  ChannelConnectionState,
  ChannelEventHandler,
  ChannelKind,
  ChannelSendResult,
  ChannelTestResult,
  InboundMessage,
  OutboundMessage,
} from './channel-types';

/** Convenience base class providing a mutable state snapshot for adapters */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  public abstract readonly capabilities: ChannelCapabilities;

  readonly kind: ChannelKind;
  protected _state: ChannelConnectionState;
  protected handler: ChannelEventHandler | null = null;

  constructor(public readonly channelId: string, kind: ChannelKind) {
    this.kind = kind;
    this._state = {
      channelId,
      kind,
      status: 'disconnected',
      lastError: null,
      connectedAt: null,
    };
  }

  get state(): ChannelConnectionState {
    return { ...this._state, kind: this.kind };
  }

  abstract connect(config: ChannelConfig, handler: ChannelEventHandler): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<ChannelSendResult>;
  abstract testConnection(config: ChannelConfig): Promise<ChannelTestResult>;
  abstract dispose(): void;

  protected setStatus(status: ChannelConnectionState['status'], lastError: string | null = null): void {
    this._state = {
      ...this._state,
      status,
      lastError,
      connectedAt: status === 'connected' ? Date.now() : this._state.connectedAt,
    };
    this.handler?.onStatusChange({ ...this._state });
  }
}

/**
 * Fully in-memory adapter useful for unit tests of ChannelService.
 * Captures inbound→handler wiring and records outbound sends.
 */
export class InMemoryChannelAdapter extends BaseChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    inboundEvents: true,
    outboundReply: true,
    card: false,
    longConnection: false,
  };

  readonly sentMessages: OutboundMessage[] = [];
  private disposed = false;

  constructor(channelId: string, kind: ChannelKind = 'feishu') {
    super(channelId, kind);
  }

  async connect(_config: ChannelConfig, handler: ChannelEventHandler): Promise<void> {
    this.handler = handler;
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.handler = null;
    this.setStatus('disconnected');
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    this.sentMessages.push(message);
    return { ok: true, externalMessageId: `mem-${Date.now()}` };
  }

  async testConnection(_config: ChannelConfig): Promise<ChannelTestResult> {
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    this.handler = null;
    this.setStatus('disconnected');
  }

  /** Simulate an inbound message arriving from the external platform */
  simulateInbound(message: InboundMessage): void {
    this.handler?.onMessage(message);
  }

  /** Simulate an error being raised by the external platform */
  simulateError(error: Error): void {
    this.handler?.onError(error);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
