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

    expect(blocks.map((block) => block.title)).toEqual(['WORKFLOW_STARTED', 'WORKFLOW_STARTED-data', 'Workflow']);
    expect(blocks[2]?.content).toContain('Workflow ID: workflow-2');
    expect(blocks[2]?.content).toContain('Route Reason: explicit');
    expect(blocks[2]?.content).toContain('Runtime Plan Path: D:/workspace/.plans/workflow-2/feature.plan.md');
  });
});