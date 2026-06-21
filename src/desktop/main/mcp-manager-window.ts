import { BrowserWindow, app } from 'electron';
import path from 'path';

/**
 * Creates the MCP Manager sub-window.
 * This window is separate from the main application window
 * and hosts the MCP configuration UI.
 */
export function createMcpManagerWindow(parent?: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    parent: parent ?? undefined,
    modal: false,
    title: 'MCP Manager',
    webPreferences: {
      preload: path.join(__dirname, '../preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the mcp-manager entry point
  const isDev = process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL !== undefined;
  if (isDev) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    win.loadURL(`${devServerUrl}/mcp-manager.html`);
  } else {
    win.loadFile(
      path.join(app.getAppPath(), 'dist', 'desktop', 'renderer', 'mcp-manager.html'),
    );
  }

  // Remove menu bar for the sub-window
  win.setMenuBarVisibility(false);

  return win;
}
