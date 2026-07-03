// ---------------------------------------------------------------------------
// Channel IPC — Desktop main-process IPC handlers for channel management.
// Mirrors mcp-ipc.ts registration style.
// ---------------------------------------------------------------------------

import type { BrowserWindow } from 'electron';
import type { ChannelService } from '../channel/channel-service';
import type { ChannelConfig } from '../channel/channel-types';
import {
  deleteChannelConfig,
  loadChannelsConfig,
  upsertChannelConfig,
} from '../channel/channel-config';

const CHANNEL_IPC_CHANNELS = [
  'channel:list',
  'channel:save',
  'channel:delete',
  'channel:test',
  'channel:start',
  'channel:stop',
  'channel:status',
] as const;

export interface ChannelIpcDependencies {
  readonly channelService: ChannelService;
  /** Test a channel config via its adapter (no real message sent) */
  readonly testChannel: (config: ChannelConfig) => Promise<{ ok: boolean; error?: string }>;
}

export function registerChannelIpcHandlers(
  _win: BrowserWindow,
  deps: ChannelIpcDependencies,
): () => void {
  const { ipcMain } = require('electron');

  ipcMain.handle('channel:list', async () => {
    const config = await loadChannelsConfig();
    return config.channels;
  });

  ipcMain.handle('channel:save', async (_event: unknown, config: ChannelConfig) => {
    try {
      await upsertChannelConfig(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('channel:delete', async (_event: unknown, channelId: string) => {
    try {
      const removed = await deleteChannelConfig(channelId);
      if (removed) {
        await deps.channelService.stopChannel(channelId);
      }
      return { success: removed };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('channel:test', async (_event: unknown, config: ChannelConfig) => {
    return deps.testChannel(config);
  });

  ipcMain.handle('channel:start', async (_event: unknown, channelId: string) => {
    try {
      const config = (await loadChannelsConfig()).channels.find((c) => c.id === channelId);
      if (!config) return { success: false, error: `Channel "${channelId}" not found` };
      await deps.channelService.startChannel(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('channel:stop', async (_event: unknown, channelId: string) => {
    try {
      const stopped = await deps.channelService.stopChannel(channelId);
      return { success: stopped };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('channel:status', async () => {
    return deps.channelService.getStatus();
  });

  return () => {
    for (const channel of CHANNEL_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}
