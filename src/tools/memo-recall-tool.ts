/**
 * MemoRecallTool — implements the `memo_recall` tool for searching
 * recent MemoryStore entries by keyword.
 *
 * Phase 1: fuzzy (case-insensitive substring) mode only.
 * Phase 2 (deferred): exact, semantic modes.
 * Phase 3 (deferred): already_in_context dedup.
 */

import type { MemoryQueries } from '../memory/memory-queries.js';
import type { MemoryRecord } from '../shared/schema.js';

// ── Request / Response types ──────────────────────────────────────────────

/** Matches the zod schema in provider-adapter.ts */
export interface MemoRecallRequest {
  keyword: string;
  turn_count: number;
  mode?: 'exact' | 'fuzzy' | 'semantic';
}

export interface MemoRecallHit {
  turn: number; // 1-based index, most recent = 1
  memo: string; // title + content snippet
  relevance: number; // 0-1 score
}

export interface MemoRecallResult {
  hits: MemoRecallHit[];
  already_in_context: boolean[]; // Phase 3; always false for now
}

// ── Tool ──────────────────────────────────────────────────────────────────

export class MemoRecallTool {
  constructor(private readonly queries: MemoryQueries) {}

  /**
   * Execute a keyword search against the MemoryStore with optional
   * recency limiting via `turn_count`.
   */
  async execute(request: MemoRecallRequest): Promise<MemoRecallResult> {
    const { keyword, turn_count } = request;
    const mode = request.mode ?? 'fuzzy';

    // Phase 1: only fuzzy mode is implemented
    if (mode !== 'fuzzy') {
      // Fall back to fuzzy for unimplemented modes
      // Phase 2 will add exact/semantic
    }

    // 1. Search MemoryStore with case-insensitive substring match
    const rawMatches = this.queries.searchMemories(keyword);

    // 2. Sort by recency (createdAt descending) and take top turn_count
    const sorted = [...rawMatches].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    const limited = sorted.slice(0, Math.max(0, turn_count));

    // 3. Build hits
    const hits: MemoRecallHit[] = limited.map((record, index) => ({
      turn: index + 1, // 1-based recency index; Phase 3 improves this
      memo: formatMemoSnippet(record),
      relevance: computeRelevance(keyword, record),
    }));

    return {
      hits,
      already_in_context: hits.map(() => false), // Phase 3
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatMemoSnippet(record: MemoryRecord): string {
  const title = record.title;
  const contentPreview =
    record.content.length > 200
      ? record.content.slice(0, 200) + '...'
      : record.content;
  return `[${record.memoryKind}] ${title}: ${contentPreview}`;
}

function computeRelevance(keyword: string, record: MemoryRecord): number {
  const q = keyword.toLowerCase();
  const title = record.title.toLowerCase();
  const content = record.content.toLowerCase();

  // Exact match in title = highest score
  if (title.includes(q)) {
    return title === q ? 1.0 : 0.9;
  }

  // Substring match in content
  if (content.includes(q)) {
    // Shorter records with the keyword earlier get higher scores
    const firstIndex = content.indexOf(q);
    const positionBoost = Math.max(0, 1.0 - firstIndex / content.length);
    return 0.7 + positionBoost * 0.2;
  }

  // Shouldn't reach here since searchMemories already filters, but be safe
  return 0.3;
}
