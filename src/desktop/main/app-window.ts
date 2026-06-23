import type { BrowserWindow } from 'electron';
import { createWindow } from './window';
import { installDesktopApplicationMenu } from './menu';
import { MonitorWindow } from './monitor-window';
import type { OnRoundProgress } from '../../shared/result.js';

/**
 * AppWindow owns the main desktop BrowserWindow and serves as the
 * integration hub for IPC broadcasting, loop-job progress routing,
 * and MonitorWindow lifecycle.
 *
 * Phase 2.7 / 3.2 — created per loop-plan-b.md architecture.
 */
export class AppWindow {
  readonly browserWindow: BrowserWindow;

  private monitorWindow: MonitorWindow | null = null;
  private closedCallbacks: Array<() => void> = [];

  constructor(onOpenMcp?: () => void, onOpenClock?: () => void) {
    this.browserWindow = createWindow();
    installDesktopApplicationMenu(this.browserWindow, onOpenMcp, onOpenClock);

    this.browserWindow.on('closed', () => {
      for (const cb of this.closedCallbacks) {
        try {
          cb();
        } catch {
          /* swallow per-callback errors so other cleanups still run */
        }
      }
      this.closedCallbacks.length = 0;
    });
  }

  // ─── IPC helpers ────────────────────────────────────────────

  /**
   * Safely send an IPC event to the main renderer process.
   * No-op when the window is already destroyed.
   */
  send(channel: string, ...args: unknown[]): void {
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send(channel, ...args);
    }
  }

  // ─── lifecycle ──────────────────────────────────────────────

  /**
   * Register a callback that fires once when the window is closed.
   * Callbacks run in registration order; errors are swallowed.
   */
  onClosed(callback: () => void): void {
    this.closedCallbacks.push(callback);
  }

  // ─── loop progress ──────────────────────────────────────────

  /**
   * Create an `OnRoundProgress` callback bound to a specific job.
   * It broadcasts `loop:job-progress` to the main renderer and,
   * when open, the monitor overlay window.
   */
  createLoopProgressSender(_jobId: string): OnRoundProgress {
    return (event) => {
      // LoopProgressEvent already carries jobId, so pass it through directly.
      this.send('loop:job-progress', event);
      this.monitorWindow?.send('loop:job-progress', event);
    };
  }

  // ─── monitor window ─────────────────────────────────────────

  /** Lazy-create and return the MonitorWindow singleton. */
  getOrCreateMonitor(): MonitorWindow {
    if (!this.monitorWindow) {
      this.monitorWindow = new MonitorWindow();
    }
    return this.monitorWindow;
  }
}
