import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadTool } from '../../src/tools/read-tool';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('read tool', () => {
  it('reads a file by absolute path when the file is inside the workspace', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-absolute-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');

    const readTool = createReadTool();
    const result = await readTool({
      cwd: tempDir,
      path: filePath,
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toContain('sample.txt');
    expect(result.output).toEqual(['1: alpha', '2: beta', '3: gamma']);
  });

  it('rejects an absolute path outside the workspace root', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-workspace-'));
    tempDirs.push(workspaceDir);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-outside-'));
    tempDirs.push(outsideDir);
    const outsideFilePath = path.join(outsideDir, 'outside.txt');
    fs.writeFileSync(outsideFilePath, 'outside', 'utf8');

    const readTool = createReadTool();
    const result = await readTool({
      cwd: workspaceDir,
      path: outsideFilePath,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toBe('Path must stay within the workspace root');
  });
});