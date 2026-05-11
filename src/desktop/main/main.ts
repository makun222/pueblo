import { app, BrowserWindow, ipcMain } from 'electron';
import { createOutputBlock } from '../../shared/result';
import type { DesktopRuntimeStatus } from '../shared/ipc-contract';
import { setupIpcHandlers } from './ipc';
import { installDesktopApplicationMenu } from './menu';
import { createWindow } from './window';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = createWindow();
  installDesktopApplicationMenu(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  try {
    setupIpcHandlers(mainWindow);
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
  ipcMain.handle('get-tool-approval-state', async () => ({ activeBatch: null }));

  ipcMain.removeHandler('respond-tool-approval');
  ipcMain.handle('respond-tool-approval', async () => ({ activeBatch: null }));

  ipcMain.removeHandler('list-agent-profiles');
  ipcMain.handle('list-agent-profiles', async () => {
    sendErrorBlock();
    throw normalizedError;
  });

  ipcMain.removeHandler('start-agent-session');
  ipcMain.handle('start-agent-session', failWithStartupError);

  ipcMain.removeHandler('submit-input');
  ipcMain.handle('submit-input', failWithStartupError);
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});