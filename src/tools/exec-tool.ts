import { execFile } from 'node:child_process';
import type { ToolExecutionResult } from './glob-tool';
import { isTaskCancellationError, toTaskCancellationError } from '../shared/task-cancellation';

export interface ExecToolRequest {
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

function splitCommand(commandText: string): string[] {
  const matches = commandText.match(/(?:[^\\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^['\"]|['\"]$/g, ''));
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

    const childProcess = execFile(command, args, { cwd: request.cwd, shell: false, signal: request.signal });

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
        toolName: 'exec',
        status: 'succeeded',
        summary: output[0] ?? 'Command completed',
        output,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) {
        if (process.platform === 'win32' && childProcess.pid !== undefined) {
          killProcessTree(childProcess.pid);
        }
        throw toTaskCancellationError(error, 'Command execution was cancelled.');
      }

      const execError = error as { stdout?: string; stderr?: string };
      const errorOutput = [execError.stdout?.trim(), execError.stderr?.trim()].filter(Boolean) as string[];

      return {
        toolName: 'exec',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Command execution failed',
        output: errorOutput,
      };
    }
  };
}
