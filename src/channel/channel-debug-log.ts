/**
 * Channel troubleshooting debug logger.
 * Writes to .logs/channel-debug-{date}.log in process.cwd().
 * Mirrors the pattern of src/utils/perf-logger.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_DIR = '.logs';

function getLogPath(): string {
  const root = process.cwd();
  const dir = path.join(root, LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `channel-debug-${date}.log`);
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function channelDebugLog(message: string): void {
  const line = `[${ts()}] ${message}\n`;
  try {
    fs.appendFileSync(getLogPath(), line, 'utf-8');
  } catch {
    // silently ignore write failures
  }
}
