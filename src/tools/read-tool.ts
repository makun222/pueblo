import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from './glob-tool';

export interface ReadToolRequest {
  readonly path: string;
  readonly cwd: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 12000;

export function createReadTool() {
  return async (request: ReadToolRequest): Promise<ToolExecutionResult> => {
    const requestedPath = request.path.trim();

    if (!requestedPath) {
      return {
        toolName: 'read',
        status: 'failed',
        summary: 'Path is required',
        output: [],
      };
    }

    try {
      const workspaceRoot = path.resolve(request.cwd);
      const absolutePath = resolveRequestedPath(workspaceRoot, requestedPath);
      const normalizedRelativePath = path.relative(workspaceRoot, absolutePath);

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
      const startIndex = request.startLine ? Math.max(0, request.startLine - 1) : 0;
      const endIndex = request.endLine ? Math.min(lines.length, request.endLine) : lines.length;

      if (
        request.startLine !== undefined
        && request.endLine !== undefined
        && request.startLine > request.endLine
      ) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: 'startLine must be less than or equal to endLine',
          output: [],
        };
      }

      const selectedLines = lines.slice(startIndex, endIndex);
      const output: string[] = [];
      let totalChars = 0;

      for (let index = 0; index < selectedLines.length && output.length < MAX_READ_LINES; index += 1) {
        const lineNumber = startIndex + index + 1;
        const numberedLine = `${lineNumber}: ${selectedLines[index]}`;
        if (totalChars + numberedLine.length > MAX_READ_CHARS && output.length > 0) {
          break;
        }

        output.push(numberedLine);
        totalChars += numberedLine.length;
      }

      const selectedLineCount = selectedLines.length;
      const truncated = output.length < selectedLineCount;
      const rangeLabel = buildReadRangeLabel(request.startLine, request.endLine);
      return {
        toolName: 'read',
        status: output.length > 0 ? 'succeeded' : 'empty',
        summary: truncated
          ? `Read ${output.length} of ${selectedLineCount} line(s) from${rangeLabel} ${normalizedRelativePath}`
          : `Read ${selectedLineCount} line(s) from${rangeLabel} ${normalizedRelativePath}`,
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

function resolveRequestedPath(workspaceRoot: string, requestedPath: string): string {
  const normalizedRequestedPath = path.normalize(requestedPath);
  return path.isAbsolute(normalizedRequestedPath)
    ? normalizedRequestedPath
    : path.resolve(workspaceRoot, normalizedRequestedPath);
}

function buildReadRangeLabel(startLine?: number, endLine?: number): string {
  if (startLine !== undefined && endLine !== undefined) {
    return ` lines ${startLine}-${endLine}`;
  }

  if (startLine !== undefined) {
    return ` line ${startLine} onward`;
  }

  if (endLine !== undefined) {
    return ` lines 1-${endLine}`;
  }

  return '';
}