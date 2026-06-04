import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolExecutionResult } from './glob-tool';
import type { ProviderShellExecToolArgs } from '../providers/provider-adapter';
import { isTaskCancellationError, toTaskCancellationError } from '../shared/task-cancellation';

const execFileAsync = promisify(execFile);

export interface ShellExecToolRequest {
  readonly mode: ProviderShellExecToolArgs['mode'];
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

function resolveShellProgram(mode: ProviderShellExecToolArgs['mode']): { command: string; args: string[] } | null {
  if (mode === 'cmd') {
    if (process.platform !== 'win32') {
      return null;
    }

    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c'],
    };
  }

  return {
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
  };
}

export function createShellExecTool() {
  return async (request: ShellExecToolRequest): Promise<ToolExecutionResult> => {
    const shellProgram = resolveShellProgram(request.mode);
    if (!shellProgram) {
      return {
        toolName: 'shell_exec',
        status: 'failed',
        summary: `${request.mode} mode is not available on this platform`,
        output: [],
      };
    }

    try {
      const result = await execFileAsync(shellProgram.command, [...shellProgram.args, request.command], {
        cwd: request.cwd,
        shell: false,
        signal: request.signal,
      });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);

      return {
        toolName: 'shell_exec',
        status: 'succeeded',
        summary: output[0] ?? `${request.mode} command completed`,
        output,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        throw toTaskCancellationError(error, 'Shell command execution was cancelled.');
      }

      return {
        toolName: 'shell_exec',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Shell command execution failed',
        output: [],
      };
    }
  };
}