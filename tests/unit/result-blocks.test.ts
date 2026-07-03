import { describe, expect, it } from 'vitest';
import { createResultBlocks, extractNextStepSuggestionsFromText, extractTaskOutputSummaryPayload, extractTaskOutputSummaryText, successResult } from '../../src/shared/result';

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

  it('should keep model message trace on only the first emitted block', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Short visible answer',
        attribution: {
          modelOutput: 'Verbose model trace',
          promptIds: ['prompt-1'],
        },
        toolResults: [
          {
            toolName: 'grep',
            status: 'succeeded',
            summary: 'found files',
          },
        ],
        modelMessageTrace: [
          {
            stepNumber: 1,
            messages: [
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

    expect(blocks.map((block) => block.title)).toEqual([
      'Output Summary',
      'Model Output',
      'TASK_COMPLETED-prompts',
      'TASK_COMPLETED-grep',
    ]);
    expect(blocks[0]?.messageTrace).toHaveLength(1);
    expect(blocks.slice(1).every((block) => block.messageTrace.length === 0)).toBe(true);
  });

  it('should extract structured exec command blocks from the model message trace', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Ran workspace command',
        toolResults: [
          {
            toolName: 'exec',
            status: 'succeeded',
            summary: 'src\npackage.json',
          },
        ],
        modelMessageTrace: [
          {
            stepNumber: 1,
            messages: [
              {
                role: 'assistant',
                content: '',
                toolName: 'exec',
                toolCallId: 'call-exec-1',
                toolArgs: {
                  command: 'dir src',
                },
              },
              {
                role: 'tool',
                content: JSON.stringify({
                  status: 'succeeded',
                  summary: 'src\npackage.json',
                  output: ['src', 'package.json'],
                }),
                toolName: 'exec',
                toolCallId: 'call-exec-1',
              },
            ],
          },
        ],
      }),
    });

    const blocks = createResultBlocks(result);
    const execBlock = blocks[1];

    expect(execBlock?.title).toBe('Command Execution');
    expect(execBlock?.content).toBe('src\n\npackage.json');
    expect(execBlock?.collapsed).toBe(true);
    expect(execBlock?.execCommand).toEqual({
      rawCommand: 'dir src',
      command: 'dir',
      args: ['src'],
      result: 'src\n\npackage.json',
    });
  });

  it('should render workflow and export metadata for completed workflow task results', () => {
    const result = successResult('TASK_COMPLETED', 'Agent task completed', {
      outputSummary: JSON.stringify({
        outputSummary: 'Workflow round finished',
        workflow: {
          workflowId: 'workflow-1',
          workflowType: 'pueblo-plan',
          status: 'completed',
          activeRoundNumber: null,
          planMemoryId: 'memory-plan-1',
          todoMemoryId: null,
        },
      }),
      workflow: {
        workflowId: 'workflow-1',
        workflowType: 'pueblo-plan',
        status: 'completed',
        completedRoundNumber: 1,
        activeRoundNumber: null,
        runtimePlanPath: 'D:/workspace/.plans/workflow-1/final.plan.md',
        deliverablePlanPath: 'D:/workspace/app/final.plan.md',
        exportResult: {
          status: 'exported',
          deliverablePlanPath: 'D:/workspace/app/final.plan.md',
          exportedAt: '2026-05-10T12:00:00.000Z',
        },
      },
    });

    const blocks = createResultBlocks(result);

    expect(blocks.map((block) => block.title)).toEqual(['Output Summary', 'Workflow', 'Workflow Export']);
    expect(blocks[1]?.content).toContain('Workflow ID: workflow-1');
    expect(blocks[1]?.content).toContain('Completed Round: 1');
    expect(blocks[2]?.content).toContain('Export Status: exported');
  });

  it('should render workflow details for workflow start results without task payloads', () => {
    const result = successResult('WORKFLOW_STARTED', 'Workflow started', {
      workflowId: 'workflow-2',
      workflowType: 'pueblo-plan',
      runtimePlanPath: 'D:/workspace/.plans/workflow-2/feature.plan.md',
      deliverablePlanPath: 'D:/workspace/app/feature.plan.md',
      activeRoundNumber: 1,
      routeReason: 'explicit',
    });

    const blocks = createResultBlocks(result);

    expect(blocks.map((block) => block.title)).toEqual(['WORKFLOW_STARTED', 'Workflow']);
    expect(blocks[1]?.content).toContain('Workflow ID: workflow-2');
    expect(blocks[1]?.content).toContain('Route Reason: explicit');
    expect(blocks[1]?.content).toContain('Runtime Plan Path: D:/workspace/.plans/workflow-2/feature.plan.md');
  });

  it('parses next_step_actions from a 下一步建议 free-text section, deduping prompts, filtering invalid entries, and capping at 4', () => {
    const freeText = [
      'Apply the fix.',
      '',
      '## 下一步建议',
      '- 修复解析器: src/shared/result.ts tighten action parsing',
      '- 修复解析器again: src/shared/result.ts tighten action parsing',
      '- : missing label should drop',
      '- 这个动作的标签长度远远超过三十个字符的限制所以必须被解析器丢弃: dropped prompt here',
      '- 添加CLI菜单: src/cli/index.ts add numbered next-step actions',
      '- 改善焦点: src/desktop/renderer/App.tsx focus the input after action clicks',
      '- 第五个动作: this one should be kept within the max limit',
    ].join('\n');
    const payload = extractTaskOutputSummaryPayload(JSON.stringify({ outputSummary: freeText }));

    expect(payload?.next_step_actions).toEqual([
      { label: '修复解析器', prompt: 'src/shared/result.ts tighten action parsing' },
      { label: '添加CLI菜单', prompt: 'src/cli/index.ts add numbered next-step actions' },
      { label: '改善焦点', prompt: 'src/desktop/renderer/App.tsx focus the input after action clicks' },
      { label: '第五个动作', prompt: 'this one should be kept within the max limit' },
    ]);
  });

  it('returns no next_step_actions when there is no 下一步建议 heading', () => {
    const payload = extractTaskOutputSummaryPayload(JSON.stringify({
      outputSummary: [
        'Follow-up notes:',
        '```json',
        '{',
        '  "label": "Fix parser",',
        '  "prompt": "src/shared/result.ts tighten action parsing"',
        '}',
        '```',
      ].join('\n'),
    }));

    expect(payload?.next_step_actions).toBeUndefined();
  });

  it('parses a 下一步建议 section directly from a non-JSON outputSummary', () => {
    const freeText = [
      'Summary body.',
      '',
      '## 下一步建议',
      '- 修复解析器: src/shared/result.ts tighten action parsing',
    ].join('\n');
    const payload = extractTaskOutputSummaryPayload(freeText);

    expect(payload?.next_step_actions).toEqual([
      { label: '修复解析器', prompt: 'src/shared/result.ts tighten action parsing' },
    ]);
  });

  it('strips the 下一步建议 section from the displayed summary text', () => {
    const freeText = [
      'Summary body line one.',
      'Summary body line two.',
      '',
      '## 下一步建议',
      '- 修复解析器: src/shared/result.ts tighten action parsing',
      '- 添加CLI菜单: src/cli/index.ts add numbered next-step actions',
    ].join('\n');
    const displayed = extractTaskOutputSummaryText(JSON.stringify({ outputSummary: freeText }));

    expect(displayed).toContain('Summary body line one.');
    expect(displayed).toContain('Summary body line two.');
    expect(displayed).not.toContain('下一步建议');
    expect(displayed).not.toContain('修复解析器');
    expect(displayed).not.toContain('添加CLI菜单');
  });

  it('splits each suggestion line on the first colon and drops empty/oversized labels', () => {
    const suggestions = extractNextStepSuggestionsFromText([
      '## 下一步建议',
      '- 修复解析器: src/shared/result.ts: tighten on line 12',
      '- 添加CLI菜单: src/cli/index.ts add numbered selection',
      '- : empty label should drop',
      '- : also empty prompt is fine but label empty drops',
      '',
    ].join('\n'));

    expect(suggestions).toEqual([
      { label: '修复解析器', prompt: 'src/shared/result.ts: tighten on line 12' },
      { label: '添加CLI菜单', prompt: 'src/cli/index.ts add numbered selection' },
    ]);
  });

  it('yields no buttons when the section has no parseable lines', () => {
    const suggestions = extractNextStepSuggestionsFromText([
      '## 下一步建议',
      'Some prose without a colon',
      '- : ',
      '',
    ].join('\n'));

    expect(suggestions).toBeUndefined();
  });

  it('does not turn plain suggestions into desktop action buttons', () => {
    const result = {
      ok: true,
      code: 'HANDLED',
      message: 'Handled command',
      data: { outputSummary: JSON.stringify({ outputSummary: 'Handled command' }) },
      suggestions: ['Try /help'],
    } as const;

    const blocks = createResultBlocks(result);

    expect(blocks[0]?.actions).toEqual([]);
  });
});
