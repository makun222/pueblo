import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { createRuntimeCoordinator } from '../../app/runtime';
import type { McpClientManager } from '../../mcp/mcp-client';
import { loadAppConfig } from '../../shared/config';
import type { IpcInputEnvelope } from '../../shared/schema';
import { ATTACHMENT_FILE_DIALOG_FILTERS, ingestInputFiles } from './attachment-ingestion';
import { ChannelService } from '../../channel/channel-service';
import { createChannelRegistry } from '../../channel/channel-registry-factory';
import { createFeishuChannelAdapter } from '../../channel/channels/feishu/feishu-adapter';
import type { ChannelConfig } from '../../channel/channel-types';
import { loadChannelsConfig } from '../../channel/channel-config';
import { registerChannelIpcHandlers } from '../../channel/channel-ipc';
import { channelLogger } from '../../utils/logger.js';
import { DesktopTalkService } from './talk-service';
import { DesktopAgentTabManager } from './desktop-tab-manager';
import type { AppWindow } from './app-window';
import type { DesktopLoopJobManager } from './loop-job-manager';
import type {
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopTabAgentSessionRequest,
  DesktopTabAgentSessionsRequest,
  DesktopTabEntityRequest,
  DesktopTabInputFilesRequest,
  DesktopTabSubmitRequest,
  DesktopToolApprovalResponse,
  DesktopFileReviewResponse,
  DesktopSaveGenericProviderConfigurationInput,
} from '../shared/ipc-contract';
import {
  deleteInstantNote,
  readInstantNotes,
  resolveInstantNotesStoragePath,
  saveInstantNote,
  type InstantNoteDraft,
  type InstantNoteRecord,
} from '../shared/instant-notes';

const OUTPUT_CHANNEL = 'output';
const TAB_OUTPUT_CHANNEL = 'desktop-tab-output';
const TAB_TOOL_APPROVAL_STATE_CHANNEL = 'desktop-tab-tool-approval-state';
const TALK_STATE_CHANNEL = 'talk-state';
const TABS_CHANGED_CHANNEL = 'desktop-tabs-changed';

const DESKTOP_IPC_CHANNELS = [
  'desktop-tabs:list',
  'desktop-tabs:create',
  'desktop-tabs:update',
  'desktop-tabs:close',
  'get-runtime-status',
  'get-tool-approval-state',
  'get-talk-state',
  'provider-config:list',
  'provider-config:save-generic',
  'provider-config:remove-generic',
  'respond-tool-approval',
  'respond-file-review',
  'respond-talk-request',
  'respond-talk-continuation',
  'list-agent-profiles',
  'start-agent-session',
  'list-agent-sessions',
  'get-session',
  'list-session-memories',
  'select-session',
  'notes:list',
  'notes:save',
  'notes:update',
  'notes:delete',
  'notes:queue-next-turn',
  'notes:queue-subagent',
  'notes:queue-new-agent',
  'select-input-files',
  'submit-input',
  'cancel-active-submit',
] as const;

export interface DesktopIpcSetupOptions {
  readonly initialWorkspace?: string | null;
}

