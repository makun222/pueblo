import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';

export function createSessionTitle(goal: string): string {
  const trimmed = goal.trim();
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 57)}...`;
}

export function createTerminalLineReader(): { readLine: (prompt: string) => Promise<string>; close: () => void } {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    readLine(prompt: string): Promise<string> {
      return readline.question(prompt);
    },
    close(): void {
      readline.close();
    },
  };
}

export function resolveProjectRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return path.resolve(startDir);
    }

    currentDir = parentDir;
  }
}

export function resolveElectronBinary(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronModule = require('electron') as string | { default?: string };

  if (typeof electronModule === 'string' && electronModule.trim()) {
    return electronModule;
  }

  if (typeof electronModule === 'object' && typeof electronModule.default === 'string' && electronModule.default.trim()) {
    return electronModule.default;
  }

  throw new Error('Electron binary path could not be resolved');
}
