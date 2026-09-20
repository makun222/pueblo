import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../../../src/channel/channel-service';
import { InMemoryChannelAdapter } from '../../../src/channel/channel-adapter';
import { ChannelRegistry } from '../../../src/channel/channel-registry';
import type { ChannelConfig, OutboundMessage } from '../../../src/channel/channel-types';

function makeConfig(over: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'test-1', kind: 'feishu', name: 'test', enabled: true, transport: 'long-connection', options: {}, ...over };
}

function makeService() {
  const registry = new ChannelRegistry();
  registry.register('feishu', (config) => new InMemoryChannelAdapter(config.id, 'feishu'));
  const runtime = { submitInput: vi.fn().mockResolvedValue(undefined) };
  const createSession = vi.fn().mockResolvedValue('session-new');
  const service = new ChannelService({ runtime: runtime as never, registry, createSession });
  return { service, registry, runtime, createSession };
}

describe('ChannelService lifecycle', () => {
  it('startChannel registers the adapter and reports connected status', async () => {
    const { service } = makeService();

    await service.startChannel(makeConfig());

    const active = service.getChannel('test-1');
    expect(active?.adapter).toBeInstanceOf(InMemoryChannelAdapter);
    expect(service.getStatus()).toHaveLength(1);
    expect(service.getStatus()[0]).toMatchObject({ channelId: 'test-1', status: 'connected' });
  });

  it('restarting the same channel keeps a single active adapter', async () => {
    const { service } = makeService();
    await service.startChannel(makeConfig());
    const first = service.getChannel('test-1')!.adapter;
    const disconnectSpy = vi.spyOn(first, 'disconnect');

    await service.startChannel(makeConfig());

    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(service.getStatus()).toHaveLength(1);
    expect(service.getChannel('test-1')!.adapter).not.toBe(first);
  });

  it('throws when no factory is registered for the kind', async () => {
    const registry = new ChannelRegistry();
    const service = new ChannelService({
      runtime: { submitInput: vi.fn() } as never,
      registry,
      createSession: vi.fn(),
    });

    await expect(service.startChannel(makeConfig())).rejects.toThrow();
    expect(service.getStatus()).toHaveLength(0);
  });

  it('stopChannel returns false when idle and true after start', async () => {
    const { service } = makeService();

    await expect(service.stopChannel('test-1')).resolves.toBe(false);

    await service.startChannel(makeConfig());
    await expect(service.stopChannel('test-1')).resolves.toBe(true);

    expect(service.getStatus()).toHaveLength(0);
    expect(service.getChannel('test-1')).toBeUndefined();
  });

  it('send throws before start and records the message after start', async () => {
    const { service } = makeService();
    const outbound: OutboundMessage = { externalConversationId: 'conv-1', text: 'hi' };

    await expect(service.send('test-1', outbound)).rejects.toThrow();

    await service.startChannel(makeConfig());
    await service.send('test-1', outbound);

    const adapter = service.getChannel('test-1')!.adapter as InMemoryChannelAdapter;
    expect(adapter.sentMessages).toEqual([outbound]);
  });

  it('dispose stops every active channel', async () => {
    const { service } = makeService();
    await service.startChannel(makeConfig());

    service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getStatus()).toHaveLength(0);
  });
});
