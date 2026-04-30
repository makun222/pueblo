import { describe, expect, it } from 'vitest';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import type { ProviderAdapter, ProviderRunResult, ProviderStepContext, ProviderStepResult } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ToolService } from '../../src/tools/tool-service';
import type { ExecuteToolRequest } from '../../src/tools/tool-service';
import type { AgentTask } from '../../src/shared/schema';

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
});