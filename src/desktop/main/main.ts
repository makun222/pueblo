import { app, BrowserWindow } from 'electron';
import { setupIpcHandlers } from './ipc';
import { createWindow } from './window';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = createWindow();
  setupIpcHandlers(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
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