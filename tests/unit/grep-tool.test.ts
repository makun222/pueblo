import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGrepTool } from '../../src/tools/grep-tool';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('grep tool', () => {
  it('returns matching lines with file paths and line numbers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-grep-tool-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'alpha.ts'), 'const task = 1;\nconst other = 2;\nTask runner', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'beta.ts'), 'nothing here\ntask helper', 'utf8');

    const grepTool = createGrepTool();
    const result = await grepTool({
      cwd: tempDir,
      pattern: 'task',
      include: '*.ts',
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Matched 3 line(s)');
    expect(result.output).toEqual([
      'alpha.ts:1: const task = 1;',
      'alpha.ts:3: Task runner',
      'beta.ts:2: task helper',
    ]);
  });

  it('respects the include filter and skips non-matching file extensions', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-grep-tool-include-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'alpha.ts'), 'task in ts', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'beta.md'), 'task in md', 'utf8');

    const grepTool = createGrepTool();
    const result = await grepTool({
      cwd: tempDir,
      pattern: 'task',
      include: '*.ts',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(['alpha.ts:1: task in ts']);
  });
});