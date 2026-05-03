import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditApprovalPreview, createEditTool } from '../../src/tools/edit-tool';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('edit tool', () => {
  it('replaces one exact match inside a workspace file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-edit-tool-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');

    const editTool = createEditTool();
    const result = await editTool({
      cwd: tempDir,
      path: filePath,
      oldText: 'beta',
      newText: 'delta',
    });

    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('delta');
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('beta');
  });

  it('replaces one exact match inside a specified line range', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-edit-tool-ranged-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.ts');
    fs.writeFileSync(filePath, [
      'function first() {',
      '  return 1;',
      '}',
      '',
      'function second() {',
      '  return 1;',
      '}',
    ].join('\n'), 'utf8');

    const editTool = createEditTool();
    const result = await editTool({
      cwd: tempDir,
      path: filePath,
      oldText: 'return 1;',
      newText: 'return 2;',
      startLine: 5,
      endLine: 7,
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toContain('lines 5-7');
    expect(fs.readFileSync(filePath, 'utf8')).toBe([
      'function first() {',
      '  return 1;',
      '}',
      '',
      'function second() {',
      '  return 2;',
      '}',
    ].join('\n'));
  });

  it('rejects ambiguous edits when the exact text appears multiple times', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-edit-tool-ambiguous-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'beta\nalpha\nbeta', 'utf8');

    const editTool = createEditTool();
    const result = await editTool({
      cwd: tempDir,
      path: filePath,
      oldText: 'beta',
      newText: 'delta',
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('ambiguous');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('beta\nalpha\nbeta');
  });

  it('rejects a line range that falls outside the target file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-edit-tool-range-error-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta', 'utf8');

    const editTool = createEditTool();
    const result = await editTool({
      cwd: tempDir,
      path: filePath,
      oldText: 'beta',
      newText: 'delta',
      startLine: 2,
      endLine: 3,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('outside the file bounds');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('alpha\nbeta');
  });

  it('builds an approval preview with short summary and diff-style detail', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-edit-preview-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'sample.ts');
    fs.writeFileSync(filePath, [
      'function alpha() {',
      '  return 1;',
      '}',
    ].join('\n'), 'utf8');

    const preview = buildEditApprovalPreview({
      cwd: tempDir,
      path: filePath,
      oldText: 'return 1;',
      newText: 'return 2;',
      startLine: 1,
      endLine: 3,
    });

    expect(preview.title).toContain('sample.ts');
    expect(preview.summary).toContain('sample.ts @ lines 1-3');
    expect(preview.summary).toContain('@@ lines 1-3 @@');
    expect(preview.summary).toContain('- return 1;');
    expect(preview.summary).toContain('+ return 2;');
    expect(preview.detail).toContain('Scope: lines 1-3');
    expect(preview.detail).toContain('Current file check: 1 exact match in scope');
    expect(preview.detail).toContain('@@ lines 1-3 @@');
    expect(preview.detail).toContain('- return 1;');
    expect(preview.detail).toContain('+ return 2;');
  });
});