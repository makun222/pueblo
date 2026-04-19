import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopRuntimeStatus, DesktopSubmitResponse } from '../shared/ipc-contract';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  submitInput: (input: string): Promise<DesktopSubmitResponse> => ipcRenderer.invoke('submit-input', input),
  getRuntimeStatus: (): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('get-runtime-status'),
  onOutput: (callback: (event: any, data: any) => void) => ipcRenderer.on('output', callback),
  removeAllListeners: (event: string) => ipcRenderer.removeAllListeners(event),
});