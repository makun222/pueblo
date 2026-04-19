import { app, BrowserWindow } from 'electron';
import * as path from 'path';

export function createWindow(): BrowserWindow {
  const isDev = process.env.NODE_ENV === 'development';
  const rendererEntryPath = path.join(app.getAppPath(), 'dist', 'desktop', 'renderer', 'index.html');

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the renderer
  if (isDev) {
    win.loadURL('http://localhost:5173'); // Vite dev server
  } else {
    win.loadFile(rendererEntryPath);
  }

  // Show window when ready
  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}