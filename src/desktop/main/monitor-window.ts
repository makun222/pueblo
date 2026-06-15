import { BrowserWindow, screen } from 'electron';
import path from 'path';

/**
 * MonitorWindow manages a dedicated BrowserWindow that displays
 * loop job progress in real time via IPC events from the main process.
 *
 * Phase 2 skeleton — created per loop-plan-b.md architecture.
 */
export class MonitorWindow {
  private window: BrowserWindow | null = null;

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return this.window;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;

    // Position monitor as a narrow sidebar on the right
    const monitorWidth = 360;
    const monitorHeight = 700;

    this.window = new BrowserWindow({
      width: monitorWidth,
      height: monitorHeight,
      x: screenWidth - monitorWidth - 16,
      y: 48,
      title: 'Pueblo Loop Monitor',
      resizable: true,
      frame: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'renderer', 'monitor', 'monitor-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const htmlPath = path.join(__dirname, 'monitor-window.html');
    this.window.loadFile(htmlPath);

    this.window.once('ready-to-show', () => {
      this.window?.show();
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    return this.window;
  }

  /** Send an IPC event to the monitor renderer. */
  send(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args);
    }
  }

  getBrowserWindow(): BrowserWindow | null {
    return this.window;
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
      this.window = null;
    }
  }
}
