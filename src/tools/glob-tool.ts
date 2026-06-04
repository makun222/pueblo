import { glob } from 'node:fs/promises';

import type { RendererFileChange } from '../shared/schema';

const MAX_GLOB_RESULTS = 200;
const MAX_GLOB_OUTPUT_CHARS = 12000;

export interface GlobToolRequest {
  readonly pattern: string;
  readonly cwd: string;
}

export interface ToolExecutionResult {
  readonly toolName: 'glob' | 'grep' | 'exec' | 'read' | 'edit' | 'write';
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

      for await (const entry of glob(request.pattern, { cwd: request.cwd })) {
        totalMatches += 1;

        if (output.length >= MAX_GLOB_RESULTS) {
          continue;
        }

        if (totalChars + entry.length > MAX_GLOB_OUTPUT_CHARS && output.length > 0) {
          continue;
        }

        output.push(entry);
        totalChars += entry.length;
      }

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
