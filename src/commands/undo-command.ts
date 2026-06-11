import { successResult, failureResult, type CommandResult } from '../shared/result.js';
import { SnapshotEngine } from '../shared/snapshot-engine.js';
import { isAbsolute, resolve, relative } from 'node:path';

/**
 * Factory that creates the /undo command handler.
 *
 * Usage: /undo <file-path>
 *
 * The handler requires a way to obtain the current workspace root so it can
 * resolve relative file paths and locate the snapshot storage.
 */
export function createUndoHandler(getWorkspaceRoot: () => string) {
  return async (args: string[]): Promise<CommandResult<unknown>> => {
    if (args.length !== 1 || !args[0].trim()) {
      return failureResult(
        'INVALID_USAGE',
        'Usage: /undo <file-path>',
        ['Provide exactly one argument: the path of the file to undo.'],
      );
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return failureResult(
        'NO_WORKSPACE',
        'No workspace is currently open.',
        ['Open a workspace folder first, then try /undo again.'],
      );
    }

    const absolutePath = isAbsolute(args[0]) ? args[0] : resolve(workspaceRoot, args[0]);

    const snapshotEngine = new SnapshotEngine(workspaceRoot, {
      maxSnapshotsPerFile: 50,
      ttlDays: 7,
    });

    try {
      const snapshots = await snapshotEngine.listSnapshots(absolutePath);

      if (snapshots.length === 0) {
        const relPath = relative(workspaceRoot, absolutePath);
        return failureResult(
          'NO_SNAPSHOTS',
          `No snapshots found for "${relPath}". Nothing to undo.`,
          ['Edit the file first with auto-save enabled to create snapshots.'],
        );
      }

      const restored = await snapshotEngine.restoreFromSnapshot(absolutePath);

      const relPath = relative(workspaceRoot, absolutePath);
      const isNullSnapshot = restored.hash === 'null-file-did-not-exist';

      if (isNullSnapshot) {
        return successResult(
          'UNDO_DELETED',
          `Undid creation of "${relPath}". The file has been deleted.`,
          { filePath: absolutePath, action: 'deleted' },
        );
      }

      return successResult(
        'UNDO_RESTORED',
        `Restored "${relPath}" to snapshot from ${restored.timestamp}.`,
        { filePath: absolutePath, timestamp: restored.timestamp },
      );
    } catch (error) {
      return failureResult(
        'UNDO_FAILED',
        `Failed to undo "${relative(workspaceRoot, absolutePath)}".`,
        error instanceof Error ? [error.message] : [],
      );
    }
  };
}
