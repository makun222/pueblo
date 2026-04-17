import fs from 'node:fs';
import path from 'node:path';

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
      const results: string[] = [];
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
          if (regex.test(content)) {
            results.push(path.relative(request.cwd, fullPath));
          }
        }
      };

      visit(request.cwd);

      return {
        toolName: 'grep',
        status: results.length > 0 ? 'succeeded' : 'empty',
        summary: results.length > 0 ? `Matched ${results.length} file(s)` : 'No content matched',
        output: results,
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
