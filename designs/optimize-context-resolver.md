# Optimize context-resolver.ts — Fix Context Stickiness & Related Issues

## Problem Summary

`context-resolver.ts` has several interconnected issues causing **4 failing tests** and degraded context quality:

1. **`selectForContext` pipeline conflict** — The `memoryService.selectForContext()` call applies its own weight-threshold filtering and priority-agnostic sorting, which conflicts with Pepe's stickiness-aware ranking and silently drops priority-tagged memories.
2. **Session messages not windowed** — `taskContext.sessionMessages` returns the full message history instead of the recent window, bloating context.
3. **Disabled feature with stale test** — `activeTurnStepContext` is disabled (`//0614-zero`) but its test still expects active behavior.
4. **Dead code accumulation** — Multiple unused helper functions and commented-out code blocks.

### Failing Tests (4/17)

| # | Test Name | Root Cause |
|---|-----------|-----------|
| 1 | `surfaces active turn step context...` | `activeTurnStepContext` hardcoded to `null`; test expects non-null |
| 2 | `sorts general result items by memory weight and then updatedAt` | `selectForContext` sorts by its own criteria, not by weight → updatedAt |
| 3 | `prefers priority-tagged memories during sorting and truncation` | `selectForContext` weight filter drops `priority:critical` items with low weight |
| 4 | `keeps only the recent context window from large session histories` | `sessionMessages` passes full history (24 messages), test expects 6 |

---

## Phase 1: Replace `selectForContext` with Inline Dedup + Sort

**Files**: `src/agent/context-resolver.ts`

### What's Wrong

Lines 296-311 call `memoryService.selectForContext()` with `totalBudget: Number.MAX_SAFE_INTEGER`, meaning truncation is skipped and it only serves as a dedup+sort step. But its internal pipeline:
- **Weight-threshold filter**: Removes memories with weight below a category-specific threshold. This drops `priority:critical` tagged memories that have low weight (e.g., 0.1), breaking the priority test.
- **Sort by priority+weight only**: Doesn't sort by `updatedAt` as tiebreaker, breaking the weight-sort test.
- **Ignores Pepe ranking scores**: The stickiness-aware ranking from Pepe is overridden by a different sort order.

### Fix

Replace the `selectForContext` call (lines 296-314) with inline logic:

1. **Dedup by memory ID**: Use a `Set<string>` to ensure each memory appears only once.
2. **Dedup by content hash**: Use a `Map<string, MemoryRecord>` to keep only the first memory per hash (backward-compatible with null hashes).
3. **Sort using `comparePromptMemories`** (already defined at line 665): Sorts by priority rank → weight → updatedAt → createdAt, which matches all test expectations.
4. **Map the sorted memory order back to result items** to produce `prioritizedResultItems`.

This removes the `await` keyword from `resolve()` (since `selectForContext` was the only async call), making the method synchronous.

### Impact
- Fixes tests #2 and #3
- Preserves `priority:critical` memories regardless of weight
- Restores correct weight → updatedAt sort order
- Removes dependency on `memoryService.selectForContext` for this code path

---

## Phase 2: Fix Session Messages Windowing

**Files**: `src/agent/context-resolver.ts`

### What's Wrong

Line 199: `const sessionMessages = session?.messageHistory ?? [];` passes the **full** message history into `TaskContext.sessionMessages`. The test expects only the last `RECENT_CONTEXT_MESSAGE_LIMIT` (6) messages.

The `recentMessages` field is computed from `selectRecentContextMessages(sessionMessages)` which does turn-based grouping, but the test expects individual formatted messages with 1:1 correspondence to `sessionMessages`.

### Fix

1. **Limit `sessionMessages`**: After computing the full history, slice to the last `RECENT_CONTEXT_MESSAGE_LIMIT` messages:
   ```typescript
   const allSessionMessages = session?.messageHistory ?? [];
   const sessionMessages = allSessionMessages.slice(-RECENT_CONTEXT_MESSAGE_LIMIT);
   ```

2. **Simplify `recentMessages`**: Format the limited messages individually using `formatSessionMessageForContext`:
   ```typescript
   const recentMessages = sessionMessages.map(formatSessionMessageForContext);
   ```

3. **Keep `selectRecentContextMessages` for prompt construction** (used by `selectRecentMessagesForPrompt`), but pass the full history to it for turn-aware formatting in the prompt builder:
   ```typescript
   const promptRecentMessages = selectRecentMessagesForPrompt(
     selectRecentContextMessages(allSessionMessages),
   );
   ```

4. **Update target directory scanning** to use the full history (not the windowed messages) since target directory extraction needs to look back further:
   ```typescript
   const targetDirectory = resolveTargetDirectory({
     pendingUserInput: input.pendingUserInput,
     recentUserMessages: selectRecentUserMessagesForTargetDirectory(allSessionMessages),
     workspace: input.workspace ?? input.cwd ?? null,
   });
   ```

### Impact
- Fixes test #4
- Reduces context size by limiting raw session messages to the recent window
- Maintains backward compatibility for prompt building and target directory extraction

---

## Phase 3: Update Disabled `activeTurnStepContext` Test

**Files**: `tests/unit/context-resolver.test.ts`

### What's Wrong

