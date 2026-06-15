import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script for the Loop Monitor window.
 * Exposes a minimal `monitorAPI` on the renderer's `window` object
 * so the monitor renderer can receive loop progress events from the main process.
 */
contextBridge.exposeInMainWorld('monitorAPI', {
  /**
   * Listen for loop job progress updates pushed from main.
   * Returns an unsubscribe function.
   */
  onJobProgress: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('loop:job-progress', handler);
    return () => {
      ipcRenderer.removeListener('loop:job-progress', handler);
    };
  },

  /**
   * Listen for loop job completion.
   */
  onJobComplete: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('loop:job-complete', handler);
    return () => {
      ipcRenderer.removeListener('loop:job-complete', handler);
    };
  },

  /**
   * Listen for loop job errors.
   */
  onJobError: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('loop:job-error', handler);
    return () => {
      ipcRenderer.removeListener('loop:job-error', handler);
    };
  },

  /** Request the list of active loop jobs from main. */
  getActiveJobs: (): Promise<unknown> => {
    return ipcRenderer.invoke('loop:list-active');
  },
});
