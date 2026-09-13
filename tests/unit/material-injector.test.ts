import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_MATERIAL_IMAGES_PER_TURN,
  collectMaterialInjection,
  commitMaterialInjection,
  loadMaterialManifest,
  resolveMaterialManifestPath,
} from '../../src/agent/material-injector';

// Minimal valid PNG magic bytes (probeImageFileSync only inspects the header).
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-material-'));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeImage(name: string, extraBytes = 0): string {
  const dir = path.join(workspaceRoot, 'materials');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.concat([PNG_HEADER, Buffer.alloc(extraBytes, 0x23)]));
  return filePath;
}

function writeRaw(name: string, content: Buffer): string {
  const dir = path.join(workspaceRoot, 'materials');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('collectMaterialInjection', () => {
  it('returns an empty plan when the workspace root is unknown', () => {
    const plan = collectMaterialInjection({ workspaceRoot: null, supportsVision: true });
    expect(plan.materialsDirectoryPresent).toBe(false);
    expect(plan.images).toEqual([]);
    expect(plan.indexLines).toEqual([]);
    expect(plan.manifestPath).toBeNull();
  });

  it('returns an empty plan when materials/ does not exist', () => {
    const plan = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(plan.materialsDirectoryPresent).toBe(false);
    expect(plan.images).toEqual([]);
    expect(plan.nextManifest).toBeNull();
  });

  it('injects all images on the first scan and only changed ones afterwards', () => {
    const pngA = writeImage('a.png', 8);
    writeImage('b.png', 16);

    const first = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(first.materialsDirectoryPresent).toBe(true);
    expect(first.scannedImageCount).toBe(2);
    expect(first.images.map((image) => image.relativePath)).toEqual(['materials/a.png', 'materials/b.png']);
    expect(first.images[0]?.mimeType).toBe('image/png');
    expect(first.images[0]?.sizeBytes).toBe(PNG_HEADER.length + 8);
    expect(first.nextManifest).not.toBeNull();
    expect(first.indexLines.join('\n')).toContain('[attached as image part this turn]');

    commitMaterialInjection(first);
    expect(fs.existsSync(resolveMaterialManifestPath(workspaceRoot))).toBe(true);

    const second = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(second.images).toEqual([]);
    expect(second.scannedImageCount).toBe(2);
    expect(second.nextManifest).toBeNull();
    expect(second.indexLines.filter((line) => line.startsWith('- '))).toHaveLength(2);

    // Touch a.png with different content: only it is re-injected.
    fs.writeFileSync(pngA, Buffer.concat([PNG_HEADER, Buffer.alloc(64, 0x24)]));
    const third = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(third.images.map((image) => image.relativePath)).toEqual(['materials/a.png']);
  });

  it('re-injects a file whose mtime changed without size change', () => {
    const pngA = writeImage('a.png', 8);
    const first = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    commitMaterialInjection(first);

    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(pngA, future, future);

    const second = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(second.images.map((image) => image.relativePath)).toEqual(['materials/a.png']);
  });

  it('lists images in the index but injects none for non-vision models', () => {
    writeImage('a.png');

    const plan = collectMaterialInjection({ workspaceRoot, supportsVision: false });
    expect(plan.images).toEqual([]);
    expect(plan.indexLines.filter((line) => line.startsWith('- '))).toHaveLength(1);
    expect(plan.indexLines.join('\n')).not.toContain('[attached as image part this turn]');
    // No images delivered => manifest must not advance, so switching to a vision
    // model later still injects them.
    expect(plan.nextManifest).toBeNull();

    commitMaterialInjection(plan);
    expect(fs.existsSync(resolveMaterialManifestPath(workspaceRoot))).toBe(false);
  });

  it('ignores non-image files and files with image extensions but invalid bytes', () => {
    writeImage('a.png');
    writeRaw('notes.txt', Buffer.from('hello'));
    writeRaw('fake.png', Buffer.from('not actually a png'));

    const plan = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(plan.scannedImageCount).toBe(1);
    expect(plan.images.map((image) => image.relativePath)).toEqual(['materials/a.png']);
    expect(plan.indexLines.join('\n')).not.toContain('notes.txt');
    expect(plan.indexLines.join('\n')).not.toContain('fake.png');
  });

  it('caps the number of images per turn and delivers the remainder next turn', () => {
    for (let index = 0; index < MAX_MATERIAL_IMAGES_PER_TURN + 2; index += 1) {
      writeImage(`img-${String(index).padStart(2, '0')}.png`);
    }

    const first = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(first.images).toHaveLength(MAX_MATERIAL_IMAGES_PER_TURN);
    commitMaterialInjection(first);

    const second = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(second.images).toHaveLength(2);
  });

  it('prunes manifest entries for deleted files', () => {
    writeImage('a.png');
    const pngB = writeImage('b.png');
    commitMaterialInjection(collectMaterialInjection({ workspaceRoot, supportsVision: true }));

    fs.rmSync(pngB);
    const plan = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(plan.images).toEqual([]);
    commitMaterialInjection(plan);

    const manifest = loadMaterialManifest(resolveMaterialManifestPath(workspaceRoot));
    expect(Object.keys(manifest.files)).toEqual(['materials/a.png']);
  });

  it('tolerates a corrupt manifest file by treating it as empty', () => {
    writeImage('a.png');
    const manifestPath = resolveMaterialManifestPath(workspaceRoot);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{ not valid json');

    const plan = collectMaterialInjection({ workspaceRoot, supportsVision: true });
    expect(plan.images.map((image) => image.relativePath)).toEqual(['materials/a.png']);
  });
});
