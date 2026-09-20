import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for the channel `createSession` fallback in
// src/desktop/main/ipc.ts. The previous implementation synthesized a fake id
// (`<channelId>-<messageId>`) that was never persisted, so later approval /
// pending lookups by session silently missed it. These tests lock the two
// current branches:
//   (a) an active session exists -> reuse it, do NOT create a new session;
//   (b) no active session -> create a real one and return its persisted id.
const { captured, cliMock, ipcMainMock, loadAppConfigMock, mainWindow, runtimeFactoryMock, talkServiceMock } =
  vi.hoisted(() => {
    type CreateSession = (channelId: string, message: { text?: string }) => Promise<string>;

    const runtimeStatus = {
      providerId: null,
      providerName: null,
      agentProfileId: null,
      agentProfileName: null,
      agentInstanceId: null,
      modelId: null,
      modelName: null,
      workspace: null,
      activeSessionId: null,
      contextCount: {
        estimatedTokens: 0,
        contextWindowLimit: null,
        utilizationRatio: null,
        messageCount: 0,
        selectedPromptCount: 0,
        selectedMemoryCount: 0,
        derivedMemoryCount: 0,
      },
      modelMessageCount: 0,
      pendingToolApproval: null,
      pendingFileReview: null,
    };

    const cli = {
      submitInput: vi.fn(),
      getRuntimeStatus: vi.fn(() => runtimeStatus),
      listAgentProfiles: vi.fn(async () => []),
      listAgentInstances: vi.fn(async () => []),
      startAgentSession: vi.fn(async () => runtimeStatus),
      listAgentSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => null),
      listSessionMemories: vi.fn(async () => []),
      selectSession: vi.fn(async () => runtimeStatus),
      setProgressReporter: vi.fn(),
      setToolApprovalHandler: vi.fn(),
      setToolApprovalBatchHandler: vi.fn(),
      setFileReviewHandler: vi.fn(),
      databaseClose: vi.fn(async () => {}),
    };

    const ipcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    };

    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn(),
    };

    const runtimeFactory = vi.fn(() => ({
      onMessage: vi.fn(() => () => {}),
      publish: vi.fn(),
      submitInput: vi.fn(),
      dispose: vi.fn(),
    }));

    const talkService = vi.fn().mockImplementation(() => ({
      onStateChange: vi.fn(() => () => {}),
      dispose: vi.fn(),
      getState: vi.fn(() => ({ localPid: process.pid, incomingRequest: null, activeConversation: null })),
      handleTalkCommand: vi.fn(async () => null),
      canAcceptUserInput: vi.fn(() => true),
      createLockedResult: vi.fn(() => ({ ok: false, code: 'LOCKED', message: 'locked', suggestions: [] })),
      respondToIncomingRequest: vi.fn(),
      respondToContinuation: vi.fn(),
    }));

    const capturedCreateSession: { fn: CreateSession | null } = { fn: null };

    return {
      captured: capturedCreateSession,
      cliMock: cli,
      ipcMainMock: ipcMain,
      loadAppConfigMock: vi.fn(() => ({
        databasePath: 'memory',
        desktopWindow: { enabled: true },
        defaultAgentProfileId: 'code-master',
      })),
      mainWindow: window,
      runtimeFactoryMock: runtimeFactory,
      talkServiceMock: talkService,
    };
  });

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'd:\\workspace\\pueblo\\pueblo\\.pueblo') },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: ipcMainMock,
  BrowserWindow: vi.fn(),
}));

vi.mock('../../src/cli/index', () => ({
  createCliDependencies: vi.fn(() => cliMock),
}));

vi.mock('../../src/shared/config', () => ({
  loadAppConfig: loadAppConfigMock,
}));

vi.mock('../../src/app/runtime', () => ({
  createRuntimeCoordinator: runtimeFactoryMock,
}));

vi.mock('../../src/channel/channel-service', () => ({
  ChannelService: vi.fn().mockImplementation((deps: { createSession: (channelId: string, message: { text?: string }) => Promise<string> }) => {
    captured.fn = deps.createSession;
    return {
      dispose: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../../src/channel/channel-registry-factory', () => ({
  createChannelRegistry: vi.fn(() => ({})),
}));

vi.mock('../../src/channel/channel-config', () => ({
  loadChannelsConfig: vi.fn().mockResolvedValue({ channels: [] }),
  listChannelBindingsBySession: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/channel/channel-ipc', () => ({
  registerChannelIpcHandlers: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/channel/channels/feishu/feishu-adapter', () => ({
  createFeishuChannelAdapter: vi.fn(() => ({
    testConnection: vi.fn().mockResolvedValue({ ok: true, error: undefined }),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../src/desktop/main/talk-service', () => ({
  DesktopTalkService: talkServiceMock,
}));

import { setupIpcHandlers } from '../../src/desktop/main/ipc';
import { DesktopAgentTabManager } from '../../src/desktop/main/desktop-tab-manager';

describe('Desktop IPC channel createSession fallback', () => {
  let getActiveSessionIdSpy: ReturnType<typeof vi.spyOn>;
  let createChannelSessionSpy: ReturnType<typeof vi.spyOn>;
  let cleanup: () => void;

  beforeEach(() => {
    ipcMainMock.handle.mockReset();
    ipcMainMock.removeHandler.mockReset();
    runtimeFactoryMock.mockClear();
    talkServiceMock.mockClear();
    mainWindow.isDestroyed.mockReturnValue(false);
    mainWindow.webContents.send.mockReset();
    mainWindow.once.mockReset();
    captured.fn = null;

    getActiveSessionIdSpy = vi
      .spyOn(DesktopAgentTabManager.prototype, 'getCachedActiveSessionId')
      .mockReturnValue(null);
    createChannelSessionSpy = vi
      .spyOn(DesktopAgentTabManager.prototype, 'createChannelSession')
      .mockResolvedValue({ id: 'placeholder-id' } as never);
  });

  afterEach(() => {
    cleanup?.();
    // Only restore the prototype spies; a blanket `vi.restoreAllMocks()` would
    // also wipe the module-level `vi.fn().mockResolvedValue(...)` mocks.
    getActiveSessionIdSpy.mockRestore();
    createChannelSessionSpy.mockRestore();
  });

  const setup = (): ((channelId: string, message: { text?: string }) => Promise<string>) => {
    cleanup = setupIpcHandlers(mainWindow as never);
    const createSession = captured.fn;
    expect(createSession).toBeTypeOf('function');
    return createSession as (channelId: string, message: { text?: string }) => Promise<string>;
  };

  it('reuses the cached active session and does not create a new one', async () => {
    getActiveSessionIdSpy.mockReturnValue('session-active-1');
    const createSession = setup();

    await expect(createSession('feishu-channel-1', { text: 'hello there' })).resolves.toBe('session-active-1');
    expect(createChannelSessionSpy).not.toHaveBeenCalled();
  });

  it('creates a real session when none is active and returns its persisted id (not a synthesized one)', async () => {
    getActiveSessionIdSpy.mockReturnValue(null);
    createChannelSessionSpy.mockResolvedValue({ id: 'sess-real-uuid-0001' } as never);
    const createSession = setup();

    const sessionId = await createSession('feishu-channel-1', { text: 'hello there' });

    expect(createChannelSessionSpy).toHaveBeenCalledTimes(1);
    expect(sessionId).toBe('sess-real-uuid-0001');
    // The old fallback produced `${channelId}-${externalMessageId ?? Date.now()}`.
    expect(sessionId).not.toMatch(/^feishu-channel-1-/);
  });
});
