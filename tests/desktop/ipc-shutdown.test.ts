import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskCancellationError } from '../../src/shared/task-cancellation';

const {
  cliMock,
  ipcMainMock,
  loadAppConfigMock,
  routeInputMock,
  runtimeFactoryMock,
  mainWindow,
} = vi.hoisted(() => {
  let runtimeListeners = new Set<(message: { block: { type: string; title: string; content: string; sourceRefs?: unknown[] } }) => void>();

  const cli = {
    submitInput: vi.fn(),
    getRuntimeStatus: vi.fn(() => ({
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
      modelMessageCharCount: 0,
      selectedPromptCount: 0,
      selectedMemoryCount: 0,
      backgroundSummaryStatus: {
        state: 'idle',
        activeSummarySessionId: null,
        lastSummaryAt: null,
        lastSummaryMemoryId: null,
      },
    })),
    listAgentProfiles: vi.fn(() => []),
    startAgentSession: vi.fn(),
    listAgentSessions: vi.fn(() => []),
    listSessionMemories: vi.fn(() => []),
    selectSession: vi.fn(() => ({ runtimeStatus: null, session: null })),
    setProgressReporter: vi.fn(),
    setToolApprovalHandler: vi.fn(),
    setToolApprovalBatchHandler: vi.fn(),
    setFileReviewHandler: vi.fn(),
    databaseClose: vi.fn(),
  };

  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  };

  const runtimeFactory = vi.fn(() => ({
    onMessage: vi.fn((listener: (message: { block: { type: string; title: string; content: string } }) => void) => {
      runtimeListeners.add(listener);
      return () => {
        runtimeListeners.delete(listener);
      };
    }),
    publish: vi.fn((message: { block: { type: string; title: string; content: string } }) => {
      for (const listener of runtimeListeners) {
        listener(message);
      }
    }),
    submitInput: vi.fn(),
    dispose: vi.fn(() => {
      runtimeListeners.clear();
    }),
  }));

  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
    once: vi.fn(),
  };

  return {
    cliMock: cli,
    ipcMainMock: ipcMain,
    loadAppConfigMock: vi.fn(() => ({ databasePath: 'memory', desktopWindow: { enabled: true } })),
    routeInputMock: vi.fn(),
    runtimeFactoryMock: runtimeFactory,
    mainWindow: window,
  };
});

vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: vi.fn(),
}));

vi.mock('../../src/cli/index', () => ({
  createCliDependencies: vi.fn(() => cliMock),
}));

vi.mock('../../src/shared/config', () => ({
  loadAppConfig: loadAppConfigMock,
}));

vi.mock('../../src/commands/input-router', () => ({
  routeInput: routeInputMock,
}));

vi.mock('../../src/shared/result', async () => {
  const actual = await vi.importActual<typeof import('../../src/shared/result')>('../../src/shared/result');
  return {
    ...actual,
    createResultBlocks: vi.fn(() => []),
  };
});

vi.mock('../../src/app/runtime', () => ({
  createRuntimeCoordinator: runtimeFactoryMock,
}));

import { setupIpcHandlers } from '../../src/desktop/main/ipc';

describe('Desktop IPC shutdown', () => {
  beforeEach(() => {
    ipcMainMock.handle.mockReset();
    ipcMainMock.removeHandler.mockReset();
    cliMock.submitInput.mockReset();
    cliMock.getRuntimeStatus.mockClear();
    cliMock.listAgentProfiles.mockClear();
    cliMock.startAgentSession.mockReset();
    cliMock.listAgentSessions.mockReset();
    cliMock.listSessionMemories.mockReset();
    cliMock.selectSession.mockReset();
    cliMock.setProgressReporter.mockReset();
    cliMock.setToolApprovalHandler.mockReset();
    cliMock.setToolApprovalBatchHandler.mockReset();
    cliMock.setFileReviewHandler.mockReset();
    cliMock.databaseClose.mockReset();
    routeInputMock.mockReset();
    runtimeFactoryMock.mockClear();
    mainWindow.isDestroyed.mockReturnValue(false);
    mainWindow.webContents.send.mockReset();
    mainWindow.once.mockReset();
  });

  it('cleans up CLI resources and detaches runtime publishing when the window closes', () => {
    const cleanup = setupIpcHandlers(mainWindow as never);
    const runtime = runtimeFactoryMock.mock.results[0]?.value as {
      publish: (message: { block: { type: string; title: string; content: string } }) => void;
      dispose: ReturnType<typeof vi.fn>;
    };
    const progressReporter = cliMock.setProgressReporter.mock.calls[0]?.[0] as ((update: { title: string; message: string }) => void) | null;
    const closeHandler = mainWindow.once.mock.calls.find((call) => call[0] === 'closed')?.[1] as (() => void) | undefined;

    expect(progressReporter).toBeTypeOf('function');
    progressReporter?.({ title: 'Before close', message: 'still publishing' });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('output', expect.objectContaining({ title: 'Before close' }));

    closeHandler?.();

    expect(cliMock.setProgressReporter).toHaveBeenLastCalledWith(null);
    expect(cliMock.setToolApprovalBatchHandler).toHaveBeenLastCalledWith(null);
    expect(cliMock.setToolApprovalHandler).toHaveBeenLastCalledWith(null);
    expect(cliMock.setFileReviewHandler).toHaveBeenLastCalledWith(null);
    expect(cliMock.databaseClose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);

    progressReporter?.({ title: 'After close', message: 'should be ignored' });
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('output', expect.objectContaining({ title: 'After close' }));

    cleanup();
    expect(cliMock.databaseClose).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight submit-input work during cleanup', async () => {
    routeInputMock.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? createTaskCancellationError('Task cancelled because the desktop window closed.'));
        return;
      }

      signal?.addEventListener('abort', () => {
        reject(signal.reason ?? createTaskCancellationError('Task cancelled because the desktop window closed.'));
      }, { once: true });
    }));

    const cleanup = setupIpcHandlers(mainWindow as never);
    const submitHandler = ipcMainMock.handle.mock.calls.find((call) => call[0] === 'submit-input')?.[1] as
      | ((event: unknown, input: {
        requestId: string;
        windowId: string;
        sessionId: string | null;
        inputText: string;
        submittedAt: string;
        attachments?: [];
      }) => Promise<unknown>)
      | undefined;

    expect(submitHandler).toBeTypeOf('function');

    const pendingSubmit = submitHandler?.({}, {
      requestId: 'req-1',
      windowId: 'desktop-window',
      sessionId: null,
      inputText: 'Long running task',
      attachments: [],
      submittedAt: new Date().toISOString(),
    });
    cleanup();

    await expect(pendingSubmit).rejects.toThrow('Task cancelled because the desktop window closed.');
  });
});
