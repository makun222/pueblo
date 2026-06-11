import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { type ToolExecutionResult } from './glob-tool.js';
import { isAutoSaveEnabled } from '../shared/auto-save-state.js';
import { SnapshotEngine } from '../shared/snapshot-engine.js';

export interface WriteToolRequest {
  readonly path: string;
  readonly text: string;
  readonly cwd: string;
}

export interface WriteToolOptions {
  readonly workspaceRoot?: string;
}

export function createWriteTool(options: WriteToolOptions = {}) {
  const resolvedWorkspaceRoot = options.workspaceRoot || '.';
  const snapshotEngine = new SnapshotEngine(
    resolvedWorkspaceRoot,
    { maxSnapshotsPerFile: 50, ttlDays: 7 },
  );

  return async (request: WriteToolRequest): Promise<ToolExecutionResult> => {
    try {
      const absolutePath = isAbsolute(request.path)
        ? request.path
        : resolve(request.cwd, request.path);
      mkdirSync(dirname(absolutePath), { recursive: true });

      // Auto-save: snapshot-before-write (null snapshot for new files)
      if (isAutoSaveEnabled()) {
        if (existsSync(absolutePath)) {
          await snapshotEngine.createSnapshot(absolutePath);
        } else {
          await snapshotEngine.createNullSnapshot(absolutePath);
        }
      }

      writeFileSync(absolutePath, request.text, 'utf-8');
      return {
        toolName: 'write',
        status: 'succeeded',
        summary: `Wrote ${absolutePath} (${request.text.length} characters)`,
        output: [`Wrote ${absolutePath} (${request.text.length} characters)`],
      };
    } catch (error) {
      return {
        toolName: 'write',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Write failed',
        output: [],
      };
    }
  };
}
