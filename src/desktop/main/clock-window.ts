import { BrowserWindow } from 'electron';
import path from 'path';

let clockWindow: BrowserWindow | null = null;

export function openClockWindow(): void {
  if (clockWindow && !clockWindow.isDestroyed()) {
    clockWindow.focus();
    return;
  }

  clockWindow = new BrowserWindow({
    width: 320,
    height: 420,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });

  const htmlPath = path.join(__dirname, '..', 'renderer', 'clock', 'clock.html');
  clockWindow.loadFile(htmlPath);

  clockWindow.on('closed', () => {
    clockWindow = null;
  });
}

export function closeClockWindow(): void {
  if (clockWindow && !clockWindow.isDestroyed()) {
    clockWindow.close();
    clockWindow = null;
  }
}

export function isClockWindowOpen(): boolean {
  return clockWindow !== null && !clockWindow.isDestroyed();
}
