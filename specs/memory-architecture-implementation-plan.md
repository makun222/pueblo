# Memory Architecture Implementation Plan

## Objectives
- Replace append-only session memory growth with a layered model for short-term, mid-term, and long-term memory.
- Move memory weight behavior out of hardcoded constants and into configuration-driven policy.
- Support memory weight changes through reusable service APIs so future non-CLI channels can adjust weights.
- Stop Pepe from generating duplicate summaries and from summarizing step-level memory.

## Target Model
- Short-term context: transient step context for the active turn only. Do not persist step summaries into `memory_records`.
- Mid-term context: active turn memories with configurable weight decay plus a single session summary memory updated in place.
- Long-term context: pinned knowledge, workflow references, and reusable experience memories.

## Required Measures
- Keep the earlier 1-6 safeguards:
  - session-level Pepe flush lock
  - summary creation idempotency per session/parent/summary kind
  - Pepe only summarizes original turn memories
  - selected memory handling stops being append-only for auto-captured entries
  - turn numbering is based on real turns, not memory count
  - short-lived step context no longer accumulates in persistent memory
- Add configurable memory weight policy and public service operations for set/increase/decrease/decay.

## Phase 1: Foundation And Stopgap
- Add `memory` config section with weight policy settings for turns, session summary, and future extensibility.
- Add `weight`, `memoryKind`, and `lastAccessedAt` to the memory schema and persistence layer.
- Add memory service APIs for creating and updating weights without tying the implementation to CLI commands.
- Add a CLI command surface for memory weight operations as one channel, while keeping service APIs reusable for later channels.
- Add Pepe flush in-flight protection and idempotent summary creation.
- Restrict Pepe summarization to root turn memories only.

## Phase 2: Session Summary Model
- Introduce a single session summary memory per session.
- Update summary merge logic to refresh the existing summary memory in place instead of creating chained summary rows.
- Add weight decay/merge rules for turn memories driven by configuration.

## Phase 3: Context Selection Refactor
- Separate pinned memory from auto-managed working memory.
- Build context from:
  - system/profile/workflow prompts
  - active weighted turn memories above threshold
  - current session summary memory
  - transient active-turn step context
- Remove dependency on persistent task-step-summary memories in runtime status and renderer-facing stats.

## Phase 4: Data Migration And Cleanup
- Migrate existing rows to populate new memory columns.
- Deduplicate active Pepe summaries by parent.
- Normalize old turn memories away from `derivationType=summary`.
- Shrink historical selected memory chains to pinned or still-active entries.

## Acceptance Criteria
- No session can produce multiple active Pepe summaries for the same parent memory.
- Pepe never summarizes step memory or any child memory.
- Memory weight behavior is configuration-driven, not hardcoded in ranking or service logic.
- Memory weight can be updated through service APIs and at least one command surface.
- The 4264-memory sample session can be migrated without retaining repeated Pepe summary rows.