The `activeTurnStepContext` feature was intentionally disabled (lines 214-223, marked `//0614-zero`). The test at line 164 still expects:
- `selectedStepSummaryCount` to be 1
- `activeTurnStepContext` to contain content

### Fix

Update the test to match the disabled state:
```typescript
expect(resolved.runtimeStatus.selectedStepSummaryCount).toBe(0);
expect(resolved.taskContext.activeTurnStepContext).toBeNull();
// Keep compactContextMode check — it's independent of step context
expect(resolved.runtimeStatus.compactContextMode).toBe(true);
```

Also clean up the disabled code in `context-resolver.ts`:
- Replace the commented-out block (lines 214-223) with a clear TODO comment and the null assignment:
  ```typescript
  // TODO: Re-enable active turn step context when step summarization is stabilized.
  const activeTurnStepContext = null;
  const selectedStepSummaryCount = 0;
  ```

### Impact
- Fixes test #1
- Removes confusing commented-out code
- Preserves the feature flag approach for future re-enablement

---

## Phase 4: Remove Dead Code

**Files**: `src/agent/context-resolver.ts`

### Unused Functions to Remove

These functions are defined but never called (confirmed via grep):

| Function | Lines | Reason |
|----------|-------|--------|
| `sortResultItemsForPrompt` | 646-659 | Was replaced by `selectForContext` pipeline; now replaced by inline logic |
| `sortMemoriesForPrompt` | 661-663 | Never called anywhere |
| `dedupeMemoriesById` | 703-717 | Replaced by inline dedup in `selectSessionSummariesForPrompt` |
| `dedupeMemoriesByContentHash` | 719-736 | Same — replaced by inline dedup |

### Commented-Out Code to Clean Up

| Location | Code | Action |
|----------|------|--------|
| Lines 943-944 | `.slice(0, 1000)` for user messages | Remove commented lines |
| Lines 950-951 | `.slice(0, 50000)` for assistant messages | Remove commented lines |
| Line 379 | `//const selectedStepSummaryCount = ...//0614-zero` | Remove (consolidated in Phase 3) |

### Impact
- ~90 lines of dead code removed
- Cleaner, more maintainable file

---

## Phase 5: Reduce Redundant Memory Lookups

**Files**: `src/agent/context-resolver.ts`

### What's Wrong

`resolveMemorySelection` is called multiple times with overlapping IDs:
1. **Inside `PepeResultService.resolve()`** (line 34 of pepe-result-service.ts) — resolves `effectiveSelectedMemoryIds`
2. **Line 259**: `memoryService.resolveMemorySelection(effectiveSelectedMemoryIds)` — resolves same IDs again
3. **Line 261**: `memoryService.resolveMemorySelection(filteredResultItems.map(...))` — resolves a subset

### Fix

1. Access the `sourceMemories` from `resolvedPepeResult.sourceMemories` instead of re-resolving `effectiveSelectedMemoryIds` at line 259.
2. Build a `Map<string, MemoryRecord>` from `sourceMemories` and use it for both `selectedMemories` and `resultItemMemories` lookups:
   ```typescript
   const sourceMemoryMap = new Map(
     resolvedPepeResult.sourceMemories.map(m => [m.id, m])
   );
   const selectedMemories = effectiveSelectedMemoryIds
     .map(id => sourceMemoryMap.get(id))
     .filter((m): m is MemoryRecord => m !== undefined && !m.tags.includes('task-step-summary'));
   const resultItemMemories = filteredResultItems
     .map(item => sourceMemoryMap.get(item.memoryId))
     .filter((m): m is MemoryRecord => m !== undefined);
   ```

### Impact
- Eliminates 2 redundant memory resolution calls
- Same behavior, better performance

---

## Phase 6: Stickiness Configuration Issue (Recommendation)

**Files**: `src/shared/config.ts` (not code change, just noting)

### Issue

The default Pepe ranking config has:
- `similarityThreshold: 0.2` — normal selection threshold
- `minRetentionSimilarity: 0.35` — hard floor for sticky retention

Since `minRetentionSimilarity > similarityThreshold`, the retention floor for sticky memories (0.35) is actually **stricter** than the normal threshold (0.2). This means:
- A non-sticky memory with similarity 0.25 passes the primary filter (>= 0.2)
- A sticky memory with similarity 0.25 would NOT be retained (< 0.35)

The stickiness mechanism only helps memories that drop below 0.2 similarity but above 0.35 — which is an empty range.

### Recommendation

Either:
- Lower `minRetentionSimilarity` to below `similarityThreshold` (e.g., 0.1), OR
- Add a runtime validation that warns if `minRetentionSimilarity > similarityThreshold`

This is a config/tuning change and should be considered separately from the code optimization.

---

## Execution Order

1. **Phase 1** (selectForContext replacement) — highest impact, fixes 2 tests
2. **Phase 2** (session messages windowing) — fixes 1 test
3. **Phase 3** (test update for disabled feature) — fixes 1 test
4. **Phase 4** (dead code removal) — cleanup
5. **Phase 5** (redundant lookups) — performance
6. **Phase 6** (config recommendation) — separate follow-up

## Verification

After all phases, run: `npx vitest run tests/unit/context-resolver.test.ts`
Expected: all 17 tests passing (currently 13/17).
