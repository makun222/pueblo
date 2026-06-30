/**
 * Minimal performance logger for getRuntimeStatus bottleneck analysis.
 * Writes to .logs/perf-{date}.log in the workspace root.
 * Zero dependencies —uses synchronous fs writes to avoid delaying the process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PERF_LOG_DIR = '.logs';

function getLogPath(): string {
  const root = process.cwd();
  const dir = path.join(root, PERF_LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `perf-${date}.log`);
}

function now(): number {
  return performance.now();
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function perfLog(label: string, ms: number, extra?: string): void {
  const line = `[${ts()}] ${label} | ${ms.toFixed(1)}ms${extra ? ` | ${extra}` : ''}\n`;
  try {
    fs.appendFileSync(getLogPath(), line, 'utf-8');
  } catch {
    // silently ignore write failures
  }
}

export function perfStart(label: string): number {
  const t = now();
  const line = `[${ts()}] START: ${label}\n`;
  try {
    fs.appendFileSync(getLogPath(), line, 'utf-8');
  } catch { /* ignore */ }
  return t;
}

export function perfEnd(label: string, start: number, extra?: string): void {
  const elapsed = now() - start;
  perfLog(`END: ${label}`, elapsed, extra);
}

// ---------------------------------------------------------------------------
// General-purpose Amber run logger -- writes to .logs/amber-{date}.log
// ---------------------------------------------------------------------------

function getAmberLogPath(): string {
  const root = process.cwd();
  const dir = path.join(root, PERF_LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, 'amber-' + date + '.log');
}

export function amberLog(level: 'info' | 'warn' | 'error', message: string): void {
  const line = '[' + ts() + '][' + level.toUpperCase() + '] ' + message + "\n";
  try {
    fs.appendFileSync(getAmberLogPath(), line, 'utf-8');
  } catch {
    // silently ignore write failures
  }
}