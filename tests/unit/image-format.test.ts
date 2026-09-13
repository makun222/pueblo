import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  detectImageFormat,
  isImageExtension,
  isImagePath,
  MAX_VISION_IMAGE_BYTES,
  probeImageFileSync,
  toImageDataUrl,
} from '../../src/tools/image-format';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const WEBP_SIGNATURE = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')]);

describe('detectImageFormat', () => {
  it('detects PNG by magic bytes', () => {
    expect(detectImageFormat(PNG_SIGNATURE)).toEqual({ mimeType: 'image/png', extension: '.png' });
  });

  it('detects JPEG by magic bytes', () => {
    expect(detectImageFormat(JPEG_SIGNATURE)).toEqual({ mimeType: 'image/jpeg', extension: '.jpg' });
  });

  it('detects GIF by magic bytes', () => {
    expect(detectImageFormat(GIF_SIGNATURE)).toEqual({ mimeType: 'image/gif', extension: '.gif' });
  });

  it('detects WebP by RIFF/WEBP magic bytes', () => {
    expect(detectImageFormat(WEBP_SIGNATURE)).toEqual({ mimeType: 'image/webp', extension: '.webp' });
  });

  it('returns null for non-image bytes', () => {
    expect(detectImageFormat(Buffer.from('hello world', 'utf8'))).toBeNull();
  });

  it('returns null for truncated buffers', () => {
    expect(detectImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('isImageExtension / isImagePath', () => {
  it('recognizes supported image extensions case-insensitively', () => {
    expect(isImageExtension('.PNG')).toBe(true);
    expect(isImageExtension('.jpeg')).toBe(true);
    expect(isImageExtension('.webp')).toBe(true);
    expect(isImageExtension('.tiff')).toBe(false);
  });

  it('resolves from a full path', () => {
    expect(isImagePath('materials/paper-01.JPG')).toBe(true);
    expect(isImagePath('materials/paper-01.txt')).toBe(false);
  });
});

describe('toImageDataUrl', () => {
  it('builds a base64 data URL', () => {
    expect(toImageDataUrl(Buffer.from([1, 2, 3]), 'image/png')).toBe('data:image/png;base64,AQID');
  });
});

describe('probeImageFileSync', () => {
  it('reports metadata for a valid image file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-'));
    const filePath = path.join(dir, 'sample.png');
    fs.writeFileSync(filePath, PNG_SIGNATURE);
    const probe = probeImageFileSync(filePath);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.mimeType).toBe('image/png');
      expect(probe.sizeBytes).toBe(PNG_SIGNATURE.length);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a file whose extension claims image but bytes are not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-'));
    const filePath = path.join(dir, 'fake.png');
    fs.writeFileSync(filePath, Buffer.from('not an image at all', 'utf8'));
    const probe = probeImageFileSync(filePath);
    expect(probe).toEqual({ ok: false, reason: 'unsupported-image-bytes' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects files exceeding the byte cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-image-'));
    const filePath = path.join(dir, 'big.png');
    fs.writeFileSync(filePath, PNG_SIGNATURE);
    const probe = probeImageFileSync(filePath, 4);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.reason).toBe('too-large');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-found for a missing file', () => {
    const probe = probeImageFileSync(path.join(os.tmpdir(), 'pueblo-missing-image.png'));
    expect(probe).toEqual({ ok: false, reason: 'not-found' });
  });

  it('exposes a 32 MiB default cap', () => {
    expect(MAX_VISION_IMAGE_BYTES).toBe(32 * 1024 * 1024);
  });
});
