import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTaskRepository } from '../../src/agent/task-repository';
import { AgentTaskRunner } from '../../src/agent/task-runner';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult, ProviderStepContext, ProviderStepResult } from '../../src/providers/provider-adapter';
import { createProviderProfile } from '../../src/providers/provider-profile';
import { InMemoryProviderAdapter } from '../../src/providers/provider-adapter';
import { ProviderRegistry } from '../../src/providers/provider-registry';
import { ToolService } from '../../src/tools/tool-service';
import type { ExecuteToolRequest } from '../../src/tools/tool-service';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows may hold the SQLite WAL files briefly.
      }
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

class DeferredProviderAdapter implements ProviderAdapter {
  private resolveResponse: ((value: ProviderRunResult) => void) | null = null;
  readonly pendingRequest = new Promise<ProviderRunRequest>((resolve) => {
    this.captureRequest = resolve;
  });
  readonly pendingStep = new Promise<ProviderStepContext>((resolve) => {
    this.captureStep = resolve;
  });
  private captureRequest: ((value: ProviderRunRequest) => void) | null = null;
  private captureStep: ((value: ProviderStepContext) => void) | null = null;
  readonly result = new Promise<ProviderRunResult>((resolve) => {
    this.resolveResponse = resolve;
  });

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    this.captureStep?.(context);
    const result = await this.result;
    return {
      type: 'final',
      outputSummary: result.outputSummary,
    };
  }

  async runTask(request: ProviderRunRequest): Promise<ProviderRunResult> {
    this.captureRequest?.(request);
    return this.result;
  }

  resolve(outputSummary: string): void {
    this.resolveResponse?.({ outputSummary });
  }
}

class FailingProviderAdapter implements ProviderAdapter {
  constructor(private readonly message: string) {}

  async runStep(): Promise<ProviderStepResult> {
    throw new Error(this.message);
  }

  async runTask(): Promise<ProviderRunResult> {
    throw new Error(this.message);
  }
}

class ToolCallingProviderAdapter implements ProviderAdapter {
  private hasRequestedTool = false;

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (!this.hasRequestedTool) {
      this.hasRequestedTool = true;
      return {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'grep',
        args: { pattern: 'task', include: '*.ts' },
        rationale: 'Search task-related files first',
      };
    }

