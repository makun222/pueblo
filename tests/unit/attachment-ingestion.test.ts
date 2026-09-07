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

  it('ingests a PNG image: magic-bytes mime + binary copy + non-editable sidecar asset', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-ingestion-')); // eslint-disable-line no-restricted-syntax
    tempDirs.push(tempRoot);
    const workspaceRoot = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const sourcePath = path.join(tempRoot, 'screenshot.png');
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake-png-payload'),
    ]);
    fs.writeFileSync(sourcePath, pngBytes);

    const manifests = await ingestInputFiles({ filePaths: [sourcePath], workspaceRoot, sessionId: 'session-img' });

    expect(manifests).toHaveLength(1);
    const manifest = manifests[0];
    expect(manifest?.kind).toBe('image');
    expect(manifest?.source.mimeType).toBe('image/png');
    expect(manifest?.asset.editable).toBe(false);
    const copiedPath = manifest!.asset.filePath;
    expect(copiedPath).toBeTruthy();
    expect(copiedPath!.startsWith(path.join(workspaceRoot, '.pueblo-ws', 'attachments', 'session-img'))).toBe(true);
    expect(fs.existsSync(copiedPath!)).toBe(true);
    expect(fs.readFileSync(copiedPath!)).toEqual(pngBytes);

    const payload = JSON.parse(fs.readFileSync(manifest!.asset.jsonPath, 'utf8')) as {
      kind: string;
      asset: { filePath?: string; editable: boolean };
      summary: { previewText: string | null };
    };
    expect(payload.kind).toBe('image');
    expect(payload.asset.filePath).toBe(copiedPath);
    expect(payload.asset.editable).toBe(false);
    expect(payload.summary.previewText).toContain('image/png');
  });

  it('rejects an image whose extension gate passes but magic bytes are not a supported image', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-gate-')); // eslint-disable-line no-restricted-syntax
    tempDirs.push(tempRoot);
    fs.mkdirSync(tempRoot, { recursive: true });
    const sourcePath = path.join(tempRoot, 'fake.png');
    fs.writeFileSync(sourcePath, 'this is definitely not an image', 'utf8');

    await expect(
      ingestInputFiles({ filePaths: [sourcePath], workspaceRoot: tempRoot, sessionId: 'session-bad' }),
    ).rejects.toThrow(/magic bytes/);
  });

  it.each([
    { header: [0xff, 0xd8, 0xff, 0xe0], extension: 'jpg', mime: 'image/jpeg' },
    { header: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], extension: 'gif', mime: 'image/gif' },
    { header: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], extension: 'webp', mime: 'image/webp' },
  ])('detects $mime from magic bytes ($extension)', async ({ header, extension, mime }) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-mime-')); // eslint-disable-line no-restricted-syntax
    tempDirs.push(tempRoot);
    fs.mkdirSync(tempRoot, { recursive: true });
    const sourcePath = path.join(tempRoot, `sample.${extension}`);
    fs.writeFileSync(sourcePath, Buffer.from([...header, ...Buffer.from('payload')]));

    const manifests = await ingestInputFiles({ filePaths: [sourcePath], workspaceRoot: tempRoot, sessionId: 'session-mime' });

    expect(manifests[0]?.source.mimeType).toBe(mime);
    expect(manifests[0]?.asset.filePath?.endsWith(`sample.${extension}`)).toBe(false);
    expect(manifests[0]?.asset.filePath).toContain(path.join(tempRoot, '.pueblo-ws', 'attachments', 'session-mime'));
  });
});