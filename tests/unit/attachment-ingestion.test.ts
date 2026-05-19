import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestInputFiles } from '../../src/desktop/main/attachment-ingestion';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('attachment ingestion', () => {
  it('stores processed attachment JSON assets inside workspace/.pueblo-ws', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-attachment-ingestion-'));
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const sourceRoot = path.join(tempRoot, 'source');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });

    const sourcePath = path.join(sourceRoot, 'notes.txt');
    fs.writeFileSync(sourcePath, 'hello from uploaded text', 'utf8');

    const manifests = await ingestInputFiles({
      filePaths: [sourcePath],
      workspaceRoot,
      sessionId: 'session-1',
    });

    expect(manifests).toHaveLength(1);
    const manifest = manifests[0];
    expect(manifest?.asset.jsonPath).toContain(path.join(workspaceRoot, '.pueblo-ws', 'attachments', 'session-1'));
    expect(manifest?.asset.jsonPath.startsWith(runtimeRoot)).toBe(false);
    expect(fs.existsSync(manifest!.asset.jsonPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(manifest!.asset.jsonPath, 'utf8')) as {
      asset: { jsonPath: string };
      source: { originalPath: string };
    };
    expect(payload.asset.jsonPath).toBe(manifest!.asset.jsonPath);
    expect(payload.source.originalPath).toBe(sourcePath);
  });
});