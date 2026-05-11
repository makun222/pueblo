import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopMenuAction,
  DesktopRuntimeStatus,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import type { AgentProfileTemplate, MemoryRecord, Session } from '../../shared/schema';

const MENU_ACTION_CHANNEL = 'desktop-menu-action';
const TOOL_APPROVAL_CHANNEL = 'tool-approval-state';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  submitInput: (input: string): Promise<DesktopSubmitResponse> => ipcRenderer.invoke('submit-input', input),
  getRuntimeStatus: (): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('get-runtime-status'),
  getToolApprovalState: (): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('get-tool-approval-state'),
  respondToolApproval: (response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('respond-tool-approval', response),
  listAgentProfiles: (): Promise<AgentProfileTemplate[]> => ipcRenderer.invoke('list-agent-profiles'),
  startAgentSession: (profileId: string): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('start-agent-session', profileId),
  listAgentSessions: (agentInstanceId: string): Promise<Session[]> => ipcRenderer.invoke('list-agent-sessions', agentInstanceId),
  listSessionMemories: (sessionId: string): Promise<MemoryRecord[]> => ipcRenderer.invoke('list-session-memories', sessionId),
  selectSession: (sessionId: string): Promise<DesktopSessionSelectionResponse> => ipcRenderer.invoke('select-session', sessionId),
  onMenuAction: (callback: (action: DesktopMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: DesktopMenuAction): void => {
      callback(action);
    };
    ipcRenderer.on(MENU_ACTION_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, listener);
    };
  },
  onToolApprovalState: (callback: (state: DesktopToolApprovalState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopToolApprovalState): void => {
      callback(state);
    };
    ipcRenderer.on(TOOL_APPROVAL_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TOOL_APPROVAL_CHANNEL, listener);
    };
  },
  onOutput: (callback: (event: any, data: any) => void) => ipcRenderer.on('output', callback),
  removeAllListeners: (event: string) => ipcRenderer.removeAllListeners(event),
});