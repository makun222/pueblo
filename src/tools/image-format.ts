import fs from 'node:fs';
import path from 'node:path';

/**
 * 图片格式识别与预算常量。
 *
 * 供 file-guard / read-tool / 目录自动注入（Phase3）共用：统一按 magic bytes
 * 判定真实格式，避免信任扩展名或 MIME。
 */

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 单张图片体积上限，与 DeepSeek vision 的 32 MiB 单图上限对齐。 */
export const MAX_VISION_IMAGE_BYTES = 32 * 1024 * 1024;

export interface DetectedImageFormat {
  readonly mimeType: string;
  readonly extension: string;
}

export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * 按 magic bytes 判定图片真实格式；不是受支持的图片则返回 null。
 * 支持 PNG / JPEG / GIF87a / GIF89a / WebP(RIFF....WEBP)。
 */
export function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: '.png' };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }

  if (buffer.length >= 6) {
    const signature = buffer.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { mimeType: 'image/gif', extension: '.gif' };
    }
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }

  return null;
}

export function toImageDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export interface ImageProbeResult {
  readonly ok: true;
  readonly mimeType: string;
  readonly extension: string;
  readonly sizeBytes: number;
}

export type ImageProbe =
  | ImageProbeResult
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-a-file' | 'too-large' | 'unsupported-image-bytes' | 'open-failed';
      readonly detail?: string;
    };

/**
 * 探测一个图片文件：stat 大小闸门 → 读前 16 字节 → magic bytes 校验。
 * 判定结果只依赖文件内容，不信任扩展名。
 */
export function probeImageFileSync(absPath: string, maxBytes: number = MAX_VISION_IMAGE_BYTES): ImageProbe {
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!st.isFile()) {
    return { ok: false, reason: 'not-a-file' };
  }
  if (st.size > maxBytes) {
    return { ok: false, reason: 'too-large', detail: `${st.size} bytes` };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    const detected = detectImageFormat(header.subarray(0, bytesRead));
    if (!detected) {
      return { ok: false, reason: 'unsupported-image-bytes' };
    }
    return { ok: true, mimeType: detected.mimeType, extension: detected.extension, sizeBytes: st.size };
  } catch (err) {
    return { ok: false, reason: 'open-failed', detail: (err as Error).message };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function isImagePath(filePath: string): boolean {
  return isImageExtension(path.extname(filePath).toLowerCase());
}
