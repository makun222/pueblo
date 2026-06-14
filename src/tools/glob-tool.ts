import fs from 'node:fs';
import path from 'node:path';

import type { RendererFileChange } from '../shared/schema';
import minimatch from 'minimatch';

const MAX_GLOB_RESULTS = 200;
const MAX_GLOB_OUTPUT_CHARS = 12000;

export interface GlobToolRequest {
  readonly pattern: string;
  readonly cwd: string;
}

export interface ToolExecutionResult {
  readonly toolName: 'glob' | 'grep' | 'exec' | 'shell_exec' | 'read' | 'edit' | 'write' | 'undo_edit' | 'memo_recall';
  readonly status: 'succeeded' | 'failed' | 'empty';
  readonly summary: string;
  readonly output: string[];
  readonly fileChanges?: RendererFileChange[];
}

export function createGlobTool() {
  return async (request: GlobToolRequest): Promise<ToolExecutionResult> => {
    try {
      const output: string[] = [];
      let totalMatches = 0;
      let totalChars = 0;

      let shouldStop = false;

      const visit = (dirPath: string): void => {
        if (shouldStop) {
          return;
        }

        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (shouldStop) {
            return;
          }

          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
            continue;
          }

          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(request.cwd, fullPath);

          // Match both files and directories against the glob pattern
          if (minimatch(relativePath, request.pattern, { matchBase: true, dot: true } as any)) {
            totalMatches += 1;

            if (totalChars + relativePath.length <= MAX_GLOB_OUTPUT_CHARS || output.length === 0) {
              output.push(relativePath);
              totalChars += relativePath.length;
            }

            if (totalMatches >= MAX_GLOB_RESULTS) {
              shouldStop = true;
              return;
            }
          }

          // Recurse into directories
          if (entry.isDirectory()) {
            visit(fullPath);
          }
        }
      };

      visit(request.cwd);

      const truncated = output.length < totalMatches;

      return {
        toolName: 'glob',
        status: totalMatches > 0 ? 'succeeded' : 'empty',
        summary: totalMatches > 0
          ? truncated
            ? `Matched ${output.length} of ${totalMatches} path(s)`
            : `Matched ${totalMatches} path(s)`
          : 'No paths matched',
        output,
      };
    } catch (error) {
      return {
        toolName: 'glob',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Glob execution failed',
        output: [],
      };
    }
  };
}
