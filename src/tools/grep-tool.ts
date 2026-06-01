import fs from 'node:fs';
import path from 'node:path';

const MAX_GREP_RESULTS = 200;
const MAX_GREP_OUTPUT_CHARS = 12000;

export interface GrepToolRequest {
  readonly pattern: string;
  readonly cwd: string;
  readonly include?: string;
}

import type { ToolExecutionResult } from './glob-tool';

function matchesInclude(filePath: string, include?: string): boolean {
  if (!include) {
    return true;
  }

  if (include === '*.ts') {
    return filePath.endsWith('.ts');
  }

  return true;
}

export function createGrepTool() {
  return async (request: GrepToolRequest): Promise<ToolExecutionResult> => {
    try {
      const output: string[] = [];
      let totalMatches = 0;
      let totalChars = 0;
      const regex = new RegExp(request.pattern, 'i');

      const visit = (dirPath: string): void => {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
              continue;
            }
            visit(fullPath);
            continue;
          }

          if (!matchesInclude(fullPath, request.include)) {
            continue;
          }

          const content = fs.readFileSync(fullPath, 'utf8');
          const relativePath = path.relative(request.cwd, fullPath);
          const lines = content.split(/\r?\n/);

          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            regex.lastIndex = 0;
            if (!regex.test(line)) {
              continue;
            }

            totalMatches += 1;
            if (output.length >= MAX_GREP_RESULTS) {
              continue;
            }

            const matchedLine = `${relativePath}:${index + 1}: ${line}`;
            if (totalChars + matchedLine.length > MAX_GREP_OUTPUT_CHARS && output.length > 0) {
              continue;
            }

            output.push(matchedLine);
            totalChars += matchedLine.length;
          }
        }
      };

      visit(request.cwd);

      const truncated = output.length < totalMatches;

      return {
        toolName: 'grep',
        status: totalMatches > 0 ? 'succeeded' : 'empty',
        summary: totalMatches > 0
          ? truncated
            ? `Matched ${output.length} of ${totalMatches} line(s)`
            : `Matched ${totalMatches} line(s)`
          : 'No content matched',
        output,
      };
    } catch (error) {
      return {
        toolName: 'grep',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Grep execution failed',
        output: [],
      };
    }
  };
}
