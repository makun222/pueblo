import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolExecutionResult } from './glob-tool';
import { isTaskCancellationError, toTaskCancellationError } from '../shared/task-cancellation';

const execFileAsync = promisify(execFile);

export interface ExecToolRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

function splitCommand(commandText: string): string[] {
  const matches = commandText.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

export function createExecTool() {
  return async (request: ExecToolRequest): Promise<ToolExecutionResult> => {
    const [command, ...args] = splitCommand(request.command.trim());

    if (!command) {
      return {
        toolName: 'exec',
        status: 'failed',
        summary: 'Command is required',
        output: [],
      };
    }

    try {
      const result = await execFileAsync(command, args, { cwd: request.cwd, shell: false, signal: request.signal });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);

      return {
        toolName: 'exec',
        status: 'succeeded',
        summary: output[0] ?? 'Command completed',
        output,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        throw toTaskCancellationError(error, 'Command execution was cancelled.');
      }

      return {
        toolName: 'exec',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Command execution failed',
        output: [],
      };
    }
  };
}