    const toolMessage = context.messages.find((message) => message.role === 'tool');
    return {
      type: 'final',
      outputSummary: `Tool-informed result: ${toolMessage?.content ?? 'missing tool output'}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

class MultiToolCallingProviderAdapter implements ProviderAdapter {
  private hasRequestedTools = false;

  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (!this.hasRequestedTools) {
      this.hasRequestedTools = true;
      return {
        type: 'tool-calls',
        rationale: 'Inspect files and search contents first',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'glob',
            args: { pattern: 'src/**/*.ts' },
          },
          {
            toolCallId: 'call-2',
            toolName: 'grep',
            args: { pattern: 'task', include: '*.ts' },
          },
        ],
      };
    }

    const assistantMessage = context.messages.find((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) === 2);
    const toolMessages = context.messages.filter((message) => message.role === 'tool');

    return {
      type: 'final',
      outputSummary: `Grouped tool result: assistantTools=${assistantMessage?.toolCalls?.length ?? 0}; toolMessages=${toolMessages.length}`,
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

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

class InspectingRepeatedReadProviderAdapter implements ProviderAdapter {
  async runStep(context: ProviderStepContext): Promise<ProviderStepResult> {
    const toolMessages = context.messages.filter((message) => message.role === 'tool');

    if (toolMessages.length < 2) {
      const nextToolCallIndex = toolMessages.length + 1;
      return {
        type: 'tool-call',
        toolCallId: `call-${nextToolCallIndex}`,
        toolName: 'read',
        args: { path: 'notes.txt' },
        rationale: `Read attempt ${nextToolCallIndex}`,
      };
    }

    const firstToolPayload = JSON.parse(toolMessages[0]!.content) as Record<string, unknown>;
    const secondToolPayload = JSON.parse(toolMessages[1]!.content) as Record<string, unknown>;
    return {
      type: 'final',
      outputSummary: JSON.stringify({
        firstCompressed: firstToolPayload.compression,
        firstHasPreview: Array.isArray(firstToolPayload.outputPreview),
        firstHasFullOutput: Array.isArray(firstToolPayload.output),
        secondHasFullOutput: Array.isArray(secondToolPayload.output),
        secondCompressed: secondToolPayload.compression ?? null,
      }),
    };
  }

  async runTask(): Promise<ProviderRunResult> {
    return { outputSummary: 'unused legacy mode' };
  }
}

describeIfNodeSqlite('agent task persistence integration', () => {
  it('runs a provider-backed task and persists task history to sqlite', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-task-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new InMemoryProviderAdapter(profile.id, 'done'));

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository);

    const result = await runner.run({
      goal: 'Summarize the repository state',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    const persisted = repository.listBySession('session-1');

    expect(result.status).toBe('completed');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.outputSummary).toContain('done');

    database.close();
  });

  it('persists a running task before the provider responds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-running-task-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    const adapter = new DeferredProviderAdapter();
    registry.register(profile, adapter);

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository);

    const runPromise = runner.run({
      goal: 'Summarize the repository state',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    await adapter.pendingStep;

    const persistedWhileRunning = repository.listBySession('session-1');
    expect(persistedWhileRunning).toHaveLength(1);
    expect(persistedWhileRunning[0]?.status).toBe('running');
    expect(persistedWhileRunning[0]?.completedAt).toBeNull();

    adapter.resolve('done');
    const result = await runPromise;
    expect(result.status).toBe('completed');

    database.close();
  });

  it('persists failed tasks when the provider throws', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-provider-failure-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new FailingProviderAdapter('provider exploded'));

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository);

    await expect(
      runner.run({
        goal: 'Summarize the repository state',
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        inputContextSummary: 'No additional context',
      }),
    ).rejects.toThrow('provider exploded');

    const persisted = repository.listBySession('session-1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe('failed');
    expect(persisted[0]?.outputSummary).toContain('provider exploded');

    database.close();
  });

  it('persists failed tasks when tool execution throws after model output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-tool-failure-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new InMemoryProviderAdapter(profile.id, 'model complete'));

    const repository = new AgentTaskRepository({ connection: database.connection });
    const failingToolService = {
      async runForTask() {
        throw new Error('tool exploded');
      },
    } as unknown as ToolService;
    const runner = new AgentTaskRunner(registry, repository, failingToolService);

    await expect(
      runner.run({
        goal: 'Inspect the repository state',
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        inputContextSummary: 'No additional context',
      }),
    ).rejects.toThrow('tool exploded');

    const persisted = repository.listBySession('session-1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe('failed');
    expect(persisted[0]?.outputSummary).toContain('tool exploded');
    expect(persisted[0]?.outputSummary).toContain('model complete');

    database.close();
  });

  it('supports a tool-call step before producing the final answer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-tool-call-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new ToolCallingProviderAdapter());

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository, {
      describeTools: () => [
        {
          name: 'grep',
          description: 'Search files',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      ],
      async execute() {
        return {
          invocation: { id: 'tool-invocation-1' },
          output: {
            toolName: 'grep',
            status: 'succeeded',
            summary: 'Matched 1 file',
            output: ['src/agent/task-runner.ts'],
          },
        };
      },
    } as unknown as ToolService);

    const result = await runner.run({
      goal: 'Inspect repository state',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(result.outputSummary).toContain('Tool-informed result');
    expect(result.outputSummary).toContain('toolInvocationIds');

    database.close();
  });

  it('supports grouped tool calls before producing the final answer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-multi-tool-call-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new MultiToolCallingProviderAdapter());

    const repository = new AgentTaskRepository({ connection: database.connection });
    const runner = new AgentTaskRunner(registry, repository, {
      describeTools: () => [
        {
          name: 'glob',
          description: 'Find files',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
        {
          name: 'grep',
          description: 'Search files',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              include: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      ],
      async execute(input: ExecuteToolRequest) {
        return {
          invocation: { id: `tool-invocation-${input.toolName}` },
          output: {
            toolName: input.toolName,
            status: 'succeeded',
            summary: `Executed ${input.toolName}`,
            output: input.toolName === 'glob' ? ['src/main.ts'] : ['src/agent/task-runner.ts'],
          },
        };
      },
    } as unknown as ToolService);

    const result = await runner.run({
      goal: 'Inspect repository state',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(result.outputSummary).toContain('assistantTools=2');
    expect(result.outputSummary).toContain('toolMessages=2');

    database.close();
  });

  it('allows longer tool workflows before hitting the default step limit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-repeated-tool-call-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new RepeatedToolCallingProviderAdapter(8));

    const repository = new AgentTaskRepository({ connection: database.connection });
    let invocationCount = 0;
    const runner = new AgentTaskRunner(registry, repository, {
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
    } as unknown as ToolService);

    const result = await runner.run({
      goal: 'Inspect repository state with repeated reads',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(invocationCount).toBe(8);
    expect(result.outputSummary).toContain('Completed after 8 tool call(s)');

    database.close();
  });

  it('compacts older tool results while preserving the latest tool output for the next step', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-agent-compact-tool-history-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const profile = createProviderProfile({
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-4.1-mini',
      models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsTools: true }],
    });
    const registry = new ProviderRegistry();
    registry.register(profile, new InspectingRepeatedReadProviderAdapter());

    const repository = new AgentTaskRepository({ connection: database.connection });
    let invocationCount = 0;
    const runner = new AgentTaskRunner(registry, repository, {
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
            output: Array.from({ length: 40 }, (_, index) => `${index + 1}: line ${invocationCount}-${index + 1}`),
          },
        };
      },
    } as unknown as ToolService);

    const result = await runner.run({
      goal: 'Inspect repository state with repeated reads',
      sessionId: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      inputContextSummary: 'No additional context',
    });

    expect(result.status).toBe('completed');
    expect(invocationCount).toBe(2);

    const inspection = JSON.parse(result.outputSummary ?? '{}') as Record<string, unknown>;
    expect(inspection.firstCompressed).toBe('older-tool-result-compacted');
    expect(inspection.firstHasPreview).toBe(true);
    expect(inspection.firstHasFullOutput).toBe(false);
    expect(inspection.secondHasFullOutput).toBe(true);
    expect(inspection.secondCompressed).toBeNull();

    database.close();
  });
});
