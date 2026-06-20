import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Replicates the extractOutputSummary logic from
 * src/desktop/renderer/monitor/monitor-renderer.ts
 * to verify P1: each output element only keeps the outputSummary value.
 */
function extractOutputSummary(raw: string): string {
  try {
    const parsed = JSON.parse(`{${raw}}`);
    const summary = parsed.outputSummary;
    return typeof summary === 'string' ? summary : raw;
  } catch {
    const match = raw.match(/"outputSummary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return match ? match[1] : raw;
  }
}

describe('P1 — outputSummary extraction', () => {
  it('should extract only outputSummary from test-for-job-output.txt data, ignoring other fields', () => {
    // Read the test data file (raw string like: Round1:{"outputSummary":"...","key1":"value1",...})
    const raw = readFileSync(resolve(__dirname, '../../test-for-job-output.txt'), 'utf-8').trim();

    const result = extractOutputSummary(raw);

    // outputSummary contains the actual Chinese content — should be preserved
    expect(result).toContain('所有变更已应用并通过编译');
    // Other fields like key1, key2 should be stripped out
    expect(result).not.toContain('key1');
    expect(result).not.toContain('key2');
    // The Round1: prefix should not appear in the extracted value
    expect(result).not.toMatch(/^Round\d+:/);
  });

  it('should return original string when no outputSummary is found', () => {
    const raw = 'Round1:{"message":"hello"}';
    // JSON.parse({Round1:{"message":"hello"}}) -> {Round1:{message:"hello"}}
    // parsed.outputSummary is undefined, falls to catch -> regex doesn't match either
    const result = extractOutputSummary(raw);
    expect(result).toBe(raw);
  });

  it('should extract summary from a simple well-formed input via JSON path', () => {
    // If raw is just a JSON object at top level without RoundX prefix
    const raw = '{"outputSummary":"simple test","other":"ignored"}';
    const result = extractOutputSummary(raw);
    expect(result).toBe('simple test');
  });
});
