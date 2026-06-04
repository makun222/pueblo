import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { type ToolExecutionResult } from './glob-tool.js';

export interface WriteToolRequest {
  readonly path: string;
  readonly text: string;
  readonly cwd: string;
}

export function createWriteTool() {
  return async (request: WriteToolRequest): Promise<ToolExecutionResult> => {
    try {
      const absolutePath = isAbsolute(request.path)
        ? request.path
        : resolve(request.cwd, request.path);
      mkdirSync(dirname(absolutePath), { recursive: true });
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
