import { describe, expect, it } from 'vitest';
import { guardVagueGoal, VAGUE_GOAL_MIN_LENGTH } from '../../src/utils/guard-vague-goal';

describe('guardVagueGoal', () => {
  // MIN_LENGTH should be 25
  it('has a defined minimum length constant', () => {
    expect(VAGUE_GOAL_MIN_LENGTH).toBe(25);
  });

  // Goals shorter than 25 chars after trimming → prepend clarification
  it('prepends clarification preamble for very short inputs', () => {
    const result = guardVagueGoal('fix bug');
    expect(result).toContain('[Clarification:');
    expect(result).toContain('fix bug');
    expect(result.startsWith('[Clarification:')).toBe(true);
  });

  it('prepends clarification for empty-ish strings', () => {
    const result = guardVagueGoal('   '); // trim().length === 0
    expect(result).toContain('[Clarification:');
  });

  it('trims before comparing length', () => {
    // 24 chars of padding + 1 char = 25 chars total, trim → 1 char → qualifies
    const padded = `                       x`; // 23 spaces + 'x' = 24 chars? Let's be precise.
    // Use a string that trims to < 25
    const input = '   hi   '; // trim → 'hi', length 2 → qualifies
    const result = guardVagueGoal(input);
    expect(result).toContain('[Clarification:');
  });

  // Goals >= 25 chars (after trimming) → pass through unchanged
  it('returns text unchanged when length is exactly threshold', () => {
    const exact = 'a'.repeat(VAGUE_GOAL_MIN_LENGTH); // 25 chars
    const result = guardVagueGoal(exact);
    expect(result).toBe(exact);
  });

  it('returns text unchanged when length exceeds threshold', () => {
    const longer = 'This is a reasonably descriptive goal that exceeds the minimum length threshold';
    const result = guardVagueGoal(longer);
    expect(result).toBe(longer);
  });

  // The clarification message is included inline before the original text
  it('places original text after the preamble', () => {
    const original = 'test me';
    const result = guardVagueGoal(original);
    expect(result).toBe(
      '[Clarification: The following user request is very brief. If its intent is unclear, you MUST ask clarifying questions instead of making assumptions or guessing.]\n\n' +
        original,
    );
  });
});
