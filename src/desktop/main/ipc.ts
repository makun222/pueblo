import path from 'node:path';
import { dialog, ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import type { ToolApprovalDecision, ToolApprovalRequest, RunAgentTaskInput } from '../../agent/task-runner';
import type { RunRoundFn } from '../../agent/loop-runner';
import { createCliDependencies } from '../../cli/index';
import { tokenizeCommandInput } from '../../commands/dispatcher';
import { routeInput } from '../../commands/input-router';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createPhasedResultBlocks, createResultBlocks } from '../../shared/result';
import { ipcInputEnvelopeSchema, type IpcInputEnvelope } from '../../shared/schema';
import { createTaskCancellationError, isTaskCancellationError } from '../../shared/task-cancellation';
import type { EditReviewRequest } from '../../tools/edit-tool';
import { ATTACHMENT_FILE_DIALOG_FILTERS, ingestInputFiles } from './attachment-ingestion';
import { DesktopTalkService } from './talk-service';
import type {
  DesktopFileReviewRequest,
  DesktopFileReviewResponse,
  DesktopRuntimeStatus,
  DesktopTalkContinuationResponse,
  DesktopTalkRequestResponse,
  DesktopTalkState,
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import { perfEnd, perfStart } from '../../utils/perf-logger';
import type { DesktopLoopJobManager, CallModelFn } from './loop-job-manager.js';
import { AppWindow } from './app-window.js';
import type { LoopConfig } from '../../agent/loop-runner.js';

const TOOL_APPROVAL_STATE_CHANNEL = 'tool-approval-state';
const TALK_STATE_CHANNEL = 'talk-state';
const DESKTOP_IPC_CHANNELS = [
  'get-runtime-status',
  'get-tool-approval-state',
  'get-talk-state',
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

export function setupIpcHandlers(mainWindow: BrowserWindow, loopJobManager: DesktopLoopJobManager, appWindow?: AppWindow): () => void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true });

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

  const executeInput = async (
    envelope: IpcInputEnvelope,
    signal?: AbortSignal,
  ): Promise<{
    readonly result: ReturnType<typeof createResultBlocks> extends never ? never : Awaited<ReturnType<typeof routeInput>>;
    readonly blocks: ReturnType<typeof createResultBlocks>;
    readonly runtimeStatus: DesktopRuntimeStatus;
  }> => {
    const _execT0 = perfStart('ipc.executeInput');
    const result = await routeInput({ input: envelope, runtime, signal });
    const { primaryBlock, supplementalBlocks } = createPhasedResultBlocks(result);
    const blocks = primaryBlock ? [primaryBlock, ...supplementalBlocks] : supplementalBlocks;

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
    perfEnd('ipc.executeInput', _execT0);
    return {
      result,
      blocks: primaryBlock ? [primaryBlock] : [],
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
          const output = task.outputSummary ?? '';
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
  const t0 = perfStart('resolveRuntimeStatus');
  const runtimeStatus = await cli.getRuntimeStatus();
  perfEnd('resolveRuntimeStatus', t0);
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
