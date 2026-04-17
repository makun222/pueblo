import { ipcMain, BrowserWindow } from 'electron';
import { createRuntimeCoordinator, RuntimeMessage } from '../../app/runtime';
import { createCliDependencies } from '../../cli/index';
import { loadAppConfig } from '../../shared/config';
import { createOutputBlock, createResultBlocks } from '../../shared/result';
import { routeInput } from '../../commands/input-router';

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  const config = loadAppConfig();
  const cli = createCliDependencies(config);
  const runtime = createRuntimeCoordinator({
    config,
    submitInput: cli.submitInput,
  });

  runtime.onMessage((message: RuntimeMessage) => {
    mainWindow.webContents.send('output', message.block);
  });

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