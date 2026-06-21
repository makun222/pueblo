import type { BrowserWindow } from 'electron';
import type { McpClientManager } from './mcp-client';
import type { McpServerConfig } from './mcp-types';
import { listApiKeyServers, setApiKey, deleteApiKey } from './mcp-credentials';

/**
 * Registers all MCP-related IPC handlers on the main process.
 * Broadcasts `mcp:server-list-changed` to all known windows after any
 * server state mutation so renderer UIs stay in sync.
 */
export function registerMcpIpcHandlers(
  win: BrowserWindow,
  client: McpClientManager,
  getServers: () => McpServerConfig[],
  setServers: (servers: McpServerConfig[]) => void,
  mcpManagerWindow: BrowserWindow | null = null,
): void {
  const { ipcMain } = require('electron');

  /** Sends current server list to all known windows. */
  function broadcastServers(): void {
    const list = getServers();
    win.webContents.send('mcp:server-list-changed', list);
    if (mcpManagerWindow && !mcpManagerWindow.isDestroyed()) {
      mcpManagerWindow.webContents.send('mcp:server-list-changed', list);
    }
  }

  ipcMain.handle('mcp:list-servers', async () => {
    return getServers();
  });

  ipcMain.handle('mcp:add-server', async (_event: any, server: McpServerConfig) => {
    const servers = [...getServers(), server];
    setServers(servers);
    await client.addServer(server);
    broadcastServers();
    return server;
  });

  ipcMain.handle('mcp:remove-server', async (_event: any, serverName: string) => {
    const servers = getServers().filter((s) => s.name !== serverName);
    setServers(servers);
    await client.removeServer(serverName);
    broadcastServers();
  });

  ipcMain.handle('mcp:update-server', async (_event: any, server: McpServerConfig) => {
    const servers = getServers().map((s) => (s.name === server.name ? server : s));
    setServers(servers);
    await client.removeServer(server.name);
    await client.addServer(server);
    broadcastServers();
    return server;
  });

  ipcMain.handle('mcp:restart-server', async (_event: any, serverName: string) => {
    const server = getServers().find((s) => s.name === serverName);
    if (!server) throw new Error(`Server "${serverName}" not found`);
    await client.removeServer(serverName);
    await client.addServer(server);
  });

  ipcMain.handle('mcp:test-connection', async (_event: any, server: McpServerConfig) => {
    try {
      const result = await client.testConnection(server);
      return { success: result.connected, toolCount: result.toolsFound ?? 0 };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('mcp:list-credentials', async () => {
    return listApiKeyServers();
  });

  ipcMain.handle('mcp:save-credential', async (_event: any, key: string, value: string) => {
    await setApiKey(key, value);
  });

  ipcMain.handle('mcp:delete-credential', async (_event: any, key: string) => {
    await deleteApiKey(key);
  });
}
