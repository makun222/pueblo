import { describe, it, expect, vi } from 'vitest';
import { BaseChannelAdapter, InMemoryChannelAdapter } from '../../../src/channel/channel-adapter';
import type {
  ChannelConfig,
  ChannelEventHandler,
  ChannelSendResult,
  ChannelTestResult,
  InboundMessage,
  OutboundMessage,
} from '../../../src/channel/channel-types';

function makeConfig(id = 'ch-1'): ChannelConfig {
  return { id, kind: 'feishu', name: id, enabled: true, transport: 'long-connection', options: {} };
}

function makeInbound(channelId: string, text: string): InboundMessage {
  return {
    channelId,
    externalConversationId: 'conv-1',
    externalMessageId: 'm-1',
    senderId: 'u-1',
    text,
    raw: {},
    receivedAt: Date.now(),
  };
}

function makeHandler() {
  return { onMessage: vi.fn(), onError: vi.fn(), onStatusChange: vi.fn() } satisfies ChannelEventHandler;
}

class TestAdapter extends BaseChannelAdapter {
  readonly capabilities = { inboundEvents: true, outboundReply: true, card: false, longConnection: false };
  lastConfig: ChannelConfig | null = null;
  connectedCount = 0;
  disconnectedCount = 0;
  disposedFlag = false;

  constructor() {
    super('base-test', 'feishu');
  }

  async connect(config: ChannelConfig, handler: ChannelEventHandler): Promise<void> {
    this.lastConfig = config;
    this.handler = handler;
    this.connectedCount++;
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.disconnectedCount++;
    this.setStatus('disconnected');
    this.handler = null;
  }

  async send(_message: OutboundMessage): Promise<ChannelSendResult> {
    return { ok: true, externalMessageId: 'sent-1' };
  }

  async testConnection(_config: ChannelConfig): Promise<ChannelTestResult> {
    return { ok: true };
  }

  dispose(): void {
    this.disposedFlag = true;
    this.handler = null;
    this.setStatus('disconnected');
  }

  deliver(message: InboundMessage): void {
    this.handler?.onMessage(message);
  }

  raiseError(error: Error): void {
    this.handler?.onError(error);
  }
}

describe('BaseChannelAdapter', () => {
  it('starts disconnected with the configured id and kind', () => {
    const adapter = new TestAdapter();
    expect(adapter.state).toMatchObject({
      channelId: 'base-test',
      kind: 'feishu',
      status: 'disconnected',
      connectedAt: null,
    });
  });

  it('exposes capability flags', () => {
    expect(new TestAdapter().capabilities).toEqual({
      inboundEvents: true,
      outboundReply: true,
      card: false,
      longConnection: false,
    });
  });

  it('connect wires the handler and publishes connected', async () => {
    const adapter = new TestAdapter();
    const handler = makeHandler();
    const config = makeConfig('base-test');

    await adapter.connect(config, handler);

    expect(adapter.connectedCount).toBe(1);
    expect(adapter.lastConfig).toBe(config);
    expect(adapter.state.status).toBe('connected');
    expect(adapter.state.connectedAt).not.toBeNull();
    expect(handler.onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'connected' }));
  });

  it('fans status transitions out to the handler', async () => {
    const adapter = new TestAdapter();
    const handler = makeHandler();
    await adapter.connect(makeConfig('base-test'), handler);

    await adapter.disconnect();

    expect(adapter.state.status).toBe('disconnected');
    expect(handler.onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected' }));
  });

  it('routes delivered messages and errors through the handler', async () => {
    const adapter = new TestAdapter();
    const handler = makeHandler();
    await adapter.connect(makeConfig('base-test'), handler);

    const msg = makeInbound('base-test', 'hi');
    adapter.deliver(msg);
    const err = new Error('boom');
    adapter.raiseError(err);

    expect(handler.onMessage).toHaveBeenCalledWith(msg);
    expect(handler.onError).toHaveBeenCalledWith(err);
  });

  it('disconnect clears the handler so inbound events are dropped', async () => {
    const adapter = new TestAdapter();
    const handler = makeHandler();
    await adapter.connect(makeConfig('base-test'), handler);

    await adapter.disconnect();
    adapter.deliver(makeInbound('base-test', 'late'));

    expect(handler.onMessage).not.toHaveBeenCalled();
    expect(adapter.disconnectedCount).toBe(1);
  });
});

describe('InMemoryChannelAdapter', () => {
  it('defaults to the feishu kind and a disconnected state', () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    expect(adapter).toBeInstanceOf(BaseChannelAdapter);
    expect(adapter.state).toMatchObject({ channelId: 'mem-test', kind: 'feishu', status: 'disconnected' });
  });

  it('routes simulateInbound / simulateError to the handler', async () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    const handler = makeHandler();
    await adapter.connect(makeConfig('mem-test'), handler);
    expect(adapter.state.status).toBe('connected');

    const msg = makeInbound('mem-test', 'hello');
    adapter.simulateInbound(msg);
    const err = new Error('nope');
    adapter.simulateError(err);

    expect(handler.onMessage).toHaveBeenCalledWith(msg);
    expect(handler.onError).toHaveBeenCalledWith(err);
  });

  it('records outbound messages and reports success', async () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    await adapter.connect(makeConfig('mem-test'), makeHandler());

    const outbound: OutboundMessage = { externalConversationId: 'conv-1', text: 'reply' };
    const result = await adapter.send(outbound);

    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toBeTruthy();
    expect(adapter.sentMessages).toEqual([outbound]);
  });

  it('testConnection reports ok', async () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    expect(await adapter.testConnection(makeConfig('mem-test'))).toEqual({ ok: true });
  });

  it('disconnect drops later inbound events', async () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    const handler = makeHandler();
    await adapter.connect(makeConfig('mem-test'), handler);

    await adapter.disconnect();
    adapter.simulateInbound(makeInbound('mem-test', 'late'));

    expect(handler.onMessage).not.toHaveBeenCalled();
    expect(adapter.state.status).toBe('disconnected');
  });

  it('dispose flags isDisposed and moves to disconnected', async () => {
    const adapter = new InMemoryChannelAdapter('mem-test');
    await adapter.connect(makeConfig('mem-test'), makeHandler());

    adapter.dispose();

    expect(adapter.isDisposed).toBe(true);
    expect(adapter.state.status).toBe('disconnected');
  });
});
