import { describe, expect, it } from 'vitest';
import { createResultBlocks, successResult } from '../../src/shared/result';

describe('Result Block Rendering', () => {
  it('should render only outputSummary and metadata for successful task payloads', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Short visible answer',
        attribution: {
          modelOutput: 'Verbose model trace',
        },
        toolResults: [
          {
            toolName: 'grep',
            status: 'succeeded',
            summary: 'found files',
          },
        ],
      }),
    });

    const blocks = createResultBlocks(result);

    expect(blocks.map((block) => block.title)).toEqual(['Output Summary', 'Model Output', 'TASK_COMPLETED-grep']);
    expect(blocks[0]?.content).toBe('Short visible answer');
    expect(blocks[0]?.messageTrace).toEqual([]);
  });

  it('should omit model output when it matches outputSummary', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Same content',
        attribution: {
          modelOutput: 'Same content',
        },
      }),
    });

    const blocks = createResultBlocks(result);

    expect(blocks.map((block) => block.title)).toEqual(['Output Summary']);
  });

  it('should render a collapsed step trace block when trace data is present', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Short visible answer',
        stepTrace: [
          {
            stepNumber: 1,
            type: 'tool-call',
            toolName: 'grep',
            toolCallId: 'call-1',
            summary: 'Search task files',
          },
          {
            stepNumber: 1,
            type: 'tool-result',
            toolName: 'grep',
            toolCallId: 'call-1',
            summary: 'Matched 2 files',
          },
        ],
      }),
    });

    const blocks = createResultBlocks(result);

    expect(blocks.map((block) => block.title)).toEqual(['Output Summary', 'Step Trace']);
    expect(blocks[1]?.collapsed).toBe(true);
    expect(blocks[1]?.content).toContain('1. tool-call (grep / call-1): Search task files');
    expect(blocks[1]?.content).toContain('1. tool-result (grep / call-1): Matched 2 files');
  });

  it('should attach formatted model message details when message trace is present', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Short visible answer',
        modelMessageTrace: [
          {
            stepNumber: 1,
            messages: [
              {
                role: 'system',
                content: 'system context',
              },
              {
                role: 'user',
                content: 'inspect repo',
              },
            ],
          },
        ],
      }),
    });

    const blocks = createResultBlocks(result);

    expect(blocks[0]?.messageTrace).toEqual([
      {
        stepNumber: 1,
        messageCount: 2,
        charCount: 26,
        messages: [
          {
            role: 'system',
            content: 'system context',
            toolName: undefined,
            toolCallId: undefined,
            toolArgs: undefined,
            charCount: 14,
          },
          {
            role: 'user',
            content: 'inspect repo',
            toolName: undefined,
            toolCallId: undefined,
            toolArgs: undefined,
            charCount: 12,
          },
        ],
      },
    ]);
  });
});