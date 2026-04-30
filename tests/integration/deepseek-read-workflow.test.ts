import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { DeepSeekAdapter } from '../../src/providers/deepseek-adapter';
import { createDeepSeekProfile } from '../../src/providers/deepseek-profile';
import { ToolService } from '../../src/tools/tool-service';
import { extractTaskOutputSummaryPayload } from '../../src/shared/result';
import type { AgentTask } from '../../src/shared/schema';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('DeepSeek read workflow integration', () => {
  it('runs a complete read tool loop and produces a final answer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-deepseek-read-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'alpha\nbeta\ngamma', 'utf8');

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should read the sample file first.',
                reasoning_content: 'The answer depends on the file contents.',
                tool_calls: [
                  {
                    id: 'read-call-1',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: JSON.stringify({ path: 'sample.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
        };
        const toolMessage = body.messages?.find((message) => message.role === 'tool' && message.tool_call_id === 'read-call-1');

        expect(toolMessage?.content).toContain('1: alpha');
        expect(toolMessage?.content).toContain('2: beta');
        expect(toolMessage?.content).toContain('3: gamma');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'The sample file contains alpha, beta, and gamma.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      createDeepSeekProfile('configured', 'deepseek-v4-pro'),
      new DeepSeekAdapter({
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com',
        fetchImpl,
      }),
    );

    const persistedTasks = new Map<string, AgentTask>();
    const repository = {
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
          id: 'task-1',
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

    const invocationIds: string[] = [];
    const toolRepository = {
      create(input: { toolName: string }) {
        const invocation = { id: `tool-${invocationIds.length + 1}`, ...input };
        invocationIds.push(invocation.id);
        return invocation;
      },
      listByTask() {
        return [];
      },
    } as unknown as import('../../src/tools/tool-invocation-repository').ToolInvocationRepository;

    const toolService = new ToolService({ repository: toolRepository, cwd: tempDir });
    const runner = new AgentTaskRunner(providerRegistry, repository, toolService);

    const task = await runner.run({
      goal: 'Read sample.txt and summarize it.',
      sessionId: null,
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputContextSummary: 'Integration test for DeepSeek read tool',
    });

    const payload = extractTaskOutputSummaryPayload(task.outputSummary);

    expect(task.status).toBe('completed');
    expect(task.toolInvocationIds).toEqual(['tool-1']);
    expect(payload?.outputSummary).toBe('The sample file contains alpha, beta, and gamma.');
    expect(payload?.toolResults).toEqual([
      {
        toolName: 'read',
        status: 'succeeded',
        summary: 'Read 3 line(s) from sample.txt',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});