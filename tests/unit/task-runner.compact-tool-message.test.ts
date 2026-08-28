import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderMessage } from '../../src/providers/provider-adapter';
import {
  compactToTierB,
  compactToTierC,
  parseSerializedToolContent,
  prepareMessagesForModel,
  serializeToolResultForModel,
  truncateOutputForSerialization,
} from '../../src/agent/task-runner';
import type { ToolExecutionResult } from '../../src/tools/glob-tool';

function makeToolResult(
  toolName: ToolExecutionResult['toolName'],
  status: ToolExecutionResult['status'],
  summary: string,
  output: string[],
): ToolExecutionResult {
  return { toolName, status, summary, output };
}

function makeToolMessage(
  toolCallId: string,
  toolName: string,
  content: string,
): ProviderMessage {
  return { role: 'tool', content, toolCallId, toolName };
}

function makeAssistantMessage(toolCalls: ProviderMessage['toolCalls']): ProviderMessage {
  return { role: 'assistant', content: 'assistant rationale', toolCalls };
}

describe('compactSerializedToolMessage tiered compaction', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PUEBLO_COMPACT_MODE;
    delete process.env.PUEBLO_PROMPT_TOOL_RESULT_BUDGET_CHARS;
    delete process.env.PUEBLO_PER_TOOL_PREVIEW_CHARS;
    delete process.env.PUEBLO_PER_TOOL_RAW_CHARS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('compactToTierC', () => {
    it('produces structured JSON with status, summary, outputCount, and hint', () => {
      const parsed = {
        status: 'succeeded',
        summary: 'Read 30 line(s) from lines 1-30 src/foo.ts',
        output: Array.from({ length: 30 }, (_, i) => `${i + 1}: line content ${i}`),
      };

      const result = compactToTierC(parsed, 'read');
      const json = JSON.parse(result);

      expect(json.status).toBe('succeeded');
      expect(json.summary).toBe('Read 30 line(s) from lines 1-30 src/foo.ts');
      expect(json.outputCount).toBe(30);
      expect(json.compacted).toBe('tier-c');
      expect(json.hint).toContain('read');
      expect(json.hint).toContain('startLine/endLine');
    });

    it('omits hint when TIER_C_HINT_ENABLED is false', () => {
      process.env.PUEBLO_TIER_C_HINT_ENABLED = 'false';
      const parsed = {
        status: 'succeeded',
        summary: 'Read 30 line(s) from lines 1-30 src/foo.ts',
        output: ['1: line'],
      };

      const result = compactToTierC(parsed, 'read');
      const json = JSON.parse(result);

      expect(json.hint).toBeUndefined();
    });

    it('keeps the output under ~200 characters', () => {
      const parsed = {
        status: 'succeeded',
        summary: 'Read 30 line(s) from lines 1-30 src/foo.ts',
        output: Array.from({ length: 30 }, (_, i) => `${i + 1}: some line content here ${i}`),
      };

      const result = compactToTierC(parsed, 'read');
      expect(result.length).toBeLessThan(250);
    });
  });

  describe('compactToTierB', () => {
    it('produces a preview with head, tail, and omitted marker', () => {
      const output = Array.from({ length: 100 }, (_, i) => `${i + 1}: ${'x'.repeat(80)} line ${i}`);
      const parsed = {
        status: 'succeeded',
        summary: 'Read 100 line(s) from src/big.ts',
        output,
      };

      const result = compactToTierB(parsed);
      const json = JSON.parse(result);

      expect(json.status).toBe('succeeded');
      expect(json.summary).toBe('Read 100 line(s) from src/big.ts');
      expect(json.outputCount).toBe(100);
      expect(json.outputTruncated).toBe(true);
      expect(json.compression).toBe('tier-b');
      expect(json.outputPreview).toContain('omitted');
    });

    it('keeps the preview within the PER_TOOL_PREVIEW_CHARS budget', () => {
      process.env.PUEBLO_PER_TOOL_PREVIEW_CHARS = '300';
      const longLines = Array.from({ length: 200 }, (_, i) => `${i + 1}: ${'x'.repeat(50)}`);
      const parsed = {
        status: 'succeeded',
        summary: 'Read 200 line(s)',
        output: longLines,
      };

      const result = compactToTierB(parsed);
      const json = JSON.parse(result);

      expect(json.outputPreview.length).toBeLessThanOrEqual(400);
    });
  });

  describe('truncateOutputForSerialization (Tier A raw cap)', () => {
    it('passes through output within the budget', () => {
      const output = ['line1', 'line2', 'line3'];
      const result = truncateOutputForSerialization(output, 1000);
      expect(result).toEqual(output);
    });

    it('truncates output exceeding the budget with head + tail + omitted marker', () => {
      const output = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      const result = truncateOutputForSerialization(output, 200);

      expect(result.length).toBeLessThan(output.length);
      const omittedMarker = result.find((line) => line.includes('omitted'));
      expect(omittedMarker).toBeDefined();
      expect(result[0]).toBe('line-0');
      expect(result[result.length - 1]).toBe('line-99');
    });
  });

  describe('serializeToolResultForModel', () => {
    it('serializes a normal tool result without truncation', () => {
      const output = makeToolResult('read', 'succeeded', 'Read 3 line(s) from foo.txt', [
        '1: alpha',
        '2: beta',
        '3: gamma',
      ]);

      const serialized = serializeToolResultForModel(output);
      const parsed = parseSerializedToolContent(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.output).toEqual(['1: alpha', '2: beta', '3: gamma']);
    });

    it('truncates long shell_exec output at serialization time', () => {
      const longOutput = Array.from({ length: 500 }, (_, i) => `output line ${i}`);
      const output = makeToolResult('shell_exec', 'succeeded', 'Command completed', longOutput);

      process.env.PUEBLO_PER_TOOL_RAW_CHARS = '500';
      const serialized = serializeToolResultForModel(output);
      const parsed = parseSerializedToolContent(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.output.length).toBeLessThan(longOutput.length);
      expect(parsed!.output.some((line) => line.includes('omitted'))).toBe(true);
    });
  });

  describe('prepareMessagesForModel budgeted compaction', () => {
    it('keeps the trailing tool messages (Tier A) verbatim', () => {
      const toolResult = makeToolResult('read', 'succeeded', 'Read 3 line(s) from foo.txt', [
        '1: alpha',
        '2: beta',
        '3: gamma',
      ]);
      const serialized = serializeToolResultForModel(toolResult);

      const messages: ProviderMessage[] = [
        { role: 'user', content: 'read foo.txt' },
        makeAssistantMessage([{
          toolCallId: 'call-1',
          toolName: 'read',
          args: { path: 'foo.txt' } as any,
        }]),
        makeToolMessage('call-1', 'read', serialized),
      ];

      const prepared = prepareMessagesForModel(messages);
      const toolMsg = prepared.find((m) => m.role === 'tool');

      expect(toolMsg?.content).toBe(serialized);
    });

    it('compacts older tool messages to Tier B or C based on budget', () => {
      const messages: ProviderMessage[] = [
        { role: 'user', content: 'start' },
      ];

      // Build 10 steps: assistant + tool each
      for (let i = 1; i <= 10; i += 1) {
        messages.push(makeAssistantMessage([{
          toolCallId: `call-${i}`,
          toolName: 'read',
          args: { path: `file-${i}.txt` } as any,
        }]));
        const toolResult = makeToolResult('read', 'succeeded', `Read 3 line(s) from file-${i}.txt`, [
          `${i * 3 - 2}: content`,
          `${i * 3 - 1}: content`,
          `${i * 3}: content`,
        ]);
        messages.push(makeToolMessage(`call-${i}`, 'read', serializeToolResultForModel(toolResult)));
      }

      const prepared = prepareMessagesForModel(messages);
      const toolMessages = prepared.filter((m) => m.role === 'tool');

      // All should be compacted except possibly the last batch (Tier A)
      // The last tool message is Tier A, others are Tier B or C
      const lastTool = toolMessages[toolMessages.length - 1];
      expect(lastTool?.content).toContain('content');

      // Older messages should be compacted (contain "tier-b" or "tier-c")
      const olderTools = toolMessages.slice(0, -1);
      const compacted = olderTools.filter(
        (m) => m.content.includes('tier-b') || m.content.includes('tier-c'),
      );
      expect(compacted.length).toBeGreaterThan(0);
    });

    it('degrades to Tier C when the budget is exhausted', () => {
      process.env.PUEBLO_PROMPT_TOOL_RESULT_BUDGET_CHARS = '500';
      process.env.PUEBLO_PER_TOOL_PREVIEW_CHARS = '200';

      const messages: ProviderMessage[] = [
        { role: 'user', content: 'start' },
      ];

      for (let i = 1; i <= 20; i += 1) {
        messages.push(makeAssistantMessage([{
          toolCallId: `call-${i}`,
          toolName: 'read',
          args: { path: `file-${i}.txt` } as any,
        }]));
        const longOutput = Array.from({ length: 50 }, (_, j) => `${i}-${j}: ${'x'.repeat(40)}`);
        const toolResult = makeToolResult('read', 'succeeded', `Read 50 line(s) from file-${i}.txt`, longOutput);
        messages.push(makeToolMessage(`call-${i}`, 'read', serializeToolResultForModel(toolResult)));
      }

      const prepared = prepareMessagesForModel(messages);
      const toolMessages = prepared.filter((m) => m.role === 'tool');

      const tierCCount = toolMessages.filter((m) => m.content.includes('tier-c')).length;
      expect(tierCCount).toBeGreaterThan(5);

      // Total tool message content should be bounded
      const totalChars = toolMessages.reduce((sum, m) => sum + m.content.length, 0);
      expect(totalChars).toBeLessThan(10000);
    });

    it('boosts tool messages referencing the latest assistant request into Tier B', () => {
      const messages: ProviderMessage[] = [
        { role: 'user', content: 'read important.ts' },
      ];

      // Step 1: read important.ts
      messages.push(makeAssistantMessage([{
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: 'important.ts' } as any,
      }]));
      messages.push(makeToolMessage('call-1', 'read', serializeToolResultForModel(
        makeToolResult('read', 'succeeded', 'Read 10 line(s) from important.ts',
          Array.from({ length: 10 }, (_, j) => `${j + 1}: content-${j}`)),
      )));

      // Steps 2-5: read other files
      for (let i = 2; i <= 5; i += 1) {
        messages.push(makeAssistantMessage([{
          toolCallId: `call-${i}`,
          toolName: 'read',
          args: { path: `other-${i}.txt` } as any,
        }]));
        messages.push(makeToolMessage(`call-${i}`, 'read', serializeToolResultForModel(
          makeToolResult('read', 'succeeded', `Read 10 line(s) from other-${i}.txt`,
            Array.from({ length: 10 }, (_, j) => `${j + 1}: other-${i}-${j}`)),
        )));
      }

      // Latest assistant requests important.ts again
      messages.push(makeAssistantMessage([{
        toolCallId: 'call-6',
        toolName: 'read',
        args: { path: 'important.ts' } as any,
      }]));
      messages.push(makeToolMessage('call-6', 'read', serializeToolResultForModel(
        makeToolResult('read', 'succeeded', 'Read 10 line(s) from important.ts',
          Array.from({ length: 10 }, (_, j) => `${j + 1}: content-${j}`)),
      )));

      const prepared = prepareMessagesForModel(messages);
      const toolMessages = prepared.filter((m) => m.role === 'tool');

      // The first tool message (important.ts) should be boosted to Tier B
      const firstTool = toolMessages[0];
      // Tier B content contains outputPreview / tier-b, not tier-c
      expect(firstTool!.content).toContain('tier-b');
      expect(firstTool!.content).toContain('outputPreview');
      expect(firstTool!.content).toContain('important.ts');
    });

    it('falls back to legacy compaction when PUEBLO_COMPACT_MODE=legacy', () => {
      process.env.PUEBLO_COMPACT_MODE = 'legacy';

      const toolResult = makeToolResult('read', 'succeeded', 'Read 3 line(s) from foo.txt', [
        '1: alpha',
        '2: beta',
        '3: gamma',
      ]);

      const messages: ProviderMessage[] = [
        { role: 'user', content: 'start' },
        makeAssistantMessage([{
          toolCallId: 'call-1',
          toolName: 'read',
          args: { path: 'foo.txt' } as any,
        }]),
        makeToolMessage('call-1', 'read', serializeToolResultForModel(toolResult)),
        makeAssistantMessage([{
          toolCallId: 'call-2',
          toolName: 'read',
          args: { path: 'bar.txt' } as any,
        }]),
        makeToolMessage('call-2', 'read', serializeToolResultForModel(
          makeToolResult('read', 'succeeded', 'Read 1 line(s) from bar.txt', ['1: bar']),
        )),
      ];

      const prepared = prepareMessagesForModel(messages);
      const firstTool = prepared.find((m) => m.role === 'tool' && m.toolCallId === 'call-1');

      expect(firstTool?.content).toContain('执行结果已压缩：');
      expect(firstTool?.content).toContain('Read 3 line(s) from foo.txt');
    });
  });
});
