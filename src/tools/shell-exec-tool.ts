import { execFile } from 'node:child_process';
import type { ToolExecutionResult } from './glob-tool';
import type { ProviderShellExecToolArgs } from '../providers/provider-adapter';
import { isTaskCancellationError, toTaskCancellationError } from '../shared/task-cancellation';

export interface ShellExecToolRequest {
  readonly mode: ProviderShellExecToolArgs['mode'];
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000 });
  } catch {
    // best-effort: process may already be dead
  }
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

    const childProcess = execFile(shellProgram.command, [...shellProgram.args, request.command], {
      cwd: request.cwd,
      shell: false,
      signal: request.signal,
    });

    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        childProcess.stdout?.on('data', (data: string) => { stdout += data; });
        childProcess.stderr?.on('data', (data: string) => { stderr += data; });

        childProcess.on('error', (err) => {
          if (!settled) { settled = true; reject(err); }
        });

        childProcess.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            const error = new Error(code === null ? 'Process was terminated' : `Command failed with exit code ${code}`);
            (error as any).stdout = stdout;
            (error as any).stderr = stderr;
            reject(error);
          }
        });
      });

      const output = [stdout.trim(), stderr.trim()].filter(Boolean);

      return {
        toolName: 'shell_exec',
        status: 'succeeded',
        summary: output[0] ?? `${request.mode} command completed`,
        output,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        if (process.platform === 'win32' && childProcess.pid !== undefined) {
          killProcessTree(childProcess.pid);
        }
        throw toTaskCancellationError(error, 'Shell command execution was cancelled.');
      }

      const execError = error as { stdout?: string; stderr?: string };
      const errorOutput = [execError.stdout?.trim(), execError.stderr?.trim()].filter(Boolean) as string[];

      return {
        toolName: 'shell_exec',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Shell command execution failed',
        output: errorOutput,
      };
    }
  };
}
