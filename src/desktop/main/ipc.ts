import path from 'node:path';
import { dialog, ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../../agent/task-runner';
import { createCliDependencies } from '../../cli/index';
import { routeInput } from '../../commands/input-router';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createResultBlocks } from '../../shared/result';
import { ipcInputEnvelopeSchema, type IpcInputEnvelope } from '../../shared/schema';
import { createTaskCancellationError, isTaskCancellationError } from '../../shared/task-cancellation';
import { ATTACHMENT_FILE_DIALOG_FILTERS, ingestInputFiles } from './attachment-ingestion';
import type {
  DesktopRuntimeStatus,
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';

const TOOL_APPROVAL_STATE_CHANNEL = 'tool-approval-state';
const DESKTOP_IPC_CHANNELS = [
  'get-runtime-status',
  'get-tool-approval-state',
  'respond-tool-approval',
  'list-agent-profiles',
  'start-agent-session',
  'list-agent-sessions',
  'list-session-memories',
  'select-session',
  'select-input-files',
  'submit-input',
] as const;

interface PendingToolApprovalBatch {
  readonly state: DesktopToolApprovalState;
  readonly resolve: (decisions: readonly ToolApprovalDecision[]) => void;
  readonly reject: (error: Error) => void;
}

export function setupIpcHandlers(mainWindow: BrowserWindow): () => void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true });
  let activeToolApprovalBatch: PendingToolApprovalBatch | null = null;
  const activeSubmitControllers = new Set<AbortController>();
  let cleanedUp = false;

  const publishToolApprovalState = (state: DesktopToolApprovalState = resolveToolApprovalState(activeToolApprovalBatch)) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(TOOL_APPROVAL_STATE_CHANNEL, state);
    }
  };

  cli.setToolApprovalBatchHandler(async (requests) => new Promise<readonly ToolApprovalDecision[]>((resolve, reject) => {
    if (activeToolApprovalBatch) {
      reject(new Error('A tool approval batch is already pending in the sidebar.'));
      return;
    }

    const batch = createToolApprovalBatch(requests);
    activeToolApprovalBatch = {
      state: { activeBatch: batch },
      resolve: (decisions) => {
        activeToolApprovalBatch = null;
        publishToolApprovalState({ activeBatch: null });
        resolve(decisions);
      },
      reject: (error) => {
        activeToolApprovalBatch = null;
        publishToolApprovalState({ activeBatch: null });
        reject(error);
      },
    };

    publishToolApprovalState(activeToolApprovalBatch.state);
  }));

  cli.setToolApprovalHandler(null);

  const runtime = createRuntimeCoordinator({
    config,
    submitInput: cli.submitInput,
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

    cli.setProgressReporter(null);
    cli.setToolApprovalBatchHandler(null);
    cli.setToolApprovalHandler(null);
    disposeRuntimeListener();
    runtime.dispose();
    removeDesktopIpcHandlers();
    cli.databaseClose();
  };

  removeDesktopIpcHandlers();
  ipcMain.handle('get-runtime-status', async () => resolveRuntimeStatus(cli));

  ipcMain.handle('get-tool-approval-state', async () => resolveToolApprovalState(activeToolApprovalBatch));

  ipcMain.handle('respond-tool-approval', async (_event, response: DesktopToolApprovalResponse) => {
    if (!activeToolApprovalBatch?.state.activeBatch) {
      throw new Error('No tool approval batch is pending.');
    }

    const batch = activeToolApprovalBatch.state.activeBatch;

    if (response.batchId !== batch.id) {
      throw new Error('Tool approval batch is stale.');
    }

    const decisions = response.decision === 'deny'
      ? batch.requests.map(() => 'deny' as const)
      : buildApprovalDecisions(batch, response.selectedRequestIds);

    activeToolApprovalBatch.resolve(decisions);
    return { activeBatch: null } satisfies DesktopToolApprovalState;
  });

  ipcMain.handle('list-agent-profiles', async () => cli.listAgentProfiles());

  ipcMain.handle('start-agent-session', async (_event, profileId: string) => cli.startAgentSession(profileId));

  ipcMain.handle('list-agent-sessions', async (_event, agentInstanceId: string) => cli.listAgentSessions(agentInstanceId));

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

    return ingestInputFiles({
      filePaths: selection.filePaths,
      workspaceRoot: cli.getRuntimeStatus().workspace ?? process.cwd(),
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
      const result = await routeInput({ input: envelope, runtime, signal: submitController.signal });
      const blocks = createResultBlocks(result);

      for (const block of blocks) {
        runtime.publish({ block });
      }

      return {
        result,
        blocks,
        runtimeStatus: resolveRuntimeStatus(cli),
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

  mainWindow.once('closed', cleanup);

  return cleanup;
}

function removeDesktopIpcHandlers(): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

function resolveRuntimeStatus(
  cli: ReturnType<typeof createCliDependencies>,
): DesktopRuntimeStatus {
  return cli.getRuntimeStatus();
}

function resolveToolApprovalState(activeToolApprovalBatch: PendingToolApprovalBatch | null): DesktopToolApprovalState {
  return activeToolApprovalBatch?.state ?? { activeBatch: null };
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
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      targetLabel: normalizeApprovalTarget(args.path),
      operationLabel: args.oldText.length === 0 ? 'create' : 'edit',
    };
  }

  if (request.toolName === 'exec') {
    const args = request.args as Extract<ToolApprovalRequest['args'], { command: string }>;
    return {
      id: request.toolCallId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      title: request.title,
      summary: request.summary,
      detail: request.detail,
      targetLabel: normalizeApprovalTarget(args.command),
      operationLabel: 'exec',
    };
  }

  return {
    id: request.toolCallId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    targetLabel: request.toolName,
    operationLabel: request.toolName,
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
): readonly ToolApprovalDecision[] {
  const selectedIds = new Set(selectedRequestIds);
  return batch.requests.map((request) => (selectedIds.has(request.id) ? 'allow-once' : 'deny'));
}
