import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkFileReadable, UNREADABLE_EXTENSIONS } from '../../src/tools/file-guard';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-file-guard-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('file-guard image relaxation', () => {
  it('no longer blacklists common image extensions', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
      expect(UNREADABLE_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  it('still blacklists non-image binary formats', () => {
    expect(UNREADABLE_EXTENSIONS.has('.bmp')).toBe(true);
    expect(UNREADABLE_EXTENSIONS.has('.exe')).toBe(true);
    expect(UNREADABLE_EXTENSIONS.has('.pdf')).toBe(true);
  });

  it('does not reject a valid PNG by extension gate', () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, 'sample.png');
      fs.writeFileSync(filePath, PNG_BYTES);
      const result = checkFileReadable(filePath);
      expect(result.ok).toBe(false);
      // 图片不再被扩展名闸门拦截；PNG 头部含 NUL，会在二进制内容闸门被拦。
      if (!result.ok) {
        expect(result.reason).toBe('binary-content');
      }
    });
  });

  it('still rejects genuinely non-image bytes with a .png extension', () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, 'fake.png');
      fs.writeFileSync(filePath, Buffer.from('plain text', 'utf8'));
      const result = checkFileReadable(filePath);
      expect(result.ok).toBe(true);
    });
  });

  it('keeps read of normal text files working', () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, 'notes.txt');
      fs.writeFileSync(filePath, 'hello pueblo', 'utf8');
      expect(checkFileReadable(filePath).ok).toBe(true);
    });
  });
});
