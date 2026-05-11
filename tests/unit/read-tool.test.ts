import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadTool } from '../../src/tools/read-tool';
import { providerReadToolArgsSchema } from '../../src/providers/provider-adapter';

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

  it('reads only the requested line range when startLine and endLine are provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-range-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta', 'utf8');

    const readTool = createReadTool();
    const result = await readTool({
      cwd: tempDir,
      path: 'sample.txt',
      startLine: 2,
      endLine: 3,
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Read 2 line(s) from lines 2-3 sample.txt');
    expect(result.output).toEqual(['2: beta', '3: gamma']);
  });

  it('reads from the requested start line to the end of the file when only startLine is provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-from-start-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta', 'utf8');

    const readTool = createReadTool();
    const result = await readTool({
      cwd: tempDir,
      path: 'sample.txt',
      startLine: 3,
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Read 2 line(s) from line 3 onward sample.txt');
    expect(result.output).toEqual(['3: gamma', '4: delta']);
  });

  it('reads from the top of the file through the requested end line when only endLine is provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-to-end-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta', 'utf8');

    const readTool = createReadTool();
    const result = await readTool({
      cwd: tempDir,
      path: 'sample.txt',
      endLine: 2,
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Read 2 line(s) from lines 1-2 sample.txt');
    expect(result.output).toEqual(['1: alpha', '2: beta']);
  });

  it('rejects invalid read line ranges in the provider schema', () => {
    expect(providerReadToolArgsSchema.parse({ path: 'sample.txt', startLine: 2 })).toEqual({
      path: 'sample.txt',
      startLine: 2,
    });
    expect(providerReadToolArgsSchema.parse({ path: 'sample.txt', endLine: 2 })).toEqual({
      path: 'sample.txt',
      endLine: 2,
    });
    expect(() => providerReadToolArgsSchema.parse({ path: 'sample.txt', startLine: 4, endLine: 2 })).toThrow(
      'startLine must be less than or equal to endLine',
    );
  });
});