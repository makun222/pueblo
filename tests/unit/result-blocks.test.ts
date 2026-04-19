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
});