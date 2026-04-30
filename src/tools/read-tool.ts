import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from './glob-tool';

export interface ReadToolRequest {
  readonly path: string;
  readonly cwd: string;
}

const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 12000;

export function createReadTool() {
  return async (request: ReadToolRequest): Promise<ToolExecutionResult> => {
    const relativePath = request.path.trim();

    if (!relativePath) {
      return {
        toolName: 'read',
        status: 'failed',
        summary: 'Path is required',
        output: [],
      };
    }

    try {
      const absolutePath = path.resolve(request.cwd, relativePath);
      const normalizedRelativePath = path.relative(request.cwd, absolutePath);

      if (normalizedRelativePath.startsWith('..') || path.isAbsolute(normalizedRelativePath)) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: 'Path must stay within the workspace root',
          output: [],
        };
      }

      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: 'Path does not point to a file',
          output: [],
        };
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const output: string[] = [];
      let totalChars = 0;

      for (let index = 0; index < lines.length && output.length < MAX_READ_LINES; index += 1) {
        const numberedLine = `${index + 1}: ${lines[index]}`;
        if (totalChars + numberedLine.length > MAX_READ_CHARS && output.length > 0) {
          break;
        }

        output.push(numberedLine);
        totalChars += numberedLine.length;
      }

      const truncated = output.length < lines.length;
      return {
        toolName: 'read',
        status: output.length > 0 ? 'succeeded' : 'empty',
        summary: truncated
          ? `Read ${output.length} of ${lines.length} line(s) from ${normalizedRelativePath}`
          : `Read ${lines.length} line(s) from ${normalizedRelativePath}`,
        output,
      };
    } catch (error) {
      return {
        toolName: 'read',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Read execution failed',
        output: [],
      };
    }
  };
}