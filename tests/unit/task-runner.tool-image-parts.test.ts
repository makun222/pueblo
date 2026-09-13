import { describe, expect, it } from 'vitest';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import type { AgentTaskRepository } from '../../src/agent/task-repository';
import type { AgentTask } from '../../src/shared/schema';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import {
  getToolExecutionPolicy,
  type ProviderAdapter,
  type ProviderMessage,
  type ProviderRunResult,
  type ProviderStepContext,
  type ProviderStepResult,
} from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { ToolService } from '../../src/tools/tool-service';

const IMAGE_PART = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimeType: 'image/png' as const,
};

/** 第一轮请求工具、第二轮收敛为 final，并记录每次 runStep 收到的消息快照。 */
class ImageReadThenFinalProviderAdapter implements ProviderAdapter {
  readonly stepMessages: ProviderMessage[][] = [];
  readonly stepSupportsVision: boolean[] = [];

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    this.stepMessages.push([...context.messages]);
    this.stepSupportsVision.push(context.supportsVision);

    if (this.stepMessages.length === 1) {
      return {
        type: 'tool-call',
        toolCallId: 'call-image-1',
        toolName: 'read',
        args: { path: 'scan.png' },
        rationale: 'Read image material',
      };
    }

    return { type: 'final', outputSummary: 'Read the scanned image.' };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

/** 假 read 工具：返回带 `imageParts` 的图片结果。 */
function createImageReadToolService(): ToolService {
  return {
    describeTools: () => [
      {
        name: 'read',
        description: 'Read tool',
        executionPolicy: getToolExecutionPolicy('read'),
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
    execute: async (input: { toolName: string }) => ({
      invocation: { id: 'tool-invocation-1' },
      output: {
        toolName: input.toolName,
        status: 'succeeded',
        summary: 'Read image scan.png',
        output: ['1: [image scan.png]'],
        imageParts: [IMAGE_PART],
      },
    }),
  } as unknown as ToolService;
}

function createRepository(): AgentTaskRepository {
  const tasks = new Map<string, AgentTask>();
  return {
    create: (input: Partial<AgentTask>) => {
      const task = { ...input, id: input.id ?? 'task-image-parts' } as AgentTask;
      tasks.set(task.id, task);
      return task;
    },
    update: (id: string, patch: Partial<AgentTask>) => {
      const task = { ...(tasks.get(id) ?? { id }), ...patch, id } as AgentTask;
      tasks.set(id, task);
      return task;
    },
    findById: (id: string) => tasks.get(id) ?? null,
  } as unknown as AgentTaskRepository;
}

function buildRunner(supportsVision: boolean) {
  const profile = createProviderProfile({
    id: 'vision-provider',
    name: 'Vision Provider',
    defaultModelId: 'vision-model',
    models: [
      {
        id: 'vision-model',
        name: 'Vision Model',
        supportsTools: true,
        supportsVision,
      },
    ],
  });
  const adapter = new ImageReadThenFinalProviderAdapter();
  const registry = new ProviderRegistry();
  registry.register(profile, adapter);
  const runner = new AgentTaskRunner(registry, createRepository(), createImageReadToolService());
  return { runner, adapter };
}

function hasImageCarrierMessage(messages: ProviderMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.imageParts) &&
      message.imageParts.length > 0,
  );
}

describe('AgentTaskRunner tool image injection', () => {
  it('appends a user image carrier message after tool results when the model supports vision', async () => {
    const { runner, adapter } = buildRunner(true);

    const result = await runner.run({
      goal: 'Read a scanned image through the read tool',
      sessionId: 'session-image-1',
      providerId: 'vision-provider',
      modelId: 'vision-model',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(adapter.stepMessages.length).toBeGreaterThanOrEqual(2);
    expect(adapter.stepSupportsVision).toContain(true);

    // 第二轮请求必须携带图片；且图片挂在 user 消息上（tool 消息无法承载图片）。
    const secondRequestMessages = adapter.stepMessages[1];
    expect(hasImageCarrierMessage(secondRequestMessages)).toBe(true);

    const imageCarrier = secondRequestMessages.find(
      (message) => message.role === 'user' && message.imageParts && message.imageParts.length > 0,
    );
    expect(imageCarrier?.imageParts?.[0]?.dataUrl).toBe(IMAGE_PART.dataUrl);

    const toolMessageIndex = secondRequestMessages.findIndex((message) => message.role === 'tool');
    const carrierIndex = secondRequestMessages.findIndex(
      (message) => message.role === 'user' && message.imageParts && message.imageParts.length > 0,
    );
    expect(toolMessageIndex).toBeGreaterThanOrEqual(0);
    // 图片载体消息紧跟工具结果之后，保证模型在同一上下文里看到图文。
    expect(carrierIndex).toBeGreaterThan(toolMessageIndex);
  });

  it('does not inject an image carrier message when the model does not support vision', async () => {
    const { runner, adapter } = buildRunner(false);

    const result = await runner.run({
      goal: 'Read a scanned image through the read tool',
      sessionId: 'session-image-2',
      providerId: 'vision-provider',
      modelId: 'vision-model',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(adapter.stepMessages.length).toBeGreaterThanOrEqual(2);
    expect(adapter.stepSupportsVision).not.toContain(true);

    for (const messages of adapter.stepMessages) {
      expect(hasImageCarrierMessage(messages)).toBe(false);
    }
  });

  it('injects the image carrier message on the executeTurn (legacy) tool path too', async () => {
    const { runner, adapter } = buildRunner(true);

    await runner.executeTurn({
      context: { taskLog: 'Read an image', turns: [], contextSummary: {} },
      providerId: 'vision-provider',
      modelId: 'vision-model',
    } as unknown as Parameters<typeof runner.executeTurn>[0]);

    expect(adapter.stepMessages.length).toBeGreaterThanOrEqual(2);
    const secondRequestMessages = adapter.stepMessages[1];
    expect(hasImageCarrierMessage(secondRequestMessages)).toBe(true);
  });
});
