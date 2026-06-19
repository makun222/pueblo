/**
 * Guards against short/vague user inputs by injecting clarification
 * instructions when the goal text is suspiciously brief.
 *
 * @param text - The user's input text, already trimmed.
 * @returns The original text, or text prefixed with a system preamble
 *          if the input was too short/vague.
 */
export const VAGUE_GOAL_MIN_LENGTH = 25;

export function guardVagueGoal(text: string): string {
  if (text.trim().length < VAGUE_GOAL_MIN_LENGTH) {
    return `[Clarification: The following user request is very brief. If its intent is unclear, you MUST ask clarifying questions instead of making assumptions or guessing.]\n\n${text}`;
  }
  return text;
}
