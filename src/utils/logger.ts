/**
 * Unified logger for Pueblo.
 *
 * ## Directory structure
 *   .logs/{domain}/{domain}-{YYYY-MM-DD}.log   (text)
 *   .logs/{domain}/{domain}-{YYYY-MM-DD}.jsonl  (LLM NDJSON)
 *
 * ## Line format (text)
 *   {ISO_TIMESTAMP} [{LEVEL}] [{DOMAIN}] {MESSAGE}
 *
 * ## Retention (see DEFAULT_RETENTION)
 *   llm: 7 days / 512 MB; channel/amber: 14 days / 128 MB; perf: 7 days / 128 MB;
 *   app: 30 days / 128 MB; session: 90 days / 128 MB
 *
 * ## Usage
 *   const logger = new Logger('channel');
 *   logger.info('Connection established');
 *   logger.error('Connection failed', { err });
 *   logger.llmInteraction({ model: 'deepseek-v3', tokens: 1234, ... });
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export type LogDomain = 'app' | 'llm' | 'channel' | 'amber' | 'perf' | 'session';

export interface RetentionPolicy {
  /** Number of days to keep log files. */
  days: number;
  /** Maximum total size in megabytes for the domain directory. */
  maxSizeMB: number;
}

export const DEFAULT_RETENTION: Record<LogDomain, RetentionPolicy> = {
  app:     { days: 30, maxSizeMB: 128 },
  llm:     { days:  7, maxSizeMB: 512 },
  channel: { days: 14, maxSizeMB: 128 },
  amber:   { days: 14, maxSizeMB: 128 },
  perf:    { days:  7, maxSizeMB: 128 },
  session: { days: 90, maxSizeMB: 128 },
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]:  1,
  [LogLevel.WARN]:  2,
  [LogLevel.ERROR]: 3,
};

const DEFAULT_LOG_DIR = '.logs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function today(): string {
  return isoNow().slice(0, 10); // YYYY-MM-DD
}

function formatLine(level: LogLevel, domain: LogDomain, message: string): string {
  return `${isoNow()} [${level}] [${domain}] ${message}\n`;
}

function mkdirpSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  readonly domain: LogDomain;
  private level: LogLevel;
  private logDir: string;

  constructor(domain: LogDomain, opts?: { level?: LogLevel; logDir?: string }) {
    this.domain = domain;
    this.level = opts?.level ?? (process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO);
    this.logDir = path.resolve(opts?.logDir ?? DEFAULT_LOG_DIR);
    mkdirpSync(path.join(this.logDir, this.domain));
  }

  // ---- public severity methods ----

  debug(message: string, _data?: unknown): void {
    this.append(LogLevel.DEBUG, message);
  }

  info(message: string, _data?: unknown): void {
    this.append(LogLevel.INFO, message);
  }

  warn(message: string, _data?: unknown): void {
    this.append(LogLevel.WARN, message);
  }

  error(message: string, _data?: unknown): void {
    this.append(LogLevel.ERROR, message);
  }

  // ---- domain-specific convenience methods ----

  /** Log a performance measurement.  Appends to the perf text log. */
  perf(label: string, durationMs: number, extra?: string): void {
    const msg = `${label} | ${durationMs.toFixed(1)}ms${extra ? ` | ${extra}` : ''}`;
    this.append(LogLevel.INFO, msg);
  }

  /** Log an LLM interaction as a single NDJSON line. */
  llmInteraction(record: Record<string, unknown>): void {
    const logPath = this.getPath('jsonl');
    const line = JSON.stringify({
      timestamp: isoNow(),
      level: LogLevel.INFO,
      domain: this.domain,
      ...record,
    }) + '\n';
    try {
      fs.appendFileSync(logPath, line, 'utf-8');
    } catch {
      // silently ignore write failures
    }
  }

  // ---- cleanup ----

  /** Remove files older than the retention period; then enforce size cap. */
  cleanup(now: Date = new Date()): void {
    const policy = DEFAULT_RETENTION[this.domain];
    const domainDir = path.join(this.logDir, this.domain);
    if (!fs.existsSync(domainDir)) return;

    let files: { name: string; fullPath: string; mtimeMs: number; size: number }[];
    try {
      files = fs.readdirSync(domainDir)
        .map((name) => ({ name, fullPath: path.join(domainDir, name) }))
        .filter((f) => f.name.endsWith('.log') || f.name.endsWith('.jsonl'))
        .map((f) => {
          const stat = fs.statSync(f.fullPath);
          return { ...f, mtimeMs: stat.mtimeMs, size: stat.size };
        });
    } catch {
      return;
    }

    // 1) Age-based removal
    const cutoffMs = now.getTime() - policy.days * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (file.mtimeMs < cutoffMs) {
        try { fs.unlinkSync(file.fullPath); } catch { /* ignore */ }
      }
    }

    // 2) Size-based removal (oldest first)
    const remaining = files.filter((f) => fs.existsSync(f.fullPath)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);
    const maxBytes = policy.maxSizeMB * 1024 * 1024;
    for (const file of remaining) {
      if (totalSize <= maxBytes) break;
      totalSize -= file.size;
      try { fs.unlinkSync(file.fullPath); } catch { /* ignore */ }
    }
  }

  /** Run cleanup across all known domains.  Call once at startup. */
  static cleanupAll(logDir?: string, now?: Date): void {
    const dir = path.resolve(logDir ?? DEFAULT_LOG_DIR);
    const domains: LogDomain[] = ['app', 'llm', 'channel', 'amber', 'perf', 'session'];
    for (const domain of domains) {
      // lightweight: just run cleanup without keeping logger instances
      const domainDir = path.join(dir, domain);
      if (!fs.existsSync(domainDir)) continue;
      const policy = DEFAULT_RETENTION[domain];
      const nowDate = now ?? new Date();
      const cutoffMs = nowDate.getTime() - policy.days * 24 * 60 * 60 * 1000;
      const maxBytes = policy.maxSizeMB * 1024 * 1024;

      let files: { fullPath: string; mtimeMs: number; size: number }[];
      try {
        files = fs.readdirSync(domainDir)
          .map((name) => ({ name, fullPath: path.join(domainDir, name) }))
          .filter((f) => f.name.endsWith('.log') || f.name.endsWith('.jsonl'))
          .map((f) => {
            const stat = fs.statSync(f.fullPath);
            return { fullPath: f.fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
          });
      } catch {
        continue;
      }

      // Age-based
      for (const file of files) {
        if (file.mtimeMs < cutoffMs) {
          try { fs.unlinkSync(file.fullPath); } catch { /* ignore */ }
        }
      }

      // Size-based
      const remaining = files.filter((f) => fs.existsSync(f.fullPath)).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let totalSize = remaining.reduce((s, f) => s + f.size, 0);
      for (const file of remaining) {
        if (totalSize <= maxBytes) break;
        totalSize -= file.size;
        try { fs.unlinkSync(file.fullPath); } catch { /* ignore */ }
      }
    }
  }

  // ---- internal ----

  private getPath(ext: 'log' | 'jsonl'): string {
    return path.join(this.logDir, this.domain, `${this.domain}-${today()}.${ext}`);
  }

  private append(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = formatLine(level, this.domain, message);
    try {
      fs.appendFileSync(this.getPath('log'), line, 'utf-8');
    } catch {
      // silently ignore write failures
    }
  }
}

// ---------------------------------------------------------------------------
// Domain singletons — reuse these instead of creating new Logger instances
// ---------------------------------------------------------------------------

export const appLogger     = new Logger('app');
export const llmLogger     = new Logger('llm');
export const channelLogger = new Logger('channel');
export const amberLogger   = new Logger('amber');
export const perfLogger    = new Logger('perf');
export const sessionLogger = new Logger('session');
