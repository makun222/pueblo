import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../../src/channel/channel-debug-log', () => ({ channelDebugLog: vi.fn() }));

import { readFile } from 'node:fs/promises';
import { loadChannelsConfig, normalizeChannelEntry } from '../../../src/channel/channel-config';

const mockedReadFile = vi.mocked(readFile);

describe('normalizeChannelEntry', () => {
  it('returns null when id or kind is missing', () => {
    expect(normalizeChannelEntry(null)).toBeNull();
    expect(normalizeChannelEntry('nope')).toBeNull();
    expect(normalizeChannelEntry({ id: 'a' })).toBeNull();
    expect(normalizeChannelEntry({ kind: 'feishu' })).toBeNull();
  });

  it('maps legacy `type` to `kind` and hoists option keys into `options`', () => {
    const result = normalizeChannelEntry({
      id: 'feishu-1',
      type: 'feishu',
      enabled: true,
      appId: 'cli_xxx',
      appSecret: 'sec',
      endpoint: 'https://open.feishu.cn',
    });

    expect(result).toMatchObject({
      id: 'feishu-1',
      kind: 'feishu',
      name: 'feishu-1',
      enabled: true,
      transport: 'long-connection',
      options: {
        appId: 'cli_xxx',
        appSecret: 'sec',
        endpointUrl: 'https://open.feishu.cn',
      },
      source: 'manual',
    });
    expect(result?.options.endpoint).toBeUndefined();
  });

  it('defaults name / enabled / transport and maps `credential`', () => {
    const result = normalizeChannelEntry({ id: 'feishu-2', kind: 'feishu', credential: 'cred-x' });

    expect(result).toMatchObject({
      id: 'feishu-2',
      name: 'feishu-2',
      enabled: true,
      transport: 'long-connection',
      credentialTarget: 'cred-x',
    });
  });

  it('preserves a modern shape (kind + options + transport) untouched', () => {
    const modern = {
      id: 'feishu-3',
      kind: 'feishu' as const,
      name: 'primary',
      enabled: false,
      transport: 'webhook' as const,
      options: { appId: 'a', appSecret: 'b' },
      credentialTarget: 'pueblo:feishu:feishu-3',
    };
    expect(normalizeChannelEntry(modern)).toEqual({ ...modern, source: 'manual' });
  });

  it('coerces an invalid transport to long-connection', () => {
    const result = normalizeChannelEntry({ id: 'x', kind: 'feishu', transport: 'bogus' });
    expect(result?.transport).toBe('long-connection');
  });
});

describe('loadChannelsConfig — legacy nested array shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flattens nested arrays and normalizes each entry', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        channels: [
          [
            { id: 'feishu-1', type: 'feishu', enabled: true, appId: 'cli_xxx', appSecret: 'sec' },
            { id: 'slack-1', type: 'feishu', enabled: false },
          ],
        ],
      }) as never,
    );

    const config = await loadChannelsConfig();

    expect(config.channels).toHaveLength(2);
    expect(config.channels[0]).toMatchObject({
      id: 'feishu-1',
      kind: 'feishu',
      enabled: true,
      transport: 'long-connection',
      options: { appId: 'cli_xxx', appSecret: 'sec' },
    });
    expect(config.channels[1]).toMatchObject({ id: 'slack-1', kind: 'feishu', enabled: false });
  });

  it('still accepts a bare top-level array', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify([{ id: 'feishu-9', kind: 'feishu', name: 'n', enabled: true, transport: 'long-connection', options: {} }]) as never,
    );

    const config = await loadChannelsConfig();
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].id).toBe('feishu-9');
  });

  it('skips unusable entries instead of emitting undefined ids', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ channels: [{ id: 'no-kind' }, 'garbage', { kind: 'feishu' }] }) as never);
    const config = await loadChannelsConfig();
    expect(config.channels).toHaveLength(0);
  });
});
