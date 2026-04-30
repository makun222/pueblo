import { ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import { createCliDependencies } from '../../cli/index';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createResultBlocks } from '../../shared/result';
import { routeInput } from '../../commands/input-router';
import type { DesktopRuntimeStatus } from '../shared/ipc-contract';

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config, { startNewSession: true, deferAgentSelection: true });
  const runtime = createRuntimeCoordinator({
    config,
    submitInput: cli.submitInput,
  });

  cli.setProgressReporter((message) => {
    runtime.publish({
      block: createOutputBlock({
        type: 'system',
        title: 'GitHub Device Login',
        content: message,
        sourceRefs: [],
      }),
    });
  });

  runtime.onMessage((message: RuntimeMessage) => {
    mainWindow.webContents.send('output', message.block);
  });

  ipcMain.removeHandler('get-runtime-status');
  ipcMain.handle('get-runtime-status', async () => resolveRuntimeStatus(cli));

  ipcMain.removeHandler('list-agent-profiles');
  ipcMain.handle('list-agent-profiles', async () => cli.listAgentProfiles());

  ipcMain.removeHandler('start-agent-session');
  ipcMain.handle('start-agent-session', async (_event, profileId: string) => cli.startAgentSession(profileId));

  ipcMain.removeHandler('submit-input');
  ipcMain.handle('submit-input', async (event, input: string) => {
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
}

function resolveRuntimeStatus(
  cli: ReturnType<typeof createCliDependencies>,
): DesktopRuntimeStatus {
  return cli.getRuntimeStatus();
}