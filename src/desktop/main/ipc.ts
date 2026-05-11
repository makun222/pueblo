import path from 'node:path';
import { ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../../agent/task-runner';
import { createCliDependencies } from '../../cli/index';
import { routeInput } from '../../commands/input-router';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createResultBlocks } from '../../shared/result';
import type {
  DesktopRuntimeStatus,
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';

const TOOL_APPROVAL_STATE_CHANNEL = 'tool-approval-state';

interface PendingToolApprovalBatch {
  readonly state: DesktopToolApprovalState;
  readonly resolve: (decisions: readonly ToolApprovalDecision[]) => void;
  readonly reject: (error: Error) => void;
}

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true });
  let activeToolApprovalBatch: PendingToolApprovalBatch | null = null;

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

  runtime.onMessage((message: RuntimeMessage) => {
    mainWindow.webContents.send('output', message.block);
  });

  ipcMain.removeHandler('get-runtime-status');
  ipcMain.handle('get-runtime-status', async () => resolveRuntimeStatus(cli));

  ipcMain.removeHandler('get-tool-approval-state');
  ipcMain.handle('get-tool-approval-state', async () => resolveToolApprovalState(activeToolApprovalBatch));

  ipcMain.removeHandler('respond-tool-approval');
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

  ipcMain.removeHandler('list-agent-profiles');
  ipcMain.handle('list-agent-profiles', async () => cli.listAgentProfiles());

  ipcMain.removeHandler('start-agent-session');
  ipcMain.handle('start-agent-session', async (_event, profileId: string) => cli.startAgentSession(profileId));

  ipcMain.removeHandler('list-agent-sessions');
  ipcMain.handle('list-agent-sessions', async (_event, agentInstanceId: string) => cli.listAgentSessions(agentInstanceId));

  ipcMain.removeHandler('list-session-memories');
  ipcMain.handle('list-session-memories', async (_event, sessionId: string) => cli.listSessionMemories(sessionId));

  ipcMain.removeHandler('select-session');
  ipcMain.handle('select-session', async (_event, sessionId: string) => cli.selectSession(sessionId));

  ipcMain.removeHandler('submit-input');
  ipcMain.handle('submit-input', async (_event, input: string) => {
    try {
      const result = await routeInput({ input, runtime });
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
      const errorBlock = createOutputBlock({
        type: 'error',
        title: 'Input Processing Error',
        content: error instanceof Error ? error.message : 'Unknown error',
        sourceRefs: [],
      });
      runtime.publish({ block: errorBlock });

      throw error;
    }
  });

  mainWindow.on('closed', () => {
    if (activeToolApprovalBatch) {
      activeToolApprovalBatch.reject(new Error('Tool approval was cancelled because the desktop window closed.'));
    }
  });
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
