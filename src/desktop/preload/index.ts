import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopFileReviewResponse,
  DesktopMenuAction,
  DesktopRuntimeStatus,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import type { AgentProfileTemplate, AgentSessionSummary, InputAttachmentManifest, IpcInputEnvelope, MemoryRecord, Session } from '../../shared/schema';

const MENU_ACTION_CHANNEL = 'desktop-menu-action';
const TOOL_APPROVAL_CHANNEL = 'tool-approval-state';
const TALK_STATE_CHANNEL = 'talk-state';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  submitInput: (envelope: IpcInputEnvelope): Promise<DesktopSubmitResponse> => ipcRenderer.invoke('submit-input', envelope),
  cancelActiveSubmit: (): Promise<void> => ipcRenderer.invoke('cancel-active-submit'),
  selectInputFiles: (sessionId: string | null): Promise<InputAttachmentManifest[]> => ipcRenderer.invoke('select-input-files', sessionId),
  getRuntimeStatus: (): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('get-runtime-status'),
  getToolApprovalState: (): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('get-tool-approval-state'),
  getTalkState: (): Promise<DesktopTalkState> => ipcRenderer.invoke('get-talk-state'),
  respondToolApproval: (response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('respond-tool-approval', response),
  respondFileReview: (response: DesktopFileReviewResponse): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('respond-file-review', response),
  respondTalkRequest: (response: DesktopTalkRequestResponse): Promise<DesktopTalkState> => ipcRenderer.invoke('respond-talk-request', response),
  respondTalkContinuation: (response: DesktopTalkContinuationResponse): Promise<DesktopTalkState> => ipcRenderer.invoke('respond-talk-continuation', response),
  listAgentProfiles: (): Promise<AgentProfileTemplate[]> => ipcRenderer.invoke('list-agent-profiles'),
  startAgentSession: (profileId: string): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('start-agent-session', profileId),
  listAgentSessions: (agentInstanceId: string): Promise<AgentSessionSummary[]> => ipcRenderer.invoke('list-agent-sessions', agentInstanceId),
  getSession: (sessionId: string): Promise<Session | null> => ipcRenderer.invoke('get-session', sessionId),
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
  onTalkState: (callback: (state: DesktopTalkState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopTalkState): void => {
      callback(state);
    };
    ipcRenderer.on(TALK_STATE_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TALK_STATE_CHANNEL, listener);
    };
  },
  onOutput: (callback: (event: any, data: any) => void) => ipcRenderer.on('output', callback),
  removeAllListeners: (event: string) => ipcRenderer.removeAllListeners(event),
});