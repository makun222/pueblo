import { type CommandResult, successResult, failureResult } from '../shared/result.js';

export type CallModelFn = (modelId: string, prompt: string) => Promise<string>;

/**
 * Uses an LLM to validate whether a goal is specific, actionable, and well-defined.
 * Returns { valid, reason } where valid=false means the goal is too vague.
 */
export async function guardVagueGoal(
  goal: string,
  modelId: string,
  callModel: CallModelFn,
): Promise<CommandResult<{ valid: boolean; reason: string }>> {
  try {
    const prompt = `You are a goal validation assistant. Evaluate if the following goal is specific, actionable, and well-defined for an AI coding task.
Respond with a JSON object (no markdown):
{"valid": boolean, "reason": string}
- valid: true if the goal describes a concrete, actionable task with clear requirements
- valid: false if the goal is too vague, ambiguous, or lacks clear direction
- reason: brief explanation of why the goal passes or fails validation. be constructive.

Goal: ${goal}`;

    const response = await callModel(modelId, prompt);
    const cleaned = response.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.valid !== 'boolean' || typeof parsed.reason !== 'string') {
      return failureResult('PARSE_ERROR', 'Invalid response format from validation LLM') as CommandResult<{ valid: boolean; reason: string }>;
    }
    return successResult('OK', 'Goal is valid', { valid: parsed.valid, reason: parsed.reason });
  } catch (err) {
    return failureResult('VALIDATION_FAILED', `Goal validation failed: ${err instanceof Error ? err.message : String(err)}`) as CommandResult<{ valid: boolean; reason: string }>;
  }
}