export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  loopJobManager?: DesktopLoopJobManager,
  appWindow?: AppWindow,
  mcpClientManager?: McpClientManager,
  options: DesktopIpcSetupOptions = {},
): () => void {
  const config = loadAppConfig();
  const instantNotesStoragePath = resolveInstantNotesStoragePath(app.getPath('userData'));
  const queuedNextTurnNotes: InstantNoteRecord[] = [];
  let currentDefaultTabId: string | null = null;
  let talkTabId: string | null = null;
  let cleanedUp = false;

  const emitOutput = (tabId: string, block: unknown): void => {
    if (cleanedUp || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(OUTPUT_CHANNEL, block);
    mainWindow.webContents.send(TAB_OUTPUT_CHANNEL, { tabId, block });
  };

  const manager = new DesktopAgentTabManager({
    config,
    initialWorkspace: options.initialWorkspace ?? null,
    loopJobManager,
    appWindow,
    mcpClientManager,
    reloadConfig: loadAppConfig,
    onOutput: emitOutput,
    onToolApprovalState: (tabId, state) => {
      if (mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send(TAB_TOOL_APPROVAL_STATE_CHANNEL, { tabId, state });
    },
    onTabsChanged: (tabs) => {
      currentDefaultTabId = tabs[0]?.id ?? null;
      if (!talkTabId || !tabs.some((tab) => tab.id === talkTabId)) {
        talkTabId = currentDefaultTabId;
      }
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(TABS_CHANGED_CHANNEL, tabs);
      }
    },
  });

  if (loopJobManager) {
    loopJobManager.setCallModel((modelId, prompt) => manager.callModel(modelId, prompt));
  }

  void manager.ready().catch((error) => {
    emitOutput(currentDefaultTabId ?? 'desktop-tab-1', {
      id: `desktop-init-error-${Date.now()}`,
      type: 'error',
      title: 'Desktop Startup Error',
      content: error instanceof Error ? error.message : String(error),
      sourceRefs: [],
      createdAt: new Date().toISOString(),
      collapsed: false,
      fileChanges: [],
      messageTrace: [],
    });
  });

  const channelRuntime = createRuntimeCoordinator({
    config,
    submitInput: async (input, signal) => {
      const response = await manager.submitInput(currentDefaultTabId, input);
      void signal;
      return response.result;
    },
  });
  const channelRegistry = createChannelRegistry();
  const channelService = new ChannelService({
    runtime: channelRuntime,
    registry: channelRegistry,
    createSession: async (channelId, message) => {
      const runtimeStatus = await manager.getRuntimeStatus(currentDefaultTabId);
      return runtimeStatus.activeSessionId ?? `${channelId}-${message.externalMessageId ?? Date.now()}`;
    },
  });
  const disposeChannelIpc = registerChannelIpcHandlers(mainWindow, {
    channelService,
    testChannel: async (channelConfig: ChannelConfig) => {
      try {
        const adapter = createFeishuChannelAdapter(channelConfig);
        const result = await adapter.testConnection(channelConfig);
        adapter.dispose();
        return { ok: result.ok, error: result.error };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  loadChannelsConfig()
    .then((channelConfig) => channelService.start(channelConfig.channels))
    .catch((err) => channelLogger.error('[Channel] startup failed:', err));

  const talkService = new DesktopTalkService({
    getRuntimeStatus: async () => manager.getRuntimeStatus(talkTabId ?? currentDefaultTabId),
    executeInput: async (envelope) => manager.submitInput(talkTabId ?? currentDefaultTabId, envelope),
    publishOutput: (block) => {
      const targetTabId = talkTabId ?? currentDefaultTabId ?? 'desktop-tab-1';
      emitOutput(targetTabId, block);
    },
  });
  const disposeTalkStateListener = talkService.onStateChange((state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TALK_STATE_CHANNEL, state);
    }
  });

  const flushQueuedNextTurnNotes = async (): Promise<void> => {
    while (queuedNextTurnNotes.length > 0) {
      const nextNote = queuedNextTurnNotes.shift();
      if (!nextNote) {
        return;
      }

      const runtimeStatus = await manager.getRuntimeStatus(currentDefaultTabId);
      const session = nextNote.sessionId
        ? await manager.getSession(currentDefaultTabId, nextNote.sessionId)
        : (runtimeStatus.activeSessionId ? await manager.getSession(currentDefaultTabId, runtimeStatus.activeSessionId) : null);
      const envelope: IpcInputEnvelope = {
        requestId: `instant-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        windowId: String(mainWindow.id),
        sessionId: nextNote.sessionId ?? runtimeStatus.activeSessionId ?? null,
        inputText: nextNote.content,
        attachments: [],
        submittedAt: new Date().toISOString(),
      };

      if (session && session.messageHistory.length > 0) {
        const latestTurnIds = Array.from(new Set(
          session.messageHistory
            .map((message) => message.turnId)
            .filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0),
        )).slice(-20);
        if (latestTurnIds.length > 0) {
          envelope.requestId = `instant-note-${latestTurnIds[latestTurnIds.length - 1]}-${Math.random().toString(36).slice(2, 8)}`;
        }
      }

      await manager.submitInput(currentDefaultTabId, envelope);
    }
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    disposeTalkStateListener();
    void talkService.dispose();
    disposeChannelIpc();
    channelService.dispose();
    channelRuntime.dispose();
    manager.dispose();
    removeDesktopIpcHandlers();
  };

  removeDesktopIpcHandlers();

  ipcMain.handle('desktop-tabs:list', async () => manager.listTabs());
  ipcMain.handle('desktop-tabs:create', async (_event, input) => manager.createTab(input ?? {}));
  ipcMain.handle('desktop-tabs:update', async (_event, input) => manager.updateTab(input));
  ipcMain.handle('desktop-tabs:close', async (_event, tabId: string) => manager.closeTab(tabId));

  ipcMain.handle('get-runtime-status', async (_event, tabId?: string | null) => manager.getRuntimeStatus(normalizeOptionalTabId(tabId)));
  ipcMain.handle('get-tool-approval-state', async (_event, tabId?: string | null) => manager.getToolApprovalState(normalizeOptionalTabId(tabId)));
  ipcMain.handle('get-talk-state', async () => talkService.getState() satisfies DesktopTalkState);

  ipcMain.handle('provider-config:list', async () => manager.listProviderConfigurations());
  ipcMain.handle('provider-config:save-generic', async (_event, input: DesktopSaveGenericProviderConfigurationInput) => {
    return manager.saveGenericProviderConfiguration(input);
  });
  ipcMain.handle('provider-config:remove-generic', async (_event, providerId: string) => {
    return manager.removeGenericProviderConfiguration(providerId);
  });

  ipcMain.handle('respond-tool-approval', async (_event, response: DesktopToolApprovalResponse) => manager.respondToolApproval(response));
  ipcMain.handle('respond-file-review', async (_event, response: DesktopFileReviewResponse) => manager.respondFileReview(response));

  ipcMain.handle('respond-talk-request', async (_event, response: DesktopTalkRequestResponse) => {
    talkTabId = normalizeOptionalTabId(response.tabId) ?? talkTabId ?? currentDefaultTabId;
    return talkService.respondToIncomingRequest(response);
  });
  ipcMain.handle('respond-talk-continuation', async (_event, response: DesktopTalkContinuationResponse) => {
    talkTabId = normalizeOptionalTabId(response.tabId) ?? talkTabId ?? currentDefaultTabId;
    return talkService.respondToContinuation(response);
  });

  ipcMain.handle('list-agent-profiles', async () => manager.listAgentProfiles());
  ipcMain.handle('start-agent-session', async (_event, input: string | DesktopTabAgentSessionRequest) => {
    const request = normalizeAgentSessionRequest(input);
    return manager.startAgentSession(request.tabId, request.profileId);
  });
  ipcMain.handle('list-agent-sessions', async (_event, input: string | DesktopTabAgentSessionsRequest) => {
    const request = normalizeAgentSessionsRequest(input);
    return manager.listAgentSessions(request.tabId, request.agentInstanceId);
  });
  ipcMain.handle('get-session', async (_event, input: string | DesktopTabEntityRequest) => {
    const request = normalizeTabEntityRequest(input);
    return manager.getSession(request.tabId, request.sessionId);
  });
  ipcMain.handle('list-session-memories', async (_event, input: string | DesktopTabEntityRequest) => {
    const request = normalizeTabEntityRequest(input);
    return manager.listSessionMemories(request.tabId, request.sessionId);
  });
  ipcMain.handle('select-session', async (_event, input: string | DesktopTabEntityRequest) => {
    const request = normalizeTabEntityRequest(input);
    return manager.selectSession(request.tabId, request.sessionId);
  });

  ipcMain.handle('notes:list', async () => readInstantNotes(instantNotesStoragePath));
  ipcMain.handle('notes:save', async (_event, draft: InstantNoteDraft) => {
    const runtimeStatus = await manager.getRuntimeStatus(currentDefaultTabId);
    const session = runtimeStatus.activeSessionId
      ? await manager.getSession(currentDefaultTabId, runtimeStatus.activeSessionId)
      : null;
    return saveInstantNote(instantNotesStoragePath, draft, runtimeStatus, session);
  });
  ipcMain.handle('notes:update', async (_event, payload: { id: string; content: string }) => {
    const runtimeStatus = await manager.getRuntimeStatus(currentDefaultTabId);
    const session = runtimeStatus.activeSessionId
      ? await manager.getSession(currentDefaultTabId, runtimeStatus.activeSessionId)
      : null;
    return saveInstantNote(instantNotesStoragePath, { ...payload, id: payload.id }, runtimeStatus, session);
  });
  ipcMain.handle('notes:delete', async (_event, noteId: string) => {
    await deleteInstantNote(instantNotesStoragePath, noteId);
  });
  ipcMain.handle('notes:queue-next-turn', async (_event, note: InstantNoteRecord) => {
    queuedNextTurnNotes.push(note);
    await flushQueuedNextTurnNotes();
    return { queued: true, message: '已加入下一轮对话队列' };
  });
  ipcMain.handle('notes:queue-subagent', async () => ({
    queued: false,
    message: '子 agent 入口已预留，暂未实现。',
  }));
  ipcMain.handle('notes:queue-new-agent', async () => ({
    queued: false,
    message: '新 agent 入口已预留，暂未实现。',
  }));

  ipcMain.handle('select-input-files', async (_event, input: string | null | DesktopTabInputFilesRequest) => {
    const request = normalizeInputFilesRequest(input);
    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: ATTACHMENT_FILE_DIALOG_FILTERS,
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return [];
    }

    return ingestInputFiles({
      filePaths: selection.filePaths,
      workspaceRoot: await manager.selectInputFilesWorkspace(request.tabId),
      sessionId: request.sessionId,
    });
  });

  ipcMain.handle('submit-input', async (_event, input: IpcInputEnvelope | DesktopTabSubmitRequest) => {
    const request = normalizeSubmitRequest(input);
    const trimmedInput = request.envelope.inputText.trim();
    if (trimmedInput.startsWith('/talkto')) {
      talkTabId = request.tabId ?? talkTabId ?? currentDefaultTabId;
      const talkResult = await talkService.handleTalkCommand(trimmedInput);
      if (!talkResult) {
        return manager.submitInput(request.tabId, request.envelope);
      }
      return {
        result: talkResult,
        blocks: [],
        runtimeStatus: await manager.getRuntimeStatus(request.tabId),
        tabId: request.tabId ?? currentDefaultTabId ?? undefined,
      };
    }

    if (!talkService.canAcceptUserInput()) {
      const result = talkService.createLockedResult();
      return {
        result,
        blocks: [],
        runtimeStatus: await manager.getRuntimeStatus(request.tabId),
        tabId: request.tabId ?? currentDefaultTabId ?? undefined,
      };
    }

    return manager.submitInput(request.tabId, request.envelope);
  });

  ipcMain.handle('cancel-active-submit', async (_event, tabId?: string | null) => {
    await manager.cancelActiveSubmit(normalizeOptionalTabId(tabId));
  });

  mainWindow.once('closed', cleanup);
  return cleanup;
}

function removeDesktopIpcHandlers(): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

function normalizeOptionalTabId(tabId?: string | null): string | null {
  if (typeof tabId !== 'string') {
    return null;
  }
  const trimmed = tabId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentSessionRequest(input: string | DesktopTabAgentSessionRequest): DesktopTabAgentSessionRequest {
  return typeof input === 'string'
    ? { profileId: input, tabId: null }
    : input;
}

function normalizeAgentSessionsRequest(input: string | DesktopTabAgentSessionsRequest): DesktopTabAgentSessionsRequest {
  return typeof input === 'string'
    ? { agentInstanceId: input, tabId: null }
    : input;
}

function normalizeTabEntityRequest(input: string | DesktopTabEntityRequest): DesktopTabEntityRequest {
  return typeof input === 'string'
    ? { sessionId: input, tabId: null }
    : input;
}

function normalizeInputFilesRequest(input: string | null | DesktopTabInputFilesRequest): DesktopTabInputFilesRequest {
  return typeof input === 'object' && input !== null
    ? input
    : { sessionId: input, tabId: null };
}

function normalizeSubmitRequest(input: IpcInputEnvelope | DesktopTabSubmitRequest): DesktopTabSubmitRequest {
  return typeof input === 'object' && input !== null && 'envelope' in input
    ? input
    : { envelope: input, tabId: null };
}
