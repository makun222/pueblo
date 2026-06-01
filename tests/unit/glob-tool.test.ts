import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGlobTool } from '../../src/tools/glob-tool';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('glob tool', () => {
  it('truncates oversized glob result sets before returning them', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-glob-tool-truncated-'));
    tempDirs.push(tempDir);

    for (let index = 0; index < 260; index += 1) {
      fs.writeFileSync(path.join(tempDir, `file-${String(index).padStart(3, '0')}.ts`), 'export {};', 'utf8');
    }

    const globTool = createGlobTool();
    const result = await globTool({
      cwd: tempDir,
      pattern: '*.ts',
    });

    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Matched 200 of 260 path(s)');
    expect(result.output).toHaveLength(200);
  });
});