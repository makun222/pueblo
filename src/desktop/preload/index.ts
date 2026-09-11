import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopAgentTab,
  DesktopCloseTabResult,
  DesktopCreateTabInput,
  DesktopProviderConfigurationList,
  DesktopFileReviewResponse,
  DesktopMenuAction,
  DesktopSaveGenericProviderConfigurationInput,
  DesktopGenericProviderConfiguration,
  DesktopRuntimeStatus,
  DesktopSessionSelectionResponse,
  DesktopSubmitResponse,
  DesktopTabAgentSessionRequest,
  DesktopTabAgentSessionsRequest,
  DesktopTabEntityRequest,
  DesktopTabInputFilesRequest,
  DesktopTabOutputEvent,
  DesktopTabSubmitRequest,
  DesktopTabToolApprovalStateEvent,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
  DesktopUpdateTabInput,
} from '../shared/ipc-contract';
import type { InstantNoteDraft, InstantNoteRecord } from '../shared/instant-notes';
import type { AgentProfileTemplate, AgentSessionSummary, InputAttachmentManifest, IpcInputEnvelope, MemoryRecord, Session } from '../../shared/schema';
import type { McpConnectionState, McpServerConfig } from '../../mcp/mcp-types';

const MENU_ACTION_CHANNEL = 'desktop-menu-action';
const TOOL_APPROVAL_CHANNEL = 'tool-approval-state';
const TALK_STATE_CHANNEL = 'talk-state';
const TAB_OUTPUT_CHANNEL = 'desktop-tab-output';
const TAB_TOOL_APPROVAL_CHANNEL = 'desktop-tab-tool-approval-state';
const TABS_CHANGED_CHANNEL = 'desktop-tabs-changed';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  listDesktopTabs: (): Promise<DesktopAgentTab[]> => ipcRenderer.invoke('desktop-tabs:list'),
  createDesktopTab: (input?: DesktopCreateTabInput): Promise<DesktopAgentTab> => ipcRenderer.invoke('desktop-tabs:create', input ?? {}),
  updateDesktopTab: (input: DesktopUpdateTabInput): Promise<DesktopAgentTab> => ipcRenderer.invoke('desktop-tabs:update', input),
  closeDesktopTab: (tabId: string): Promise<DesktopCloseTabResult> => ipcRenderer.invoke('desktop-tabs:close', tabId),
  onDesktopTabsChanged: (callback: (tabs: DesktopAgentTab[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tabs: DesktopAgentTab[]): void => {
      callback(tabs);
    };
    ipcRenderer.on(TABS_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TABS_CHANGED_CHANNEL, listener);
    };
  },
  onTabOutput: (callback: (event: DesktopTabOutputEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DesktopTabOutputEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(TAB_OUTPUT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TAB_OUTPUT_CHANNEL, listener);
    };
  },
  onTabToolApprovalState: (callback: (event: DesktopTabToolApprovalStateEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DesktopTabToolApprovalStateEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(TAB_TOOL_APPROVAL_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TAB_TOOL_APPROVAL_CHANNEL, listener);
    };
  },
  focusMonitor: (): Promise<void> => ipcRenderer.invoke('loop:focus-monitor'),
  listProviderConfigurations: (): Promise<DesktopProviderConfigurationList> => ipcRenderer.invoke('provider-config:list'),
  saveGenericProviderConfiguration: (input: DesktopSaveGenericProviderConfigurationInput): Promise<DesktopGenericProviderConfiguration> =>
    ipcRenderer.invoke('provider-config:save-generic', input),
  removeGenericProviderConfiguration: (providerId: string): Promise<void> =>
    ipcRenderer.invoke('provider-config:remove-generic', providerId),
  submitInput: (input: IpcInputEnvelope | DesktopTabSubmitRequest): Promise<DesktopSubmitResponse> =>
    ipcRenderer.invoke('submit-input', isTabSubmitRequest(input) ? input : { envelope: input }),
  cancelActiveSubmit: (tabId?: string): Promise<void> => ipcRenderer.invoke('cancel-active-submit', tabId ?? null),
  selectInputFiles: (input: string | null | DesktopTabInputFilesRequest): Promise<InputAttachmentManifest[]> =>
    ipcRenderer.invoke('select-input-files', typeof input === 'object' && input !== null ? input : { sessionId: input, tabId: null }),
  getRuntimeStatus: (tabId?: string): Promise<DesktopRuntimeStatus> => ipcRenderer.invoke('get-runtime-status', tabId ?? null),
  getToolApprovalState: (tabId?: string): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('get-tool-approval-state', tabId ?? null),
  getTalkState: (): Promise<DesktopTalkState> => ipcRenderer.invoke('get-talk-state'),
  respondToolApproval: (response: DesktopToolApprovalResponse): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('respond-tool-approval', response),
  respondFileReview: (response: DesktopFileReviewResponse): Promise<DesktopToolApprovalState> => ipcRenderer.invoke('respond-file-review', response),
  respondTalkRequest: (response: DesktopTalkRequestResponse): Promise<DesktopTalkState> => ipcRenderer.invoke('respond-talk-request', response),
  respondTalkContinuation: (response: DesktopTalkContinuationResponse): Promise<DesktopTalkState> => ipcRenderer.invoke('respond-talk-continuation', response),
  listAgentProfiles: (): Promise<AgentProfileTemplate[]> => ipcRenderer.invoke('list-agent-profiles'),
  startAgentSession: (input: string | DesktopTabAgentSessionRequest): Promise<DesktopRuntimeStatus> =>
    ipcRenderer.invoke('start-agent-session', typeof input === 'string' ? { profileId: input, tabId: null } : input),
  listAgentSessions: (input: string | DesktopTabAgentSessionsRequest): Promise<AgentSessionSummary[]> =>
    ipcRenderer.invoke('list-agent-sessions', typeof input === 'string' ? { agentInstanceId: input, tabId: null } : input),
  getSession: (input: string | DesktopTabEntityRequest): Promise<Session | null> =>
    ipcRenderer.invoke('get-session', typeof input === 'string' ? { sessionId: input, tabId: null } : input),
  listSessionMemories: (input: string | DesktopTabEntityRequest): Promise<MemoryRecord[]> =>
    ipcRenderer.invoke('list-session-memories', typeof input === 'string' ? { sessionId: input, tabId: null } : input),
  selectSession: (input: string | DesktopTabEntityRequest): Promise<DesktopSessionSelectionResponse> =>
    ipcRenderer.invoke('select-session', typeof input === 'string' ? { sessionId: input, tabId: null } : input),
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
  notesList: (): Promise<InstantNoteRecord[]> => ipcRenderer.invoke('notes:list'),
  notesSave: (draft: InstantNoteDraft): Promise<InstantNoteRecord> => ipcRenderer.invoke('notes:save', draft),
  notesUpdate: (id: string, draft: InstantNoteDraft): Promise<InstantNoteRecord> => ipcRenderer.invoke('notes:update', { id, ...draft }),
  notesDelete: (noteId: string): Promise<void> => ipcRenderer.invoke('notes:delete', noteId),
  notesQueueNextTurn: (note: InstantNoteRecord): Promise<{ queued: boolean; message: string }> => ipcRenderer.invoke('notes:queue-next-turn', note),
  notesQueueSubagent: (note: InstantNoteRecord): Promise<{ queued: boolean; message: string }> => ipcRenderer.invoke('notes:queue-subagent', note),
  notesQueueNewAgent: (note: InstantNoteRecord): Promise<{ queued: boolean; message: string }> => ipcRenderer.invoke('notes:queue-new-agent', note),

  // ── MCP (Model Context Protocol) ─────────────
  mcpListServers: (): Promise<McpServerConfig[]> =>
    ipcRenderer.invoke('mcp:list-servers'),

  mcpAddServer: (config: McpServerConfig): Promise<McpServerConfig> =>
    ipcRenderer.invoke('mcp:add-server', config),

  mcpRemoveServer: (serverName: string): Promise<void> =>
    ipcRenderer.invoke('mcp:remove-server', serverName),

  mcpUpdateServer: (config: McpServerConfig): Promise<McpServerConfig> =>
    ipcRenderer.invoke('mcp:update-server', config),

  mcpRestartServer: (serverName: string): Promise<void> =>
    ipcRenderer.invoke('mcp:restart-server', serverName),

  mcpTestConnection: (config: McpServerConfig): Promise<{ success: boolean; toolCount: number; error?: string }> =>
    ipcRenderer.invoke('mcp:test-connection', config),

  mcpGetConnectionStates: (): Promise<McpConnectionState[]> =>
    ipcRenderer.invoke('mcp:get-connection-states'),

  mcpListCredentials: (): Promise<string[]> =>
    ipcRenderer.invoke('mcp:list-credentials'),

  mcpSaveCredential: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('mcp:save-credential', key, value),

  mcpDeleteCredential: (key: string): Promise<void> =>
    ipcRenderer.invoke('mcp:delete-credential', key),
});

function isTabSubmitRequest(value: IpcInputEnvelope | DesktopTabSubmitRequest): value is DesktopTabSubmitRequest {
  return typeof value === 'object' && value !== null && 'envelope' in value;
}