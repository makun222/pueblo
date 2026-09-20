import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';
import { createFeishuChannelAdapter } from '../../src/channel/channels/feishu/feishu-adapter';
import type { ChannelConfig, ChannelEventHandler } from '../../src/channel/channel-types';
import type { CredentialStore } from '../../src/providers/credential-store';

vi.mock('@larksuite/channel');

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'feishu-1',
    kind: 'feishu',
    name: 'feishu-1',
    enabled: true,
    transport: 'long-connection',
    options: { appId: 'app-id' },
    ...overrides,
  };
}

function makeStore(secret: string | null): CredentialStore {
  return {
    kind: 'windows-credential-manager',
    isSupported: () => true,
    readSecret: vi.fn(() => secret),
    writeSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
}

function makeHandler(): ChannelEventHandler {
  return { onMessage: vi.fn(), onError: vi.fn(), onStatusChange: vi.fn() };
}

const larkChannelMock = {
  on: vi.fn(() => () => {}),
  connect: vi.fn(async () => {}),
  send: vi.fn(),
  close: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createLarkChannel).mockReturnValue(larkChannelMock as never);
});

describe('FeishuAdapter credential-store fallback', () => {
  it('reads appSecret from the store (target pueblo:feishu:<id>) when options lack it', async () => {
    const store = makeStore('stored-secret');
    const adapter = createFeishuChannelAdapter(makeConfig(), store);

    await adapter.connect(makeConfig(), makeHandler());

    expect(store.readSecret).toHaveBeenCalledWith('pueblo:feishu:feishu-1');
    expect(createLarkChannel).toHaveBeenCalledWith({ appId: 'app-id', appSecret: 'stored-secret' });
  });

  it('prefers the explicit credentialTarget over the derived one', async () => {
    const store = makeStore('stored-secret');
    const config = makeConfig({ credentialTarget: 'pueblo:feishu:custom' });
    const adapter = createFeishuChannelAdapter(config, store);

    await adapter.connect(config, makeHandler());

    expect(store.readSecret).toHaveBeenCalledWith('pueblo:feishu:custom');
  });

  it('does not touch the store when options already carry appSecret', async () => {
    const store = makeStore('stored-secret');
    const config = makeConfig({ options: { appId: 'app-id', appSecret: 'inline-secret' } });
    const adapter = createFeishuChannelAdapter(config, store);

    await adapter.connect(config, makeHandler());

    expect(store.readSecret).not.toHaveBeenCalled();
    expect(createLarkChannel).toHaveBeenCalledWith({ appId: 'app-id', appSecret: 'inline-secret' });
  });

  it('still throws when neither options nor the store provide a secret', async () => {
    const store = makeStore(null);
    const adapter = createFeishuChannelAdapter(makeConfig(), store);

    await expect(adapter.connect(makeConfig(), makeHandler())).rejects.toThrow('appSecret');
  });
});
