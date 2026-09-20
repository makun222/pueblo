import { describe, it, expect, vi, beforeEach } from 'vitest';

// The command talks to channel-config directly; stub persistence so the command
// surface (routing / validation / result codes) is testable in memory.
const configMock = vi.hoisted(() => ({
  channels: [] as unknown[],
  load: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../src/channel/channel-config', () => ({
  loadChannelsConfig: configMock.load,
  upsertChannelConfig: configMock.upsert,
  deleteChannelConfig: configMock.remove,
}));

import { createChannelCommand } from '../../../src/commands/channel-command';
import type { ChannelService } from '../../../src/channel/channel-service';

function makeDeps(serviceOver: Record<string, unknown> = {}, withCredential = true) {
  const channelService = {
    startChannel: vi.fn().mockResolvedValue(undefined),
    stopChannel: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockReturnValue([]),
    ...serviceOver,
  } as unknown as ChannelService;
  const setCredential = vi.fn();
  const run = createChannelCommand({ channelService, ...(withCredential ? { setCredential } : {}) });
  return { run, channelService, setCredential };
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.channels = [];
  configMock.load.mockImplementation(async () => ({ channels: configMock.channels }));
  configMock.upsert.mockResolvedValue(undefined);
  configMock.remove.mockResolvedValue(true);
});

describe('/channel routing + validation', () => {
  it('rejects unknown subcommands with INVALID_USAGE', async () => {
    const { run } = makeDeps();
    const res = await run(['bogus']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_USAGE');
  });

  it('rejects "add" without the required positional args', async () => {
    const { run } = makeDeps();
    const res = await run(['add', 'bot', 'feishu']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_USAGE');
    expect(configMock.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unsupported channel kind', async () => {
    const { run } = makeDeps();
    const res = await run(['add', 'bot', 'slack', 'MyBot']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_USAGE');
    expect(res.message).toMatch(/Unsupported channel kind/);
  });

  it('rejects malformed optionsJson', async () => {
    const { run } = makeDeps();
    const res = await run(['add', 'bot', 'feishu', 'MyBot', 'not-json']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_USAGE');
  });
});

describe('/channel add', () => {
  it('persists a validated channel config', async () => {
    const { run } = makeDeps();

    const res = await run(['add', 'bot', 'feishu', 'MyBot', '{"appId":"app-1"}']);

    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_SAVED');
    expect(configMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'bot',
        kind: 'feishu',
        name: 'MyBot',
        enabled: true,
        transport: 'long-connection',
        options: { appId: 'app-1' },
        credentialTarget: 'pueblo:feishu:bot',
      }),
    );
  });
});

describe('/channel list', () => {
  it('returns the configured channels', async () => {
    configMock.channels = [{ id: 'a' }, { id: 'b' }];
    const { run } = makeDeps();

    const res = await run(['list']);

    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_LIST');
    expect((res.data as { channels: unknown[] }).channels).toHaveLength(2);
  });
});

describe('/channel remove', () => {
  it('reports success when the channel existed', async () => {
    const { run } = makeDeps();
    const res = await run(['remove', 'bot']);
    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_REMOVED');
    expect(configMock.remove).toHaveBeenCalledWith('bot');
  });

  it('reports CHANNEL_NOT_FOUND when nothing was removed', async () => {
    configMock.remove.mockResolvedValue(false);
    const { run } = makeDeps();
    const res = await run(['remove', 'ghost']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('requires an id', async () => {
    const { run } = makeDeps();
    const res = await run(['remove']);
    expect(res.code).toBe('INVALID_USAGE');
  });
});

describe('/channel start', () => {
  it('starts a configured channel through the service', async () => {
    configMock.channels = [{ id: 'bot', kind: 'feishu' }];
    const { run, channelService } = makeDeps();

    const res = await run(['start', 'bot']);

    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_STARTED');
    expect(channelService.startChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot' }));
  });

  it('reports CHANNEL_NOT_FOUND for an unknown id', async () => {
    const { run, channelService } = makeDeps();
    const res = await run(['start', 'ghost']);
    expect(res.code).toBe('CHANNEL_NOT_FOUND');
    expect(channelService.startChannel).not.toHaveBeenCalled();
  });

  it('surfaces a start failure', async () => {
    configMock.channels = [{ id: 'bot', kind: 'feishu' }];
    const { run } = makeDeps({ startChannel: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await run(['start', 'bot']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_START_FAILED');
  });
});

describe('/channel stop', () => {
  it('reports success when the channel was running', async () => {
    const { run, channelService } = makeDeps({ stopChannel: vi.fn().mockResolvedValue(true) });
    const res = await run(['stop', 'bot']);
    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_STOPPED');
    expect(channelService.stopChannel).toHaveBeenCalledWith('bot');
  });

  it('reports CHANNEL_NOT_RUNNING when nothing was stopped', async () => {
    const { run } = makeDeps({ stopChannel: vi.fn().mockResolvedValue(false) });
    const res = await run(['stop', 'bot']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_NOT_RUNNING');
  });
});

describe('/channel status', () => {
  it('returns the running channel states', async () => {
    const states = [{ channelId: 'bot', kind: 'feishu', status: 'connected' }];
    const { run } = makeDeps({ getStatus: vi.fn().mockReturnValue(states) });

    const res = await run(['status']);

    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_STATUS');
    expect((res.data as { states: unknown[] }).states).toEqual(states);
  });
});

describe('/channel secret', () => {
  it('stores the app secret under the pueblo:feishu:<id> target', async () => {
    const { run, setCredential } = makeDeps();
    const res = await run(['secret', 'bot', 's3cret']);
    expect(res.ok).toBe(true);
    expect(res.code).toBe('CHANNEL_SECRET_SET');
    expect(setCredential).toHaveBeenCalledWith('pueblo:feishu:bot', 's3cret');
  });

  it('fails when no credential store is wired', async () => {
    const { run } = makeDeps({}, false);
    const res = await run(['secret', 'bot', 's3cret']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CREDENTIAL_STORE_UNAVAILABLE');
  });

  it('requires both id and secret', async () => {
    const { run } = makeDeps();
    const res = await run(['secret', 'bot']);
    expect(res.code).toBe('INVALID_USAGE');
  });
});
