/**
 * LLM response logger — wraps the unified Logger for NDJSON-format LLM
 * interaction logging.
 *
 * Output directory: .logs/llm/llm-{YYYY-MM-DD}.jsonl  (single NDJSON file per day).
 *
 * Maintains backward-compatible createLlmResponseLogger / LlmResponseLogger types.
 */

import { llmLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmResponseLogEntry = Record<string, unknown>;

export type LlmResponseLogger = {
  log: (entry: LlmResponseLogEntry) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLlmResponseLogger(_options?: { baseDir?: string }): LlmResponseLogger {
  return {
    async log(entry: LlmResponseLogEntry): Promise<void> {
      llmLogger.llmInteraction(entry);
    },
  };
}
