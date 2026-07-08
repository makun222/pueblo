import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadChannelsConfig, saveChannelsConfig, getChannelConfig, upsertChannelConfig, deleteChannelConfig } from '../../../src/channel/channel-config';
import type { ChannelConfig } from '../../../src/channel/channel-types';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('node:fs');

const mockConfigPath = '/fake/path/channels.json';
const validConfig: ChannelConfig[] = [
  {
    id: 'feishu-1',
    type: 'feishu' as any,
    enabled: true,
    credential: 'cred-abc',
    endpoint: 'https://open.feishu.cn',
    appId: 'cli_xxxx',
    appSecret: 'secret_xxxx',
    isTest: false,
  },
  {
    id: 'slack-1',
    type: 'feishu' as any,
    enabled: false,
    credential: 'cred-def',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('channel-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadChannelsConfig', () => {
    it('returns parsed config when file exists and is valid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const result = loadChannelsConfig(mockConfigPath);
      expect(result).toEqual(validConfig);
    });

    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadChannelsConfig(mockConfigPath);
      expect(result).toEqual([]);
    });

    it('returns empty array on JSON parse error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid json}}');

      const result = loadChannelsConfig(mockConfigPath);
      expect(result).toEqual([]);
    });
  });

  describe('saveChannelsConfig', () => {
    it('writes JSON to file', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveChannelsConfig(mockConfigPath, validConfig);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify(validConfig, null, 2),
        'utf-8',
      );
    });

    it('throws on write failure', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => saveChannelsConfig(mockConfigPath, validConfig)).toThrow('disk full');
    });
  });

  describe('getChannelConfig', () => {
    it('returns config by id', () => {
      const result = getChannelConfig(validConfig, 'feishu-1');
      expect(result).toEqual(validConfig[0]);
    });

    it('returns undefined for unknown id', () => {
      const result = getChannelConfig(validConfig, 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('upsertChannelConfig', () => {
    it('adds a new config when id does not exist', () => {
      const newConfig: ChannelConfig = {
        id: 'new-1',
        type: 'feishu' as any,
        enabled: true,
        credential: 'cred-new',
      };
      const result = upsertChannelConfig([...validConfig], newConfig);
      expect(result).toHaveLength(3);
      expect(result[2]).toEqual(newConfig);
    });

    it('updates an existing config when id matches', () => {
      const update: Partial<ChannelConfig> = { enabled: false, endpoint: 'https://new.example.com' };
      const result = upsertChannelConfig([...validConfig], { id: 'feishu-1', ...update } as ChannelConfig);
      expect(result).toHaveLength(2);
      expect(result[0].enabled).toBe(false);
      expect(result[0].endpoint).toBe('https://new.example.com');
    });
  });

  describe('deleteChannelConfig', () => {
    it('removes config by id', () => {
      const result = deleteChannelConfig([...validConfig], 'feishu-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('slack-1');
    });

    it('returns same array when id not found', () => {
      const result = deleteChannelConfig([...validConfig], 'nonexistent');
      expect(result).toHaveLength(2);
    });
  });
});
