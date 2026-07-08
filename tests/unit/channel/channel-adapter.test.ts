import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryChannelAdapter, BaseChannelAdapter } from '../../../src/channel/channel-adapter';
import type { ChannelConfig, ChannelType, InboundMessage } from '../../../src/channel/channel-types';

// ---------------------------------------------------------------------------
// Test double: minimal concrete subclass to verify abstract behaviour
// ---------------------------------------------------------------------------
class TestAdapter extends BaseChannelAdapter {
  override async connect(): Promise<void> { this._connected = true; }
  override async disconnect(): Promise<void> { this._connected = false; }
  override async send(_text: string): Promise<void> { /* no-op */ }
  override async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ChannelAdapter (abstract base)', () => {
  const config: ChannelConfig = { id: 'base-test', type: 'test' as ChannelType, enabled: true, credential: 'cred' };
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter(config, vi.fn());
  });

  afterEach(async () => {
    await adapter.dispose();
  });

  it('stores id and config from constructor', () => {
    expect(adapter.id).toBe('base-test');
    expect(adapter.type).toBe('test');
    expect(adapter.config).toEqual(config);
  });

  it('starts as disconnected', () => {
    expect(adapter.isConnected).toBe(false);
  });

  it('tracks connection state', async () => {
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
  });

  it('dispose calls disconnect and clears event listeners', async () => {
    const disconnectSpy = vi.spyOn(adapter, 'disconnect');
    await adapter.connect();
    await adapter.dispose();
    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(adapter.isConnected).toBe(false);
  });

  it('emits message events', () => {
    const handler = vi.fn();
    adapter.on('message', handler);

    const msg: InboundMessage = {
      channelId: 'base-test',
      text: 'hello',
      from: 'user',
      timestamp: 123,
    };
    adapter.emit('message', msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it('emits disconnected events', () => {
    const handler = vi.fn();
    adapter.on('disconnected', handler);
    adapter.emit('disconnected', 'base-test');
    expect(handler).toHaveBeenCalledWith('base-test');
  });

  it('removes event listeners on dispose', async () => {
    const handler = vi.fn();
    adapter.on('disconnected', handler);
    await adapter.dispose();
    adapter.emit('disconnected', 'base-test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('testConnection returns ok by default', async () => {
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InMemoryChannelAdapter
// ---------------------------------------------------------------------------
describe('InMemoryChannelAdapter', () => {
  const config: ChannelConfig = { id: 'mem-test', type: 'test' as ChannelType, enabled: true, credential: 'cred' };
  let adapter: InMemoryChannelAdapter;

  beforeEach(() => {
    adapter = new InMemoryChannelAdapter(config, vi.fn());
  });

  afterEach(async () => {
    await adapter.dispose();
  });

  it('connect resolves immediately and sets connected', async () => {
    expect(adapter.isConnected).toBe(false);
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
  });

  it('disconnect resolves immediately and clears connected', async () => {
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
  });

  it('send stores outgoing messages', async () => {
    await adapter.connect();
    await adapter.send('msg1');
    await adapter.send('msg2');
    const history = (adapter as any).outgoing;
    expect(history).toEqual(['msg1', 'msg2']);
  });

  it('send throws when not connected', async () => {
    await expect(adapter.send('fail')).rejects.toThrow(/not connected/i);
  });

  it('testConnection returns ok when connected', async () => {
    await adapter.connect();
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
  });

  it('testConnection returns error when not connected', async () => {
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('dispose clears event listeners and disconnects', async () => {
    const handler = vi.fn();
    adapter.on('message', handler);
    await adapter.connect();
    await adapter.dispose();

    expect(adapter.isConnected).toBe(false);
    // verify listener cleared
    adapter.emit('message', {} as InboundMessage);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits disconnected when disposed', async () => {
    const handler = vi.fn();
    adapter.on('disconnected', handler);
    await adapter.connect();
    await adapter.dispose();
    expect(handler).toHaveBeenCalledWith('mem-test');
  });
});
