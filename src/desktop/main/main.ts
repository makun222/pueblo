import { app, BrowserWindow, ipcMain } from 'electron';
import { createOutputBlock } from '../../shared/result';
import type { DesktopRuntimeStatus } from '../shared/ipc-contract';
import { setupIpcHandlers } from './ipc';
import { AppWindow } from './app-window';
import type { LoopConfig } from '../../agent/loop-runner.js';
import { DesktopLoopJobManager } from './loop-job-manager';

let appWindow: AppWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let disposeDesktopRuntime: (() => void) | null = null;

function createMainWindow(): void {
  disposeDesktopRuntime?.();
  disposeDesktopRuntime = null;
  appWindow = new AppWindow();
  mainWindow = appWindow.browserWindow;
  appWindow.onClosed(() => {
    disposeDesktopRuntime?.();
    disposeDesktopRuntime = null;
    mainWindow = null;
  });

  try {
    // === Phase 2: Loop IPC registration ===
    // Phase 3.1: runRound will be wired to the actual LLM round execution
    const loopJobManager = new DesktopLoopJobManager();
    const monitorWindow = appWindow!.getOrCreateMonitor();

    disposeDesktopRuntime = setupIpcHandlers(mainWindow, loopJobManager, appWindow);

    ipcMain.removeHandler('loop:start');
    ipcMain.handle('loop:start', async (_event, params) => {
      const jobId = `job-${Date.now()}`;
      const config: LoopConfig = {
        goal: params.goal,
        maxRounds: params.totalRounds,
        judge: params.modelId,
      };
      const onProgress = appWindow!.createLoopProgressSender(jobId);
      await loopJobManager.startJob(config, onProgress, jobId, params.modelId);
      monitorWindow.create();
      return { jobId, status: 'accepted' as const };
    });

    ipcMain.removeHandler('loop:list-active');
    ipcMain.handle('loop:list-active', async () => {
      return loopJobManager.listJobs();
    });

    ipcMain.removeHandler('loop:focus-monitor');
    ipcMain.handle('loop:focus-monitor', async () => {
      monitorWindow.create();
      return { focused: true };
    });
  } catch (error) {
    publishDesktopStartupError(mainWindow, error);
  }
}

export function publishDesktopStartupError(window: BrowserWindow, error: unknown): void {
  const normalizedError = error instanceof Error ? error : new Error('Desktop services failed to initialize');
  const message = normalizedError.message;
  const errorBlock = createOutputBlock({
    type: 'error',
    title: 'Desktop Startup Error',
    content: `Desktop services failed to initialize.\n${message}`,
  });
  const sendErrorBlock = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('output', errorBlock);
    }
  };

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', sendErrorBlock);
  } else {
    sendErrorBlock();
  }

  const emptyRuntimeStatus: DesktopRuntimeStatus = {
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
      breakdown: {
        systemPromptTokens: 0,
        userInputTokens: 0,
        toolResultTokens: 0,
      },
    },
    modelMessageCount: 0,
    modelMessageCharCount: 0,
    providerUsageStats: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      promptTokensSent: 0,
      cacheHitRatio: null,
    },
    selectedPromptCount: 0,
    selectedMemoryCount: 0,
    availableProviders: [],
    backgroundSummaryStatus: {
      state: 'idle',
      activeSummarySessionId: null,
      lastSummaryAt: null,
      lastSummaryMemoryId: null,
    },
    workflow: {
      hasActiveWorkflow: false,
      workflowId: null,
      workflowType: null,
      status: null,
      activeRoundNumber: null,
    },
    providerStatuses: {
      githubCopilot: {
        providerId: 'github-copilot',
        authState: 'missing',
        credentialSource: 'env',
        defaultModelId: null,
        credentialTarget: null,
        oauthClientIdConfigured: false,
      },
      deepseek: {
        providerId: 'deepseek',
        authState: 'missing',
        credentialSource: 'env',
        defaultModelId: null,
        credentialTarget: null,
        baseUrl: 'https://api.deepseek.com',
      },
    },
  };

  const failWithStartupError = async (): Promise<never> => {
    sendErrorBlock();
    throw normalizedError;
  };

  ipcMain.removeHandler('get-runtime-status');
  ipcMain.handle('get-runtime-status', async () => emptyRuntimeStatus);

  ipcMain.removeHandler('get-tool-approval-state');
  ipcMain.handle('get-tool-approval-state', async () => ({ activeBatch: null, activeFileReview: null }));

  ipcMain.removeHandler('get-talk-state');
  ipcMain.handle('get-talk-state', async () => ({ localPid: process.pid, incomingRequest: null, activeConversation: null }));

  ipcMain.removeHandler('respond-tool-approval');
  ipcMain.handle('respond-tool-approval', async () => ({ activeBatch: null, activeFileReview: null }));

  ipcMain.removeHandler('respond-file-review');
  ipcMain.handle('respond-file-review', async () => ({ activeBatch: null, activeFileReview: null }));

  ipcMain.removeHandler('respond-talk-request');
  ipcMain.handle('respond-talk-request', failWithStartupError);

  ipcMain.removeHandler('respond-talk-continuation');
  ipcMain.handle('respond-talk-continuation', failWithStartupError);

  ipcMain.removeHandler('list-agent-profiles');
  ipcMain.handle('list-agent-profiles', async () => {
    sendErrorBlock();
    throw normalizedError;
  });

  ipcMain.removeHandler('start-agent-session');
  ipcMain.handle('start-agent-session', failWithStartupError);

  ipcMain.removeHandler('select-input-files');
  ipcMain.handle('select-input-files', failWithStartupError);

  ipcMain.removeHandler('submit-input');
  ipcMain.handle('submit-input', failWithStartupError);
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  disposeDesktopRuntime?.();
  disposeDesktopRuntime = null;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});