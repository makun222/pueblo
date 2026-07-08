import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelService } from '../../../src/channel/channel-service';
import { InMemoryChannelAdapter } from '../../../src/channel/channel-adapter';
import type { ChannelConfig, ChannelType, InboundMessage } from '../../../src/channel/channel-types';
import { createChannelRegistry } from '../../../src/channel/channel-registry-factory';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockSubmitInput = vi.fn();

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'test-1',
    type: 'test-type' as ChannelType,
    enabled: true,
    credential: 'cred-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ChannelService', () => {
  let service: ChannelService;
  let adapter: InMemoryChannelAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const registry = createChannelRegistry();
    registry.register('test-type', InMemoryChannelAdapter);
    service = new ChannelService(registry, mockSubmitInput);
    adapter = new InMemoryChannelAdapter(makeConfig(), mockSubmitInput);
  });

  afterEach(async () => {
    await service.dispose();
    await adapter.dispose();
  });

  // ---- registration ----
  it('registers and retrieves a channel adapter', () => {
    service.registerChannel(adapter);
    expect(service.getChannel('test-1')).toBe(adapter);
  });

  it('returns undefined for unknown channel', () => {
    expect(service.getChannel('nonexistent')).toBeUndefined();
  });

  it('lists all registered channels', () => {
    service.registerChannel(adapter);
    const channels = service.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe('test-1');
  });

  // ---- lifecycle ----
  it('connectChannel delegates to adapter connect', async () => {
    const connectSpy = vi.spyOn(adapter, 'connect');
    service.registerChannel(adapter);
    await service.connectChannel('test-1');
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('disconnectChannel delegates to adapter disconnect', async () => {
    const disconnectSpy = vi.spyOn(adapter, 'disconnect');
    service.registerChannel(adapter);
    await service.disconnectChannel('test-1');
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  it('rejects connect for unregistered channel', async () => {
    await expect(service.connectChannel('ghost')).rejects.toThrow(/not found/i);
  });

  // ---- send ----
  it('send delegates to adapter send', async () => {
    const sendSpy = vi.spyOn(adapter, 'send');
    service.registerChannel(adapter);
    await service.send('test-1', 'hello');
    expect(sendSpy).toHaveBeenCalledWith('hello');
  });

  it('rejects send for unregistered channel', async () => {
    await expect(service.send('ghost', 'data')).rejects.toThrow(/not found/i);
  });

  // ---- dispose ----
  it('dispose disconnects all channels', async () => {
    const disposeSpy = vi.spyOn(adapter, 'dispose');
    service.registerChannel(adapter);
    await service.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(service.listChannels()).toHaveLength(0);
  });

  // ---- adapter error handling ----
  it('handles adapter disconnect event by removing the channel', async () => {
    service.registerChannel(adapter);
    expect(service.getChannel('test-1')).toBe(adapter);

    // Simulate adapter disconnecting
    adapter.emit('disconnected', 'test-1');
    expect(service.getChannel('test-1')).toBeUndefined();
  });

  it('forwards inbound messages from adapter to submitInput', async () => {
    service.registerChannel(adapter);

    const msg: InboundMessage = {
      channelId: 'test-1',
      text: 'hi from channel',
      from: 'user-1',
      timestamp: Date.now(),
    };
    adapter.emit('message', msg);

    expect(mockSubmitInput).toHaveBeenCalledWith(msg.text, expect.any(Object));
  });

  // ---- registration with config ----
  it('creates adapter from config and registers it', () => {
    const config = makeConfig();
    const created = service.registerChannelFromConfig(config);
    expect(created).toBeDefined();
    expect(created.id).toBe('test-1');
    expect(service.getChannel('test-1')).toBe(created);
  });

  it('throws on register with unknown type', () => {
    const config = makeConfig({ type: 'unknown-type' as ChannelType });
    expect(() => service.registerChannelFromConfig(config)).toThrow(/no adapter/i);
  });
});
