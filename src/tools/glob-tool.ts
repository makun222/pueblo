import { glob } from 'node:fs/promises';

export interface GlobToolRequest {
  readonly pattern: string;
  readonly cwd: string;
}

export interface ToolExecutionResult {
  readonly toolName: 'glob' | 'grep' | 'exec' | 'read';
  readonly status: 'succeeded' | 'failed' | 'empty';
  readonly summary: string;
  readonly output: string[];
}

export function createGlobTool() {
  return async (request: GlobToolRequest): Promise<ToolExecutionResult> => {
    try {
      const matches: string[] = [];

      for await (const entry of glob(request.pattern, { cwd: request.cwd })) {
        matches.push(entry);
      }

      return {
        toolName: 'glob',
        status: matches.length > 0 ? 'succeeded' : 'empty',
        summary: matches.length > 0 ? `Matched ${matches.length} path(s)` : 'No paths matched',
        output: matches,
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
