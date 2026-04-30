import fs from 'node:fs';
import path from 'node:path';

export interface LlmResponseLoggerOptions {
  readonly baseDir?: string;
  readonly now?: () => Date;
}

export interface LlmResponseLogEntry {
  readonly providerId: string;
  readonly category: string;
  readonly message: string;
  readonly requestUrl?: string;
  readonly modelId?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseText?: string;
  readonly payload?: unknown;
  readonly details?: unknown;
}

export interface LlmResponseLogger {
  log(entry: LlmResponseLogEntry): void;
}

export function createLlmResponseLogger(options: LlmResponseLoggerOptions = {}): LlmResponseLogger {
  const baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'llmRespons');
  const now = options.now ?? (() => new Date());

  return {
    log(entry: LlmResponseLogEntry): void {
      try {
        fs.mkdirSync(baseDir, { recursive: true });

        const timestamp = now();
        const isoTimestamp = timestamp.toISOString();
        const fileName = `${toFileSafeTimestamp(isoTimestamp)}-${sanitizeSegment(entry.providerId)}-${sanitizeSegment(entry.category)}.json`;
        const filePath = path.join(baseDir, fileName);

        fs.writeFileSync(filePath, JSON.stringify({
          timestamp: isoTimestamp,
          ...entry,
          payload: normalizeUnknown(entry.payload),
          details: normalizeUnknown(entry.details),
        }, null, 2), 'utf8');
      } catch {
        // Logging must never break provider execution.
      }
    },
  };
}

function normalizeUnknown(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeUnknown(nestedValue)]),
    );
  }

  return value ?? null;
}

function sanitizeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'entry';
}

function toFileSafeTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-');
}