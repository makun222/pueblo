/**
 * Performance & Amber logger — wraps the unified Logger with backward-compatible
 * function signatures.
 *
 * Output directory: .logs/perf/  and  .logs/amber/  (daily-rolled).
 */

import { perfLogger, amberLogger } from './logger.js';

// ---------------------------------------------------------------------------
// perfLog — daily-rolled text (was single-run file per start, now unified)
// ---------------------------------------------------------------------------

export function perfLog(label: string, ms: number, extra?: string): void {
  perfLogger.perf(label, ms, extra);
}

// ---------------------------------------------------------------------------
// perfStart / perfEnd — in-memory timer
// ---------------------------------------------------------------------------

export function perfStart(_label: string): number {
  return performance.now();
}

export function perfEnd(label: string, start: number, extra?: string): void {
  const elapsed = performance.now() - start;
  perfLogger.perf(`END: ${label}`, elapsed, extra);
}

// ---------------------------------------------------------------------------
// amberLog — backward-compatible amber pipeline logger
// ---------------------------------------------------------------------------

export function amberLog(level: 'info' | 'warn' | 'error', message: string): void {
  switch (level) {
    case 'error': amberLogger.error(message); break;
    case 'warn':  amberLogger.warn(message);  break;
    default:      amberLogger.info(message);  break;
  }
}
