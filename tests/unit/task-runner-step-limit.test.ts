import { describe, expect, it } from 'vitest';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { getToolExecutionPolicy, type ProviderAdapter, type ProviderRunResult, type ProviderStepContext, type ProviderStepResult } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ToolService } from '../../src/tools/tool-service';
import type { ExecuteToolRequest } from '../../src/tools/tool-service';
import type { AgentTask } from '../../src/shared/schema';

type SingleToolName = 'grep' | 'exec' | 'edit';
type SingleToolArgs =
  | Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'grep' }>['args']
  | Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'exec' }>['args']
  | Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'edit' }>['args'];

class RepeatedToolCallingProviderAdapter implements ProviderAdapter {
  constructor(private readonly toolCallsBeforeFinal: number) {}

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const toolMessages = context.messages.filter((message) => message.role === 'tool');

    if (toolMessages.length >= this.toolCallsBeforeFinal) {
      return {
        type: 'final',
        outputSummary: `Completed after ${toolMessages.length} tool call(s)`,
      };
    }

    const nextToolCallIndex = toolMessages.length + 1;
    return {
      type: 'tool-call',
      toolCallId: `call-${nextToolCallIndex}`,
      toolName: 'read',
      args: { path: 'notes.txt' },
      rationale: `Read attempt ${nextToolCallIndex}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class SingleToolThenFinalProviderAdapter implements ProviderAdapter {
  constructor(
    private readonly toolName: SingleToolName,
    private readonly args: SingleToolArgs,
  ) {}

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const toolMessages = context.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length > 0) {
      return {
        type: 'final',
        outputSummary: `Observed ${toolMessages.length} tool result(s)`,
      };
    }

    switch (this.toolName) {
      case 'grep':
        return {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'grep',
          args: this.args as Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'grep' }>['args'],
          rationale: 'Run grep',
        };
      case 'exec':
        return {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'exec',
          args: this.args as Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'exec' }>['args'],
          rationale: 'Run exec',
        };
      case 'edit':
        return {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'edit',
          args: this.args as Extract<ProviderStepResult, { type: 'tool-call'; toolName: 'edit' }>['args'],
          rationale: 'Run edit',
        };
    }
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

function createInMemoryRepository() {
  const persistedTasks = new Map<string, AgentTask>();

  return {
    create(input: {
      goal: string;
      sessionId: string | null;
      providerId: string;
      modelId: string;
      inputContextSummary: string;
      status: AgentTask['status'];
      outputSummary?: string | null;
      toolInvocationIds?: string[];
    }): AgentTask {
      const task: AgentTask = {
        id: `task-${persistedTasks.size + 1}`,
        goal: input.goal,
        sessionId: input.sessionId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputContextSummary: input.inputContextSummary,
        status: input.status,
        outputSummary: input.outputSummary ?? null,
        toolInvocationIds: input.toolInvocationIds ?? [],
        createdAt: new Date().toISOString(),
        completedAt: input.status === 'completed' || input.status === 'failed' ? new Date().toISOString() : null,
      };
      persistedTasks.set(task.id, task);
      return task;
    },
    update(taskId: string, input: {
      goal: string;
      sessionId: string | null;
      providerId: string;
      modelId: string;
      inputContextSummary: string;
      status: AgentTask['status'];
      outputSummary?: string | null;
      toolInvocationIds?: string[];
    }): AgentTask {
      const current = persistedTasks.get(taskId);
      const task: AgentTask = {
        id: taskId,
        goal: input.goal,
        sessionId: input.sessionId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputContextSummary: input.inputContextSummary,
        status: input.status,
        outputSummary: input.outputSummary ?? null,
        toolInvocationIds: input.toolInvocationIds ?? [],
        createdAt: current?.createdAt ?? new Date().toISOString(),
        completedAt: input.status === 'completed' || input.status === 'failed' ? new Date().toISOString() : null,
      };
      persistedTasks.set(taskId, task);
      return task;
    },
  } as unknown as import('../../src/agent/task-repository').AgentTaskRepository;
}

function createToolService() {
  let invocationCount = 0;

  return {
    service: {
      describeTools: () => [
        {
          name: 'read',
          description: 'Read file contents',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      async execute(input: ExecuteToolRequest) {
        invocationCount += 1;
        return {
          invocation: { id: `tool-invocation-${invocationCount}` },
          output: {
            toolName: input.toolName,
            status: 'succeeded',
            summary: `Executed ${input.toolName} ${invocationCount}`,
            output: ['1: alpha'],
          },
        };
      },
    } as unknown as ToolService,
    getInvocationCount: () => invocationCount,
  };
}

function createSingleToolService(toolName: 'grep' | 'exec' | 'edit') {
  let invocationCount = 0;
  let lastExecutionCwd: string | undefined;

  return {
    service: {
      describeTools: () => [
        {
          name: toolName,
          description: `${toolName} tool`,
          executionPolicy: getToolExecutionPolicy(toolName),
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      ],
      async execute(input: ExecuteToolRequest) {
        invocationCount += 1;
        lastExecutionCwd = input.executionCwd;
        return {
          invocation: { id: `tool-invocation-${invocationCount}` },
          output: {
            toolName: input.toolName,
            status: 'succeeded',
            summary: `Executed ${input.toolName}`,
            output: [],
          },
        };
      },
      describeApproval(input: { toolName: 'grep' | 'exec' | 'edit'; args: unknown }) {
        return {
          title: `Allow ${input.toolName}?`,
          summary: `Summary for ${input.toolName}`,
          detail: JSON.stringify(input.args, null, 2),
        };
      },
      recordInvocation(input: ExecuteToolRequest) {
        invocationCount += 1;
        return { id: `tool-invocation-${invocationCount}`, ...input };
      },
    } as unknown as ToolService,
    getInvocationCount: () => invocationCount,
    getLastExecutionCwd: () => lastExecutionCwd,
  };
}

describe('AgentTaskRunner step limit', () => {
  it('allows longer tool workflows with the default step budget', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new RepeatedToolCallingProviderAdapter(8));

    const { service, getInvocationCount } = createToolService();
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service);

    const result = await runner.run({
      goal: 'Inspect repository state with repeated reads',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(8);
    expect(result.outputSummary).toContain('Completed after 8 tool call(s)');
  });

  it('still enforces a custom lower step budget when configured', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new RepeatedToolCallingProviderAdapter(8));

    const { service } = createToolService();
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, { maxSteps: 8 });

    await expect(
      runner.run({
        goal: 'Inspect repository state with repeated reads',
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        inputContextSummary: 'No additional context',
      }),
    ).rejects.toThrow('Agent task exceeded 8 steps without producing a final response');
  });

  it('returns a failed tool result when approval-required tools are denied', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SingleToolThenFinalProviderAdapter('edit', {
      path: 'notes.txt',
      oldText: 'alpha',
      newText: 'beta',
    }));

    const { service, getInvocationCount } = createSingleToolService('edit');
    const approvalRequests: Array<{ toolName: string; title: string; summary: string; detail: string }> = [];
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      requestToolApproval: async (request) => {
        approvalRequests.push({
          toolName: request.toolName,
          title: request.title,
          summary: request.summary,
          detail: request.detail,
        });
        return false;
      },
    });

    const result = await runner.run({
      goal: 'Attempt an edit',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      targetDirectory?: string | null;
      toolExecutionCwd?: string | null;
      toolResults?: Array<{ toolName: string; status: string; summary: string; executionCwd?: string | null }>;
    };

    expect(approvalRequests).toEqual([
      {
        toolName: 'edit',
        title: 'Allow edit?',
        summary: 'Summary for edit',
        detail: JSON.stringify({
          path: 'notes.txt',
          oldText: 'alpha',
          newText: 'beta',
        }, null, 2),
      },
    ]);
    expect(getInvocationCount()).toBe(1);
    expect(outputSummary.targetDirectory).toBeNull();
    expect(outputSummary.toolExecutionCwd).toBeNull();
    expect(outputSummary.toolResults).toEqual([
      {
        toolName: 'edit',
        status: 'failed',
        summary: 'Execution denied: user approval is required before running edit',
        executionCwd: null,
      },
    ]);
  });

  it('executes free tools without requesting approval', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SingleToolThenFinalProviderAdapter('grep', {
      pattern: 'alpha',
      include: 'src/**/*.ts',
    }));

    const { service, getInvocationCount } = createSingleToolService('grep');
    let approvalRequestCount = 0;
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      requestToolApproval: async () => {
        approvalRequestCount += 1;
        return true;
      },
    });

    const result = await runner.run({
      goal: 'Run grep',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      targetDirectory?: string | null;
      toolExecutionCwd?: string | null;
      toolResults?: Array<{ toolName: string; status: string; summary: string; executionCwd?: string | null }>;
    };

    expect(approvalRequestCount).toBe(0);
    expect(getInvocationCount()).toBe(1);
    expect(outputSummary.targetDirectory).toBeNull();
    expect(outputSummary.toolExecutionCwd).toBeNull();
    expect(outputSummary.toolResults).toEqual([
      {
        toolName: 'grep',
        status: 'succeeded',
        summary: 'Executed grep',
        executionCwd: null,
      },
    ]);
  });

  it('routes tool execution through the task target directory when one is selected', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SingleToolThenFinalProviderAdapter('grep', {
      pattern: 'alpha',
      include: 'src/**/*.ts',
    }));

    const { service, getLastExecutionCwd } = createSingleToolService('grep');
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service);

    const result = await runner.run({
      goal: 'Inspect the target repository',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
      taskContext: {
        sessionId: 'session-1',
        session: null,
        targetDirectory: 'D:/workspace/KnowledgeBase/knowledgeBase',
        providerId: 'openai',
        providerName: 'OpenAI',
        selectedModelId: 'gpt-4.1-mini',
        selectedModelName: 'GPT-4.1 Mini',
        selectedPromptIds: [],
        selectedMemoryIds: [],
        prompts: [],
        resultSet: null,
        resultItems: [],
        sessionMessages: [],
        recentMessages: [],
        puebloProfile: {
          loadedFromPath: null,
          loadedAt: new Date().toISOString(),
          roleDirectives: [],
          goalDirectives: [],
          constraintDirectives: [],
          styleDirectives: [],
          memoryPolicy: { retentionHints: [], summaryHints: [] },
          contextPolicy: { priorityHints: [], truncationHints: [] },
          summaryPolicy: { autoSummarize: false, thresholdHint: null, lineageHint: null },
        },
        contextCount: {
          estimatedTokens: 0,
          contextWindowLimit: null,
          utilizationRatio: null,
          messageCount: 0,
          selectedPromptCount: 0,
          selectedMemoryCount: 0,
          derivedMemoryCount: 0,
        },
        backgroundSummaryStatus: {
          state: 'idle',
          activeSummarySessionId: null,
          lastSummaryAt: null,
          lastSummaryMemoryId: null,
        },
        config: {} as never,
      },
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      targetDirectory?: string | null;
      toolExecutionCwd?: string | null;
      toolResults?: Array<{ toolName: string; status: string; summary: string; executionCwd?: string | null }>;
    };

    expect(getLastExecutionCwd()).toBe('D:/workspace/KnowledgeBase/knowledgeBase');
    expect(outputSummary.targetDirectory).toBe('D:/workspace/KnowledgeBase/knowledgeBase');
    expect(outputSummary.toolExecutionCwd).toBe('D:/workspace/KnowledgeBase/knowledgeBase');
    expect(outputSummary.toolResults).toEqual([
      {
        toolName: 'grep',
        status: 'succeeded',
        summary: 'Executed grep',
        executionCwd: 'D:/workspace/KnowledgeBase/knowledgeBase',
      },
    ]);
  });
});