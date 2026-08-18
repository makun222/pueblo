import path from 'node:path';
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import type { ToolApprovalDecision, ToolApprovalRequest, RunAgentTaskInput } from '../../agent/task-runner';
import type { RunRoundFn } from '../../agent/loop-runner';
import { createCliDependencies } from '../../cli/index';
import type { McpClientManager } from '../../mcp/mcp-client';
import { tokenizeCommandInput } from '../../commands/dispatcher';
import { routeInput } from '../../commands/input-router';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createPhasedResultBlocks, createResultBlocks, extractTaskOutputSummaryText } from '../../shared/result';
import { ipcInputEnvelopeSchema, type IpcInputEnvelope } from '../../shared/schema';
import { createTaskCancellationError, isTaskCancellationError } from '../../shared/task-cancellation';
import type { EditReviewRequest } from '../../tools/edit-tool';
import { ATTACHMENT_FILE_DIALOG_FILTERS, ingestInputFiles } from './attachment-ingestion';
import { DesktopTalkService } from './talk-service';
import type {
  DesktopFileReviewRequest,
  DesktopFileReviewResponse,
  DesktopGenericProviderConfiguration,
  DesktopProviderConfigurationList,
  DesktopRuntimeStatus,
  DesktopSaveGenericProviderConfigurationInput,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import { perfEnd, perfLog, perfStart } from '../../utils/perf-logger';
import { channelLogger } from '../../utils/logger.js';
import type { DesktopLoopJobManager, CallModelFn } from './loop-job-manager.js';
import { AppWindow } from './app-window.js';
import type { LoopConfig } from '../../agent/loop-runner.js';
import { ChannelService } from '../../channel/channel-service';
import { createChannelRegistry } from '../../channel/channel-registry-factory';
import { createFeishuChannelAdapter } from '../../channel/channels/feishu/feishu-adapter';
import type { ChannelConfig } from '../../channel/channel-types';
import { loadChannelsConfig } from '../../channel/channel-config';
import { registerChannelIpcHandlers } from '../../channel/channel-ipc';
import {
  deleteInstantNote,
  readInstantNotes,
  resolveInstantNotesStoragePath,
  saveInstantNote,
  type InstantNoteDraft,
  type InstantNoteRecord,
} from '../shared/instant-notes';

const TOOL_APPROVAL_STATE_CHANNEL = 'tool-approval-state';
const TALK_STATE_CHANNEL = 'talk-state';
const DESKTOP_IPC_CHANNELS = [
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
] as const;

interface PendingToolApprovalBatch {
  readonly batch: DesktopToolApprovalBatch;
  readonly resolve: (decisions: readonly ToolApprovalDecision[]) => void;
  readonly reject: (error: Error) => void;
}

interface PendingFileReview {
  readonly request: DesktopFileReviewRequest;
  readonly resolve: (decision: 'keep' | 'discard') => void;
  readonly reject: (error: Error) => void;
}

interface CliProviderConfigurationEntry {
  readonly providerId?: unknown;
  readonly id?: unknown;
  readonly providerType?: unknown;
  readonly type?: unknown;
  readonly displayName?: unknown;
  readonly name?: unknown;
  readonly baseUrl?: unknown;
  readonly modelIds?: unknown;
  readonly models?: unknown;
  readonly defaultModelId?: unknown;
  readonly enabled?: unknown;
  readonly isDefault?: unknown;
  readonly default?: unknown;
  readonly hasApiKey?: unknown;
  readonly apiKeyConfigured?: unknown;
  readonly apiKey?: unknown;
}

interface CliProviderConfigurationApi {
  readonly listProviderConfigurations: () => Promise<readonly unknown[]> | readonly unknown[];
  readonly saveGenericProviderConfiguration: (
    input: DesktopSaveGenericProviderConfigurationInput,
  ) => Promise<unknown> | unknown;
  readonly removeGenericProviderConfiguration: (providerId: string) => Promise<void> | void;
}

export function setupIpcHandlers(mainWindow: BrowserWindow, loopJobManager: DesktopLoopJobManager, appWindow?: AppWindow, mcpClientManager?: McpClientManager): () => void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true, mcpClientManager });
  const instantNotesStoragePath = resolveInstantNotesStoragePath(app.getPath('userData'));
  const queuedNextTurnNotes: InstantNoteRecord[] = [];

  // Wire callModel for pre-flight goal validation
  const callModel: CallModelFn = async (modelId: string, prompt: string) => {
    const taskRunner = cli.getTaskRunner();
    const taskInput: RunAgentTaskInput = {
      goal: prompt,
      sessionId: null,
      providerId: 'deepseek',
      modelId,
      inputContextSummary: 'pre-flight goal validation',
    };
    const result = await taskRunner.run(taskInput);
    return result.outputSummary ?? '';
  };
  loopJobManager.setCallModel(callModel);
  let activeToolApprovalBatch: PendingToolApprovalBatch | null = null;
  let activeFileReview: PendingFileReview | null = null;
  const activeSubmitControllers = new Set<AbortController>();
  let cleanedUp = false;

  const publishToolApprovalState = (state: DesktopToolApprovalState = resolveToolApprovalState(activeToolApprovalBatch, activeFileReview)) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TOOL_APPROVAL_STATE_CHANNEL, state);
    }
  };

  let talkService: DesktopTalkService | null = null;

  const publishTalkState = (state: DesktopTalkState) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TALK_STATE_CHANNEL, state);
    }
  };

  cli.setToolApprovalBatchHandler(async (requests) => new Promise<readonly ToolApprovalDecision[]>((resolve, reject) => {
    if (activeToolApprovalBatch) {
      reject(new Error('A tool approval batch is already pending in the sidebar.'));
      return;
    }

    const batch = createToolApprovalBatch(requests);
    activeToolApprovalBatch = {
      batch,
      resolve: (decisions) => {
        activeToolApprovalBatch = null;
        publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
        resolve(decisions);
      },
      reject: (error) => {
        activeToolApprovalBatch = null;
        publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
        reject(error);
      },
    };

    publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
  }));

  cli.setToolApprovalHandler(null);
  cli.setFileReviewHandler(async (request) => new Promise<'keep' | 'discard'>((resolve, reject) => {
    if (activeFileReview) {
      reject(new Error('A file review is already pending in the sidebar.'));
      return;
    }

    const pendingReview: PendingFileReview = {
      request: mapFileReviewRequest(request),
      resolve: (decision) => {
        activeFileReview = null;
        publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
        resolve(decision);
      },
      reject: (error) => {
        activeFileReview = null;
        publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
        reject(error);
      },
    };

    activeFileReview = pendingReview;
    publishToolApprovalState(resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));
  }));

  const runtime = createRuntimeCoordinator({
    config,
    submitInput: cli.submitInput,
  });

  const flushQueuedNextTurnNotes = async (): Promise<void> => {
    while (queuedNextTurnNotes.length > 0 && activeSubmitControllers.size === 0) {
      const nextNote = queuedNextTurnNotes.shift();
      if (!nextNote) {
        break;
      }

      const status = await resolveRuntimeStatus(cli);
      const session = nextNote.sessionId ? cli.getSession(nextNote.sessionId) : (status.activeSessionId ? cli.getSession(status.activeSessionId) : null);
      const envelope: IpcInputEnvelope = {
        requestId: `instant-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        windowId: String(mainWindow.id),
        sessionId: nextNote.sessionId ?? status.activeSessionId ?? null,
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

      await executeInput(envelope);
    }
  };

  // ── External channel integration (feishu long-connection, etc.) ──
  const channelRegistry = createChannelRegistry();
  const channelService = new ChannelService({
    runtime,
    registry: channelRegistry,
    createSession: cli.createSessionForChannel,
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
  // Start any configured, enabled channels (best-effort; failures are logged)
  loadChannelsConfig()
    .then((channelConfig) => channelService.start(channelConfig.channels))
    .catch((err) => channelLogger.error('[Channel] startup failed:', err));

  const executeInput = async (
    envelope: IpcInputEnvelope,
    signal?: AbortSignal,
  ): Promise<{
    readonly result: ReturnType<typeof createResultBlocks> extends never ? never : Awaited<ReturnType<typeof routeInput>>;
    readonly blocks: ReturnType<typeof createResultBlocks>;
    readonly runtimeStatus: DesktopRuntimeStatus;
  }> => {
    //const _execT0 = perfStart('ipc.executeInput');
    const result = await routeInput({ input: envelope, runtime, signal });
    const blocks = createResultBlocks(result);
    const primaryBlock = blocks[0];
    const supplementalBlocks = blocks.slice(1);

    if (primaryBlock) {
      runtime.publish({ block: primaryBlock });
    }

    if (supplementalBlocks.length > 0) {
      setImmediate(() => {
        for (const block of supplementalBlocks) {
          runtime.publish({ block });
        }
      });
    }

    const runtimeStatus = await resolveRuntimeStatus(cli);
    //perfEnd('ipc.executeInput', _execT0);
    return {
      result,
      blocks,
      runtimeStatus,
    };
  };

  talkService = new DesktopTalkService({
    getRuntimeStatus: () => resolveRuntimeStatus(cli),
    executeInput: (envelope) => executeInput(envelope),
    publishOutput: (block) => {
      runtime.publish({ block });
    },
  });
  const disposeTalkStateListener = talkService.onStateChange((state) => {
    publishTalkState(state);
  });

  cli.setProgressReporter((update) => {
    runtime.publish({
      block: createOutputBlock({
        type: 'system',
        title: update.title,
        content: update.message,
        sourceRefs: [],
      }),
    });
  });

  const disposeRuntimeListener = runtime.onMessage((message: RuntimeMessage) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('output', message.block);
    }
  });

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    for (const controller of activeSubmitControllers) {
      controller.abort(createTaskCancellationError('Task cancelled because the desktop window closed.'));
    }
    activeSubmitControllers.clear();

    if (activeToolApprovalBatch) {
      const pendingBatch = activeToolApprovalBatch;
      activeToolApprovalBatch = null;
      pendingBatch.reject(createTaskCancellationError('Tool approval was cancelled because the desktop window closed.'));
    }

    if (activeFileReview) {
      const pendingReview = activeFileReview;
      activeFileReview = null;
      pendingReview.reject(createTaskCancellationError('File review was cancelled because the desktop window closed.'));
    }

    cli.setProgressReporter(null);
    cli.setToolApprovalBatchHandler(null);
    cli.setToolApprovalHandler(null);
    cli.setFileReviewHandler(null);
    disposeTalkStateListener();
    void talkService?.dispose();
    talkService = null;
    disposeChannelIpc();
    channelService.dispose();
    disposeRuntimeListener();
    runtime.dispose();
    removeDesktopIpcHandlers();
    cli.databaseClose();
  };

  removeDesktopIpcHandlers();
  ipcMain.handle('get-runtime-status', async () => resolveRuntimeStatus(cli));

  ipcMain.handle('get-tool-approval-state', async () => resolveToolApprovalState(activeToolApprovalBatch, activeFileReview));

  ipcMain.handle('get-talk-state', async () => talkService?.getState() ?? {
    localPid: process.pid,
    incomingRequest: null,
    activeConversation: null,
  } satisfies DesktopTalkState);

  ipcMain.handle('provider-config:list', async () => {
    const providerApi = resolveProviderConfigurationApi(cli);
    try {
      const entries = await providerApi.listProviderConfigurations();
      return {
        genericOpenAIProviders: sanitizeGenericProviderConfigurations(entries),
      } satisfies DesktopProviderConfigurationList;
    } catch (error) {
      throw new Error(`Failed to list provider configurations: ${toErrorMessage(error)}`);
    }
  });

  ipcMain.handle('provider-config:save-generic', async (_event, input: DesktopSaveGenericProviderConfigurationInput) => {
    const providerApi = resolveProviderConfigurationApi(cli);
    const normalizedInput = normalizeGenericProviderInput(input);

    try {
      await providerApi.saveGenericProviderConfiguration(normalizedInput);
      const entries = await providerApi.listProviderConfigurations();
      const savedProvider = sanitizeGenericProviderConfigurations(entries)
        .find((provider) => provider.id === normalizedInput.id);

      if (!savedProvider) {
        throw new Error(`Provider "${normalizedInput.id}" was saved but could not be loaded afterwards.`);
      }

      return savedProvider;
    } catch (error) {
      throw new Error(`Failed to save generic provider "${normalizedInput.id}": ${toErrorMessage(error)}`);
    }
  });

  ipcMain.handle('provider-config:remove-generic', async (_event, providerId: string) => {
    const providerApi = resolveProviderConfigurationApi(cli);
    const normalizedProviderId = providerId.trim();

    if (!normalizedProviderId) {
      throw new Error('Provider id is required.');
    }

    try {
      await providerApi.removeGenericProviderConfiguration(normalizedProviderId);
    } catch (error) {
      throw new Error(`Failed to remove generic provider "${normalizedProviderId}": ${toErrorMessage(error)}`);
    }
  });

  ipcMain.handle('respond-tool-approval', async (_event, response: DesktopToolApprovalResponse) => {
    if (!activeToolApprovalBatch?.batch) {
      throw new Error('No tool approval batch is pending.');
    }

    const batch = activeToolApprovalBatch.batch;

    if (response.batchId !== batch.id) {
      throw new Error('Tool approval batch is stale.');
    }

    const decisions = response.decision === 'deny'
      ? batch.requests.map(() => 'deny' as const)
      : buildApprovalDecisions(batch, response.selectedRequestIds, response.decision);

    activeToolApprovalBatch.resolve(decisions);
    return resolveToolApprovalState(activeToolApprovalBatch, activeFileReview);
  });

  ipcMain.handle('respond-file-review', async (_event, response: DesktopFileReviewResponse) => {
    if (!activeFileReview) {
      throw new Error('No file review is pending.');
    }

    if (response.reviewId !== activeFileReview.request.id) {
      throw new Error('File review request is stale.');
    }

    activeFileReview.resolve(response.decision);
    return resolveToolApprovalState(activeToolApprovalBatch, activeFileReview);
  });

  ipcMain.handle('respond-talk-request', async (_event, response: DesktopTalkRequestResponse) => {
    if (!talkService) {
      throw new Error('Talk service is unavailable.');
    }

    return talkService.respondToIncomingRequest(response);
  });

  ipcMain.handle('respond-talk-continuation', async (_event, response: DesktopTalkContinuationResponse) => {
    if (!talkService) {
      throw new Error('Talk service is unavailable.');
    }

    return talkService.respondToContinuation(response);
  });

  ipcMain.handle('list-agent-profiles', async () => cli.listAgentProfiles());

  ipcMain.handle('start-agent-session', async (_event, profileId: string) => cli.startAgentSession(profileId));

  ipcMain.handle('list-agent-sessions', async (_event, agentInstanceId: string) => cli.listAgentSessions(agentInstanceId));

  ipcMain.handle('get-session', async (_event, sessionId: string) => cli.getSession(sessionId));

  ipcMain.handle('list-session-memories', async (_event, sessionId: string) => cli.listSessionMemories(sessionId));

  ipcMain.handle('select-session', async (_event, sessionId: string) => cli.selectSession(sessionId));

  ipcMain.handle('notes:list', async () => readInstantNotes(instantNotesStoragePath));

  ipcMain.handle('notes:save', async (_event, draft: InstantNoteDraft) => {
    const runtimeStatus = await resolveRuntimeStatus(cli);
    const session = runtimeStatus.activeSessionId ? cli.getSession(runtimeStatus.activeSessionId) : null;
    return saveInstantNote(instantNotesStoragePath, draft, runtimeStatus, session);
  });

  ipcMain.handle('notes:update', async (_event, payload: { id: string; content: string }) => {
    const runtimeStatus = await resolveRuntimeStatus(cli);
    const session = runtimeStatus.activeSessionId ? cli.getSession(runtimeStatus.activeSessionId) : null;
    return saveInstantNote(instantNotesStoragePath, { ...payload, id: payload.id }, runtimeStatus, session);
  });

  ipcMain.handle('notes:delete', async (_event, noteId: string) => {
    await deleteInstantNote(instantNotesStoragePath, noteId);
  });

  ipcMain.handle('notes:queue-next-turn', async (_event, note: InstantNoteRecord) => {
    queuedNextTurnNotes.push(note);
    if (activeSubmitControllers.size === 0) {
      await flushQueuedNextTurnNotes();
    }
    return { queued: true, message: '已加入下一轮对话队列' };
  });

  ipcMain.handle('notes:queue-subagent', async (_event, _note: InstantNoteRecord) => ({
    queued: false,
    message: '子 agent 入口已预留，暂未实现。',
  }));

  ipcMain.handle('notes:queue-new-agent', async (_event, _note: InstantNoteRecord) => ({
    queued: false,
    message: '新 agent 入口已预留，暂未实现。',
  }));

  ipcMain.handle('select-input-files', async (_event, sessionId: string | null) => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: ATTACHMENT_FILE_DIALOG_FILTERS,
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return [];
    }

    const runtimeStatus = await cli.getRuntimeStatus();
    return ingestInputFiles({
      filePaths: selection.filePaths,
      workspaceRoot: runtimeStatus.workspace ?? process.cwd(),
      sessionId,
    });
  });

  ipcMain.handle('submit-input', async (_event, inputEnvelope: IpcInputEnvelope) => {
    const submitController = new AbortController();
    activeSubmitControllers.add(submitController);

    try {
      const envelope = ipcInputEnvelopeSchema.parse({
        ...inputEnvelope,
        attachments: inputEnvelope.attachments ?? [],
      });
      const talkCommandResult = await talkService?.handleTalkCommand(envelope.inputText.trim());
      if (talkCommandResult) {
        const blocks = createResultBlocks(talkCommandResult);
        perfLog('DEBUG-ipc-createResultBlocks', 0,
          JSON.stringify({
            resultActions: talkCommandResult.actions,
            blocksCount: blocks.length,
            blockActions: blocks.map(b => ({ id: b.id, actionsCount: b.actions?.length ?? 0, actions: b.actions })),
          }));
        for (const block of blocks) {
          runtime.publish({ block });
        }

        return {
          result: talkCommandResult,
          blocks,
          runtimeStatus: await resolveRuntimeStatus(cli),
        };
      }

      // --- /loop command ---
      if (envelope.inputText.trim().startsWith('/loop')) {
        const workspaceRoot = (await resolveRuntimeStatus(cli)).workspace ?? process.cwd();
        const inputText = envelope.inputText.trim();

        // Parse --max-rounds from input, default to 5
        const maxRoundsMatch = inputText.match(/--max-rounds[=](\d+)/);
        const maxRounds = maxRoundsMatch ? parseInt(maxRoundsMatch[1], 10) : 5;
        const goal = inputText.replace(/--max-rounds[=]\d+/, '').slice('/loop'.length).trim() || 'loop execution';

        const config: LoopConfig = {
          goal,
          maxRounds,
          judge: 'llm',
        };

        // Resolve context once before the loop (not inside each round)
        const resolved = await cli.getContextResolver().resolve({
          workspace: workspaceRoot,
          cwd: workspaceRoot,
        });

        const runRound: RunRoundFn = async (config, prevResult, signal) => {
          const taskInput: RunAgentTaskInput = {
            goal: prevResult ? `${prevResult.output}\n\n${config.goal}` : config.goal,
            sessionId: null,
            providerId: resolved.taskContext.providerId ?? 'deepseek',
            modelId: resolved.taskContext.selectedModelId ?? 'deepseek-v4-pro',
            inputContextSummary: config.accumulatedContext?.length > 0 ? config.accumulatedContext : '...',
            taskContext: resolved.taskContext,
            prompts: resolved.taskContext.prompts,
            signal,
          };
          const taskRunner = cli.getTaskRunner();
          const task = await taskRunner.run(taskInput);
          const output = extractTaskOutputSummaryText(task.outputSummary) ?? '';
          return { output, tokenUsage: 0 };
        };
        loopJobManager.setRunRound(runRound);

        const jobId = `job-${Date.now()}`;
        if (appWindow) {
          const monitorWindow = appWindow.getOrCreateMonitor();
          monitorWindow.create();
        }
        const onProgress = appWindow ? appWindow.createLoopProgressSender(jobId) : undefined;
        const resolvedCtx = await cli.getContextResolver().resolve({
          workspace: workspaceRoot,
          cwd: workspaceRoot,
        });
        const modelId = resolvedCtx.taskContext.selectedModelId;
        await loopJobManager.startJob(config, onProgress, jobId, modelId ?? undefined);
        return {
          result: { id: jobId, type: 'loop', kind: 'loop-job-started', sessionId: envelope.sessionId },
          blocks: [],
          runtimeStatus: await resolveRuntimeStatus(cli),
        };
      }

      if (talkService && !talkService.canAcceptUserInput()) {
        const result = talkService.createLockedResult();
        const blocks = createResultBlocks(result);
        for (const block of blocks) {
          runtime.publish({ block });
        }

        return {
          result,
          blocks,
          runtimeStatus: await resolveRuntimeStatus(cli),
        };
      }

      const { result, blocks, runtimeStatus } = await executeInput(envelope, submitController.signal);

      return {
        result,
        blocks,
        runtimeStatus,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        throw error;
      }

      const errorBlock = createOutputBlock({
        type: 'error',
        title: 'Input Processing Error',
        content: error instanceof Error ? error.message : 'Unknown error',
        sourceRefs: [],
      });
      runtime.publish({ block: errorBlock });

      throw error;
    } finally {
      activeSubmitControllers.delete(submitController);
      if (activeSubmitControllers.size === 0) {
        await flushQueuedNextTurnNotes();
      }
    }
  });

  ipcMain.handle('cancel-active-submit', async () => {
    for (const controller of activeSubmitControllers) {
      controller.abort(createTaskCancellationError('Task cancelled by user.'));
    }
    activeSubmitControllers.clear();
  });

  ipcMain.handle('loop:start', async (_event, config) => {
    return loopJobManager.startJob(config);
  });

  ipcMain.handle('loop:cancel', async (_event, jobId: string) => {
    return loopJobManager.cancelJob(jobId);
  });

  ipcMain.handle('loop:pause', async (_event, jobId: string) => {
    return loopJobManager.pauseJob(jobId);
  });

  ipcMain.handle('loop:resume', async (_event, jobId: string) => {
    return loopJobManager.resumeJob(jobId);
  });

  mainWindow.once('closed', cleanup);

  return cleanup;
}

function removeDesktopIpcHandlers(): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

async function resolveRuntimeStatus(
  cli: ReturnType<typeof createCliDependencies>,
): Promise<DesktopRuntimeStatus> {
  //const t0 = perfStart('resolveRuntimeStatus');
  const runtimeStatus = await cli.getRuntimeStatus();
  //perfEnd('resolveRuntimeStatus', t0);
  return {
    ...runtimeStatus,
    desktopProcessId: process.pid,
  };
}

function resolveToolApprovalState(
  activeToolApprovalBatch: PendingToolApprovalBatch | null,
  activeFileReview: PendingFileReview | null,
): DesktopToolApprovalState {
  return {
    activeBatch: activeToolApprovalBatch?.batch ?? null,
    activeFileReview: activeFileReview?.request ?? null,
  };
}

function resolveProviderConfigurationApi(
  cli: ReturnType<typeof createCliDependencies>,
): CliProviderConfigurationApi {
  const providerApi = cli as Partial<CliProviderConfigurationApi>;
  if (
    typeof providerApi.listProviderConfigurations !== 'function'
    || typeof providerApi.saveGenericProviderConfiguration !== 'function'
    || typeof providerApi.removeGenericProviderConfiguration !== 'function'
  ) {
    throw new Error(
      'Provider configuration API is unavailable. Required CLI signatures: '
      + 'listProviderConfigurations(): Promise<readonly unknown[]>; '
      + 'saveGenericProviderConfiguration(input: DesktopSaveGenericProviderConfigurationInput): Promise<unknown>; '
      + 'removeGenericProviderConfiguration(providerId: string): Promise<void>.',
    );
  }

  return providerApi as CliProviderConfigurationApi;
}

function sanitizeGenericProviderConfigurations(entries: readonly unknown[]): DesktopGenericProviderConfiguration[] {
  if (!Array.isArray(entries)) {
    throw new Error('Provider configuration response must be an array.');
  }

  const configurations: DesktopGenericProviderConfiguration[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const value = entry as CliProviderConfigurationEntry;
    const providerId = sanitizeNonEmptyString(value.providerId) ?? sanitizeNonEmptyString(value.id);
    if (!providerId || providerId === 'github-copilot' || providerId === 'deepseek') {
      continue;
    }

    const providerType = sanitizeNonEmptyString(value.providerType) ?? sanitizeNonEmptyString(value.type);
    const baseUrl = sanitizeNonEmptyString(value.baseUrl);
    const isLikelyGenericProvider = (providerType
      ? providerType.toLowerCase().includes('openai') || providerType.toLowerCase().includes('generic')
      : false) || Boolean(baseUrl);

    if (!isLikelyGenericProvider) {
      continue;
    }

    const modelIds = normalizeModelIds(value.modelIds ?? value.models);
    const defaultModelId = sanitizeNonEmptyString(value.defaultModelId) ?? modelIds[0] ?? null;
    const isDefault = toBoolean(value.isDefault, toBoolean(value.default, false));
    const apiKeyConfigured = toBoolean(
      value.apiKeyConfigured,
      toBoolean(value.hasApiKey, sanitizeNonEmptyString(value.apiKey) !== null),
    );

    configurations.push({
      id: providerId,
      displayName: sanitizeNonEmptyString(value.displayName) ?? sanitizeNonEmptyString(value.name) ?? providerId,
      baseUrl: baseUrl ?? 'https://api.openai.com/v1',
      modelIds,
      defaultModelId,
      enabled: toBoolean(value.enabled, true),
      isDefault,
      apiKeyConfigured,
    });
  }

  return configurations.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function normalizeGenericProviderInput(input: DesktopSaveGenericProviderConfigurationInput): DesktopSaveGenericProviderConfigurationInput {
  const id = input.id.trim();
  const displayName = input.displayName.trim();
  const baseUrl = input.baseUrl.trim();
  const modelIds = Array.from(new Set(input.modelIds.map((modelId) => modelId.trim()).filter((modelId) => modelId.length > 0)));
  const defaultModelId = input.defaultModelId.trim();
  const apiKey = input.apiKey?.trim() ?? null;

  if (!id) {
    throw new Error('Provider id is required.');
  }

  if (id === 'github-copilot' || id === 'deepseek') {
    throw new Error('Built-in provider ids are reserved.');
  }

  if (!displayName) {
    throw new Error('Display name is required.');
  }

  if (!baseUrl) {
    throw new Error('Base URL is required.');
  }

  if (modelIds.length === 0) {
    throw new Error('At least one model id is required.');
  }

  if (!defaultModelId) {
    throw new Error('Default model id is required.');
  }

  if (!modelIds.includes(defaultModelId)) {
    throw new Error('Default model id must match one of the configured model ids.');
  }

  return {
    id,
    displayName,
    baseUrl,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    modelIds,
    defaultModelId,
    enabled: input.enabled,
    setAsDefault: input.setAsDefault,
  };
}

function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = value
    .map((model) => {
      if (typeof model === 'string') {
        return model.trim();
      }

      if (model && typeof model === 'object') {
        const modelRecord = model as { id?: unknown; modelId?: unknown; name?: unknown };
        return sanitizeNonEmptyString(modelRecord.id)
          ?? sanitizeNonEmptyString(modelRecord.modelId)
          ?? sanitizeNonEmptyString(modelRecord.name)
          ?? '';
      }

      return '';
    })
    .filter((modelId) => modelId.length > 0);

  return Array.from(new Set(ids));
}

function sanitizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function createToolApprovalBatch(requests: readonly ToolApprovalRequest[]): DesktopToolApprovalBatch {
  const createdAt = new Date().toISOString();

  return {
    id: `${createdAt}-tool-approval-${Math.random().toString(16).slice(2)}`,
    taskId: requests[0]?.taskId ?? 'unknown-task',
    createdAt,
    requests: requests.map((request) => mapToolApprovalRequest(request)),
  };
}

function mapToolApprovalRequest(request: ToolApprovalRequest): DesktopToolApprovalRequest {
  if (request.toolName === 'edit') {
    const args = request.args as Extract<ToolApprovalRequest['args'], { path: string; oldText: string }>;
    const primaryText = normalizeApprovalTarget(args.path);
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      kind: 'file-edit',
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      primaryText,
      targetLabel: primaryText,
      operationLabel: args.oldText.length === 0 ? 'create' : 'edit',
    };
  }

  if (request.toolName === 'exec' || request.toolName === 'shell_exec') {
    const args = request.args as Extract<ToolApprovalRequest['args'], { command: string }> & { mode?: string };
    const primaryText = args.command.trim() || 'workspace command';
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      kind: 'command',
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      primaryText,
      targetLabel: normalizeApprovalTarget(args.command),
      operationLabel: request.toolName === 'shell_exec' ? args.mode ?? 'shell_exec' : 'exec',
    };
  }

  return {
    id: request.toolCallId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    kind: 'other',
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    primaryText: request.summary,
    targetLabel: request.toolName,
    operationLabel: request.toolName,
  };
}

function mapFileReviewRequest(request: EditReviewRequest): DesktopFileReviewRequest {
  return {
    id: request.id,
    toolCallId: request.toolCallId,
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    fileChange: request.fileChange,
    shadowPath: request.shadowPath,
  };
}

function normalizeApprovalTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'workspace';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);
  return baseName && baseName !== '.' && baseName !== '/' ? normalized : trimmed;
}

function buildApprovalDecisions(
  batch: DesktopToolApprovalBatch,
  selectedRequestIds: readonly string[],
  decision: 'allow' | 'allow-all' = 'allow',
): readonly ToolApprovalDecision[] {
  const selectedIds = new Set(selectedRequestIds);
  const allowDecision: ToolApprovalDecision = decision === 'allow-all' ? 'allow-all' : 'allow-once';
  return batch.requests.map((request) => (selectedIds.has(request.id) ? allowDecision : 'deny'));
}
