import { describe, it, expect, vi, beforeEach } from 'vitest';

// Persistence is fs-backed; stub it so CRUD logic is testable in memory.
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../../src/channel/channel-debug-log', () => ({ channelDebugLog: vi.fn() }));

import { readFile, writeFile } from 'node:fs/promises';
import {
  loadChannelsConfig,
  saveChannelsConfig,
  getChannelConfig,
  upsertChannelConfig,
  deleteChannelConfig,
} from '../../../src/channel/channel-config';
import type { ChannelConfig } from '../../../src/channel/channel-types';

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);

function cfg(id: string, over: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id, kind: 'feishu', name: id, enabled: true, transport: 'long-connection', options: {}, ...over };
}

function seedStore(channels: ChannelConfig[]): void {
  mockedReadFile.mockResolvedValue(JSON.stringify({ channels }) as never);
}

function lastWrittenChannels(): ChannelConfig[] {
  const call = mockedWriteFile.mock.calls.at(-1)!;
  const payload = JSON.parse(call[1] as string) as { channels: ChannelConfig[] };
  return payload.channels;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedWriteFile.mockResolvedValue(undefined as never);
});

describe('loadChannelsConfig / saveChannelsConfig', () => {
  it('returns an empty store when the file cannot be read', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT') as never);
    const config = await loadChannelsConfig();
    expect(config.channels).toEqual([]);
  });

  it('persists only the channels array', async () => {
    await saveChannelsConfig({ channels: [cfg('a')] });
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(lastWrittenChannels()).toHaveLength(1);
  });
});

describe('getChannelConfig', () => {
  it('finds a channel by id', async () => {
    seedStore([cfg('a'), cfg('b')]);
    expect((await getChannelConfig('b'))?.id).toBe('b');
  });

  it('returns null when the channel is absent', async () => {
    seedStore([cfg('a')]);
    expect(await getChannelConfig('nope')).toBeNull();
  });
});

describe('upsertChannelConfig', () => {
  it('appends a new channel', async () => {
    seedStore([cfg('a')]);
    await upsertChannelConfig(cfg('b'));
    expect(lastWrittenChannels().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('replaces an existing channel with the same id', async () => {
    seedStore([cfg('a', { name: 'old' })]);
    await upsertChannelConfig(cfg('a', { name: 'new', enabled: false }));

    const out = lastWrittenChannels();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('new');
    expect(out[0].enabled).toBe(false);
  });
});

describe('deleteChannelConfig', () => {
  it('removes a channel and reports success', async () => {
    seedStore([cfg('a'), cfg('b')]);
    await expect(deleteChannelConfig('a')).resolves.toBe(true);
    expect(lastWrittenChannels().map((c) => c.id)).toEqual(['b']);
  });

  it('returns false and does not persist when the id is absent', async () => {
    seedStore([cfg('a')]);
    await expect(deleteChannelConfig('missing')).resolves.toBe(false);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
