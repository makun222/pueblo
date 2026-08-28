/**
 * Centralized agent task-runner tuning constants.
 *
 * Every value is read from a `PUEBLO_*` environment variable at call time so
 * that tests and runtime overrides take effect without reloading the module.
 * See `.kilo/plans/tool-result-compression-loop-fix.md` for the full design.
 */

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** Hard ceiling on the number of model `runStep` calls per task round. */
export function getDefaultMaxAgentSteps(): number {
  return readNumberEnv('PUEBLO_MAX_AGENT_STEPS', 64);
}

/** Steps reserved near the end of the budget for the handoff/clarification flow. */
export function getStepBudgetFinalizationBuffer(): number {
  return readNumberEnv('PUEBLO_STEP_BUDGET_FINALIZATION_BUFFER', 6);
}

/** Strict repeated tool-loop guard (identical args + output). */
export function getRepeatedToolLoopLimit(): number {
  return readNumberEnv('PUEBLO_REPEATED_TOOL_LOOP_LIMIT', 6);
}

/** Intent-based loop guard (same tool + normalized intent, e.g. same path). */
export function getIntentLoopLimit(): number {
  return readNumberEnv('PUEBLO_INTENT_LOOP_LIMIT', 4);
}

/** Character cap applied to a tool `summary` before it reaches the model. */
export function getToolResultSummaryCharLimit(): number {
  return readNumberEnv('PUEBLO_TOOL_RESULT_SUMMARY_CHAR_LIMIT', 640);
}

/** Default number of output items kept for non-read tool previews. */
export function getDefaultToolPreviewItemLimit(): number {
  return readNumberEnv('PUEBLO_DEFAULT_TOOL_PREVIEW_ITEM_LIMIT', 12);
}

/** Number of output items kept for read tool previews. */
export function getReadToolPreviewItemLimit(): number {
  return readNumberEnv('PUEBLO_READ_TOOL_PREVIEW_ITEM_LIMIT', 24);
}

/**
 * Total character budget shared by all historical tool messages inside the
 * prompt. Tier A (most recent step) is excluded from this budget.
 */
export function getPromptToolResultBudgetChars(): number {
  return readNumberEnv('PUEBLO_PROMPT_TOOL_RESULT_BUDGET_CHARS', 60000);
}

/** Per-message preview character cap for Tier B (soft-retained) messages. */
export function getPerToolPreviewChars(): number {
  return readNumberEnv('PUEBLO_PER_TOOL_PREVIEW_CHARS', 1500);
}

/**
 * Per-message raw character cap applied at serialization time so a single
 * long `shell_exec` output cannot blow past the Tier A window on its own.
 */
export function getPerToolRawChars(): number {
  return readNumberEnv('PUEBLO_PER_TOOL_RAW_CHARS', 8000);
}

/** Whether Tier C compacted messages include a `hint` field. */
export function getTierCHintEnabled(): boolean {
  return readBooleanEnv('PUEBLO_TIER_C_HINT_ENABLED', true);
}

/**
 * Whether historical tool messages that reference the same path/pattern as
 * the latest assistant request get boosted into the Tier B budget.
 */
export function getLatestAssistantReferenceBoost(): boolean {
  return readBooleanEnv('PUEBLO_LATEST_ASSISTANT_REFERENCE_BOOST', true);
}

/**
 * Roll-back switch. When set to `legacy`, the old single-line
 * `执行结果已压缩：<summary>` compaction is used instead of the tiered
 * budget logic.
 */
export function isLegacyCompactMode(): boolean {
  return process.env.PUEBLO_COMPACT_MODE === 'legacy';
}
