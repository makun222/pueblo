import { describe, expect, it } from 'vitest';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { getToolExecutionPolicy, type ProviderAdapter, type ProviderRunResult, type ProviderStepContext, type ProviderStepResult } from '../../src/providers/provider-adapter';
import { ProviderInvalidToolArgumentsError, ProviderUnknownToolError } from '../../src/providers/provider-errors';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ToolService } from '../../src/tools/tool-service';
import type { ExecuteToolRequest } from '../../src/tools/tool-service';
import type { AgentTask } from '../../src/shared/schema';
import { createTaskCancellationError } from '../../src/shared/task-cancellation';

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

class SequentialReadProviderAdapter implements ProviderAdapter {
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
      args: { path: `notes-${nextToolCallIndex}.txt` },
      rationale: `Read attempt ${nextToolCallIndex}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class ClarifyingStepLimitProviderAdapter implements ProviderAdapter {
  constructor(private readonly toolCallsBeforeFinal: number) {}

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (context.availableTools.length === 0) {
      const lastMessage = context.messages.at(-1);
      return {
        type: 'final',
        outputSummary: [
          '我想了很久，这个任务还需要你进一步明确。',
          '1. 指定要分析的文件或模块。',
          '2. 指定你最关心的问题类型，例如根因或修改方案。',
          `Prompt observed: ${lastMessage?.content.includes('你需要跟用户进行需求澄清') ? 'yes' : 'no'}`,
        ].join('\n'),
      };
    }

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
      args: { path: `clarify-${nextToolCallIndex}.txt` },
      rationale: `Read attempt ${nextToolCallIndex}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class StepBudgetPromptObservingProviderAdapter implements ProviderAdapter {
  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const budgetMessage = context.messages.find((message) => message.role === 'system' && message.content.includes('执行预算政策：'));
    return {
      type: 'final',
      outputSummary: [
        `Budget prompt observed: ${budgetMessage?.content.includes('每轮交互有 48 步的硬性模型调用限制。') ? 'yes' : 'no'}`,
        `Multi-turn prompt observed: ${budgetMessage?.content.includes('划分为多个子任务') ? 'yes' : 'no'}`,
        `Early handoff prompt observed: ${budgetMessage?.content.includes('留到后续轮次继续') ? 'yes' : 'no'}`,
      ].join('\n'),
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class StepBudgetHandoffProviderAdapter implements ProviderAdapter {
  constructor(private readonly toolCallsBeforeFinal: number) {}

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (context.availableTools.length === 0) {
      const lastMessage = context.messages.at(-1);
      const toolMessages = context.messages.filter((message) => message.role === 'tool');
      return {
        type: 'final',
        outputSummary: [
          'Completed this round',
          `- 已完成 ${toolMessages.length} 次读取。`,
          '',
          'Remaining work',
          '- 还需要继续处理剩余范围。',
          '',
          'Recommended next request',
          '- 下一轮继续最重要的前几个剩余子任务。',
          `Prompt observed: ${lastMessage?.content.includes('写一个简洁的进度报告') ? 'yes' : 'no'}`,
        ].join('\n'),
      };
    }

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
      args: { path: `handoff-${nextToolCallIndex}.txt` },
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

class RepeatedEditThenFinalProviderAdapter implements ProviderAdapter {
  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const toolMessages = context.messages.filter((message) => message.role === 'tool');

    if (toolMessages.length >= 2) {
      return {
        type: 'final',
        outputSummary: `Observed ${toolMessages.length} tool result(s)`,
      };
    }

    const nextToolCallIndex = toolMessages.length + 1;
    return {
      type: 'tool-call',
      toolCallId: `call-${nextToolCallIndex}`,
      toolName: 'edit',
      args: {
        path: 'notes.txt',
        oldText: 'alpha',
        newText: 'beta',
      },
      rationale: `Run edit ${nextToolCallIndex}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class StreamingFinalProviderAdapter implements ProviderAdapter {
  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    context.onTextDelta?.('Hello');
    context.onTextDelta?.(' world');
    return {
      type: 'final',
      outputSummary: 'Hello world',
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class AbortableProviderAdapter implements ProviderAdapter {
  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    return await new Promise<ProviderStepResult>((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => {
        reject(context.signal?.reason ?? createTaskCancellationError('Task cancelled during provider execution.'));
      }, { once: true });
    });
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class UnknownToolThenFinalProviderAdapter implements ProviderAdapter {
  seenRetryPrompt: string | null = null;

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const retryPrompt = context.messages.find((message) => message.role === 'user' && message.content.includes('这个工具 "search" 在此运行时不可用。'));

    if (!retryPrompt) {
      throw new ProviderUnknownToolError('deepseek', 'search');
    }

    this.seenRetryPrompt = retryPrompt.content;
    return {
      type: 'final',
      outputSummary: 'Recovered after unavailable tool guidance',
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class InvalidToolArgumentsThenFinalProviderAdapter implements ProviderAdapter {
  seenRetryPrompt: string | null = null;

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const retryPrompt = context.messages.find((message) => message.role === 'user' && message.content.includes('工具 "read" 的参数无效。'));

    if (!retryPrompt) {
      throw new ProviderInvalidToolArgumentsError('deepseek', 'read', [
        {
          path: 'path',
          message: 'Invalid input: expected string, received undefined',
        },
      ]);
    }

    this.seenRetryPrompt = retryPrompt.content;
    return {
      type: 'final',
      outputSummary: 'Recovered after invalid tool argument guidance',
    };
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
        const path = typeof input.args === 'object' && input.args !== null && 'path' in input.args ? String(input.args.path) : 'unknown';
        return {
          invocation: { id: `tool-invocation-${invocationCount}` },
          output: {
            toolName: input.toolName,
            status: 'succeeded',
            summary: `Executed ${input.toolName} ${path}`,
            output: [`1: ${path}`],
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
    registry.register(profile, new SequentialReadProviderAdapter(8));

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

  it('allows deeper default workflows before enforcing the step budget', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SequentialReadProviderAdapter(24));

    const { service, getInvocationCount } = createToolService();
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service);

    const result = await runner.run({
      goal: 'Inspect repository state with a longer read workflow',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(24);
    expect(result.outputSummary).toContain('Completed after 24 tool call(s)');
  });

  it('instructs the model to estimate workload and choose a multi-turn plan before broad execution', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new StepBudgetPromptObservingProviderAdapter());

    const runner = new AgentTaskRunner(registry, createInMemoryRepository());

    const result = await runner.run({
      goal: 'Inspect repository state with repeated reads',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(result.outputSummary).toContain('Budget prompt observed: yes');
    expect(result.outputSummary).toContain('Multi-turn prompt observed: yes');
    expect(result.outputSummary).toContain('Early handoff prompt observed: yes');
  });

  it('returns a progress handoff when the configured step budget is exhausted', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new StepBudgetHandoffProviderAdapter(99));

    const { service, getInvocationCount } = createToolService();
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, { maxSteps: 8 });

    const result = await runner.run({
      goal: 'Inspect repository state with repeated reads',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      outputSummary?: string;
      modelMessageTrace?: Array<{
        stepNumber: number;
        messages: Array<{ role: string; content: string }>;
      }>;
    };

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(8);
    expect(outputSummary.outputSummary).toContain('Completed this round');
    expect(outputSummary.outputSummary).toContain('Remaining work');
    expect(outputSummary.outputSummary).toContain('Recommended next request');
    expect(outputSummary.outputSummary).toContain('Prompt observed: yes');
    expect(outputSummary.modelMessageTrace?.at(-1)?.messages.at(-1)?.role).toBe('user');
    expect(outputSummary.modelMessageTrace?.at(-1)?.messages.at(-1)?.content).toContain('你已经达到了本轮任务步骤的预算。');
  });

  it('returns clarification guidance when the model repeats the same tool loop without making progress', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new RepeatedToolCallingProviderAdapter(Number.POSITIVE_INFINITY));

    const { service, getInvocationCount } = createToolService();
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service);

    const result = await runner.run({
      goal: 'Inspect repository state with a stalled read workflow',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      outputSummary?: string;
      modelMessageTrace?: Array<{
        stepNumber: number;
        messages: Array<{ role: string; content: string }>;
      }>;
    };

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(6);
    expect(outputSummary.outputSummary).toContain('当前状态：Agent task entered a repeated read loop for 6 consecutive steps without making progress');
    expect(outputSummary.outputSummary).toContain('1. 指定要分析的文件、模块或失败命令。');
    expect(outputSummary.modelMessageTrace?.at(-1)?.messages.at(-1)?.content).toContain('你需要跟用户进行需求澄清');
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
        return 'deny';
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
        return 'allow-once';
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

  it('reports agent progress while tools are being executed', async () => {
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

    const { service } = createSingleToolService('grep');
    const progressMessages: string[] = [];
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      reportProgress: (message) => {
        progressMessages.push(message);
      },
    });

    const result = await runner.run({
      goal: 'Run grep',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(progressMessages).toContain('Started task: Run grep');
    expect(progressMessages).toContain('Step 1: running grep alpha');
    expect(progressMessages).toContain('Step 1: grep succeeded - Executed grep');
    expect(progressMessages).toContain('Step 2: final response ready');
  });

  it('reminds the model about available tools and retries when an unavailable tool is requested', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    const adapter = new UnknownToolThenFinalProviderAdapter();
    registry.register(profile, adapter);

    const { service, getInvocationCount } = createToolService();
    const progressMessages: string[] = [];
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      reportProgress: (message) => {
        progressMessages.push(message);
      },
    });

    const result = await runner.run({
      goal: 'Inspect repository state safely',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(0);
    expect(result.outputSummary).toContain('Recovered after unavailable tool guidance');
    expect(progressMessages).toContain('Step 1: unavailable tool requested - search');
    expect(adapter.seenRetryPrompt).toContain('请勿再次调用');
    expect(adapter.seenRetryPrompt).toContain('可用工具:');
    expect(adapter.seenRetryPrompt).toContain('- read (free)');
    expect(adapter.seenRetryPrompt).toContain('Required fields: path');
  });

  it('reminds the model to repair invalid tool arguments and retries instead of failing the task', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    const adapter = new InvalidToolArgumentsThenFinalProviderAdapter();
    registry.register(profile, adapter);

    const { service, getInvocationCount } = createToolService();
    const progressMessages: string[] = [];
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      reportProgress: (message) => {
        progressMessages.push(message);
      },
    });

    const result = await runner.run({
      goal: 'Inspect repository state safely',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(getInvocationCount()).toBe(0);
    expect(result.outputSummary).toContain('Recovered after invalid tool argument guidance');
    expect(progressMessages).toContain('Step 1: invalid read arguments requested');
    expect(adapter.seenRetryPrompt).toContain('验证错误:');
    expect(adapter.seenRetryPrompt).toContain('- path: Invalid input: expected string, received undefined');
    expect(adapter.seenRetryPrompt).toContain('- read (free)');
    expect(adapter.seenRetryPrompt).toContain('Required fields: path');
  });

  it('forwards provider text deltas to the assistant draft reporter', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new StreamingFinalProviderAdapter());

    const streamedChunks: string[] = [];
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), undefined, {
      reportAssistantDelta: (text) => {
        streamedChunks.push(text);
      },
    });

    const result = await runner.run({
      goal: 'Stream a final answer',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(streamedChunks).toEqual(['Hello', ' world']);
  });

  it('includes aggregated file changes in the completed task payload', async () => {
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

    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), {
      describeTools: () => [
        {
          name: 'edit',
          description: 'edit tool',
          executionPolicy: getToolExecutionPolicy('edit'),
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      ],
      async execute() {
        return {
          invocation: { id: 'tool-invocation-1' },
          output: {
            toolName: 'edit',
            status: 'succeeded',
            summary: 'Edited notes.txt',
            output: [],
            fileChanges: [
              {
                path: 'notes.txt',
                absolutePath: 'd:/workspace/trends/pueblo/notes.txt',
                changeType: 'modified',
                previousContent: 'alpha\n',
                currentContent: 'beta\n',
              },
            ],
          },
        };
      },
      recordInvocation() {
        return { id: 'tool-invocation-1' };
      },
      describeApproval() {
        return {
          title: 'Allow edit?',
          summary: 'Edit notes.txt',
          detail: 'Edit notes.txt',
        };
      },
    } as unknown as ToolService, {
      requestToolApproval: async () => 'allow-once',
    });

    const result = await runner.run({
      goal: 'Edit notes',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      fileChanges?: Array<{
        path: string;
        absolutePath: string;
        changeType: string;
        previousContent: string;
        currentContent: string;
      }>;
    };

    expect(outputSummary.fileChanges).toEqual([
      {
        path: 'notes.txt',
        absolutePath: 'd:/workspace/trends/pueblo/notes.txt',
        changeType: 'modified',
        previousContent: 'alpha\n',
        currentContent: 'beta\n',
      },
    ]);
  });

  it('does not request approval for read-only exec commands', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SingleToolThenFinalProviderAdapter('exec', {
      command: 'findstr task src\\*.ts',
    }));

    const { service, getInvocationCount } = createSingleToolService('exec');
    let approvalRequestCount = 0;
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      requestToolApproval: async () => {
        approvalRequestCount += 1;
        return 'deny';
      },
    });

    const result = await runner.run({
      goal: 'Inspect files with a read-only command',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(approvalRequestCount).toBe(0);
    expect(getInvocationCount()).toBe(1);
  });

  it('still requests approval for mutating exec commands', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new SingleToolThenFinalProviderAdapter('exec', {
      command: 'npm test',
    }));

    const { service, getInvocationCount } = createSingleToolService('exec');
    let approvalRequestCount = 0;
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      requestToolApproval: async () => {
        approvalRequestCount += 1;
        return 'allow-once';
      },
    });

    const result = await runner.run({
      goal: 'Run the test script',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(approvalRequestCount).toBe(1);
    expect(getInvocationCount()).toBe(1);
  });

  it('reuses allow-all approval decisions for repeated edits to the same file', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new RepeatedEditThenFinalProviderAdapter());

    const { service, getInvocationCount } = createSingleToolService('edit');
    let approvalRequestCount = 0;
    const runner = new AgentTaskRunner(registry, createInMemoryRepository(), service, {
      requestToolApproval: async () => {
        approvalRequestCount += 1;
        return 'allow-all';
      },
    });

    const result = await runner.run({
      goal: 'Apply the same edit twice',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(approvalRequestCount).toBe(1);
    expect(getInvocationCount()).toBe(2);
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
        sessionSummaryMemories: [],
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
          contextPolicy: { priorityHints: [], truncationHints: [], activeTurnStepWindow: 3, injectionWeightThreshold: { sessionSummary: 0.2, recentConversation: 0.3, relevantResultItems: 0.4 }, reservedBudget: { recentConversation: 0.3 } },
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
        uploadedAttachments: [],
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

  it('persists active workflow round metadata alongside the task output summary', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new StreamingFinalProviderAdapter());

    const runner = new AgentTaskRunner(registry, createInMemoryRepository());
    const result = await runner.run({
      goal: 'Continue the active workflow round',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'Workflow round execution',
      taskContext: {
        sessionId: 'session-1',
        session: null,
        targetDirectory: null,
        providerId: 'openai',
        providerName: 'OpenAI',
        selectedModelId: 'gpt-4.1-mini',
        selectedModelName: 'GPT-4.1 Mini',
        selectedPromptIds: [],
        selectedMemoryIds: [],
        sessionSummaryMemories: [],
        prompts: [],
        resultSet: null,
        resultItems: [],
        workflowContext: {
          workflowId: 'workflow-1',
          workflowType: 'pueblo-plan',
          status: 'round-active',
          planSummary: 'Goal: complete the workflow round',
          todoSummary: 'Round 1 tasks:\n- finish implementation',
          planMemoryId: 'memory-plan-1',
          todoMemoryId: 'memory-todo-1',
          runtimePlanPath: 'D:/workspace/.plans/workflow-1/round.plan.md',
          deliverablePlanPath: null,
          activeRoundNumber: 1,
          updatedAt: new Date().toISOString(),
        },
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
          contextPolicy: { priorityHints: [], truncationHints: [], activeTurnStepWindow: 3, injectionWeightThreshold: { sessionSummary: 0.2, recentConversation: 0.3, relevantResultItems: 0.4 }, reservedBudget: { recentConversation: 0.3 } },
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
        uploadedAttachments: [],
        config: {} as never,
      },
    });

    const outputSummary = JSON.parse(result.outputSummary ?? '{}') as {
      attribution?: {
        memoryIds?: string[];
      };
      workflow?: {
        workflowId: string;
        workflowType: string;
        status: string;
        activeRoundNumber: number | null;
        planMemoryId: string | null;
        todoMemoryId: string | null;
      } | null;
    };

    expect(outputSummary.workflow).toEqual({
      workflowId: 'workflow-1',
      workflowType: 'pueblo-plan',
      status: 'round-active',
      activeRoundNumber: 1,
      planMemoryId: 'memory-plan-1',
      todoMemoryId: 'memory-todo-1',
    });
    expect(outputSummary.attribution?.memoryIds).toEqual(['memory-plan-1', 'memory-todo-1']);
  });

  it('aborts an in-flight task when the submit signal is cancelled', async () => {
    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new AbortableProviderAdapter());

    const runner = new AgentTaskRunner(registry, createInMemoryRepository());
    const controller = new AbortController();

    const pendingRun = runner.run({
      goal: 'Wait for cancellation',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
      signal: controller.signal,
    });

    controller.abort(createTaskCancellationError('Task cancelled because the desktop window closed.'));

    await expect(pendingRun).rejects.toThrow('Task cancelled because the desktop window closed.');
  });
});
