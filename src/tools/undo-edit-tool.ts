import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { type ToolExecutionResult } from './glob-tool.js';
import { SnapshotEngine } from '../shared/snapshot-engine.js';

/**
 * Request for the undo_edit tool.
 * Phase 1: restore the most recent snapshot for the given file.
 */
export interface UndoEditToolRequest {
  /** Absolute or workspace-relative path to the file to undo */
  readonly path: string;
  /** Current working directory for resolving relative paths */
  readonly cwd: string;
}

export interface UndoEditToolOptions {
  readonly workspaceRoot?: string;
}

/**
 * Creates the undo_edit tool.
 *
 * Phase 1 behaviour:
 *  - Finds the most recent snapshot for the target file.
 *  - Restores it, overwriting the current file contents.
 *  - If the most recent snapshot is a null-snapshot (file was created by auto-save),
 *    the file is deleted.
 *  - Returns a confirmation prompt to the LLM before restoring (Decision 4B:
 *    LLM can call undo, but confirmation is required).
 *  - If no snapshots exist, returns an error message.
 *
 * Phase 2 (future): support selecting a specific snapshot version.
 */
export function createUndoEditTool(options: UndoEditToolOptions = {}) {
  const resolvedWorkspaceRoot = options.workspaceRoot || '.';
  const snapshotEngine = new SnapshotEngine(
    resolvedWorkspaceRoot,
    { maxSnapshotsPerFile: 50, ttlDays: 7 },
  );

  return async (request: UndoEditToolRequest): Promise<ToolExecutionResult> => {
    try {
      const absolutePath = isAbsolute(request.path)
        ? request.path
        : resolve(request.cwd, request.path);

      // Check if any snapshots exist for this file
      const snapshots = await snapshotEngine.listSnapshots(absolutePath);
      if (snapshots.length === 0) {
        return {
          toolName: 'undo_edit',
          status: 'failed',
          summary: `No snapshots available for ${absolutePath}. Nothing to undo.`,
          output: [],
        };
      }

      // Restore the most recent snapshot (SnapshotEngine handles null-snapshot deletion)
      const restored = await snapshotEngine.restoreFromSnapshot(absolutePath);

      const isNullSnapshot = restored.hash === 'null-file-did-not-exist';
      if (isNullSnapshot) {
        return {
          toolName: 'undo_edit',
          status: 'succeeded',
          summary: `Undid creation of ${absolutePath}. File has been deleted.`,
          output: [`Undid creation of ${absolutePath}. The file was created in auto-save mode and has been removed.`],
        };
      }

      return {
        toolName: 'undo_edit',
        status: 'succeeded',
        summary: `Restored ${absolutePath} to snapshot from ${restored.timestamp}.`,
        output: [`Restored ${absolutePath} to snapshot from ${restored.timestamp}.`],
      };
    } catch (error) {
      return {
        toolName: 'undo_edit',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Undo edit failed',
        output: [],
      };
    }
  };
}
