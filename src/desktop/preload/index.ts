import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopMenuAction, DesktopRuntimeStatus, DesktopSubmitResponse } from '../shared/ipc-contract';
import type { AgentProfileTemplate } from '../../shared/schema';

const MENU_ACTION_CHANNEL = 'desktop-menu-action';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  submitInput: (input: string): Promise<DesktopSubmitResponse> => ipcRenderer.invoke('submit-input', input),
  getRuntimeStatus: (): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('get-runtime-status'),
  listAgentProfiles: (): Promise<AgentProfileTemplate[]> => ipcRenderer.invoke('list-agent-profiles'),
  startAgentSession: (profileId: string): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('start-agent-session', profileId),
  onMenuAction: (callback: (action: DesktopMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: DesktopMenuAction): void => {
      callback(action);
    };
    ipcRenderer.on(MENU_ACTION_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, listener);
    };
  },
  onOutput: (callback: (event: any, data: any) => void) => ipcRenderer.on('output', callback),
  removeAllListeners: (event: string) => ipcRenderer.removeAllListeners(event),
});