import fs from 'node:fs';
import path from 'node:path';

/**
 * 文件可读性守卫：三道闸门（见 docs/llm-truncation-fix-plan.md）
 *  1. 扩展名黑名单（零系统调用）
 *  2. 大小限制（一次 stat，不读内容）
 *  3. 二进制内容探测（仅读前 8KB，含 NUL 字节即视为二进制）
 *
 * 目的：阻止 grep/read/glob 工具把超大文件或二进制文件完整读入并推给
 * LLM，导致结果被按行/字节截断，LLM 看到不完整内容。
 */

export const MAX_FILE_READ_BYTES = 100 * 1024 * 1024; // 100MB

export const UNREADABLE_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.mdb',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.woff', '.woff2', '.ttf', '.otf',
]);

export type FileGuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-found' | 'not-a-file' | 'too-large' | 'unreadable-extension' | 'binary-content' | 'open-failed';
      detail?: string;
    };

/**
 * 检查文件是否可安全读取。
 *
 * @param absPath  待检查的绝对路径
 * @param maxBytes 大小闸门阈值，默认 MAX_FILE_READ_BYTES（100MB），
 *                 测试可传入小阈值避免创建大文件。
 */
export function checkFileReadable(absPath: string, maxBytes: number = MAX_FILE_READ_BYTES): FileGuardResult {
  // 闸门一：扩展名黑名单（零系统调用）
  const ext = path.extname(absPath).toLowerCase();
  if (UNREADABLE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'unreadable-extension', detail: ext };
  }

  // 闸门二：大小限制（一次 stat，不读内容）
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

  // 闸门三：二进制内容探测（读前 8KB，含 NUL 即视为二进制）
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, bytesRead).includes(0)) {
      return { ok: false, reason: 'binary-content' };
    }
  } catch (err) {
    // stat 已通过但打开/读取失败（如权限错误、EMFILE），按不可读处理。
    return { ok: false, reason: 'open-failed', detail: (err as Error).message };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  return { ok: true };
}
