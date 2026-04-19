import { app, BrowserWindow, ipcMain } from 'electron';
import { createOutputBlock } from '../../shared/result';
import { setupIpcHandlers } from './ipc';
import { createWindow } from './window';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  try {
    setupIpcHandlers(mainWindow);
  } catch (error) {
    publishDesktopStartupError(mainWindow, error);
  }
}

function publishDesktopStartupError(window: BrowserWindow, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const errorBlock = createOutputBlock({
    type: 'error',
    title: 'Desktop Startup Error',
    content: `Desktop services failed to initialize.\n${message}`,
  });
  const sendErrorBlock = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('output', errorBlock);
    }
  };

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', sendErrorBlock);
  } else {
    sendErrorBlock();
  }

  ipcMain.removeHandler('submit-input');
  ipcMain.handle('submit-input', async () => {
    sendErrorBlock();

    if (error instanceof Error) {
      throw error;
    }

    throw new Error('Desktop services failed to initialize');
  });
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});