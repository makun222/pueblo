import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
import { AgentTaskRepository } from '../../src/agent/task-repository';
import { ToolInvocationRepository } from '../../src/tools/tool-invocation-repository';
import { ToolService } from '../../src/tools/tool-service';
import {
  getToolExecutionPolicy,
  providerEditToolInputSchema,
  providerExecToolInputSchema,
  providerGlobToolInputSchema,
  providerGrepToolInputSchema,
  providerReadToolInputSchema,
} from '../../src/providers/provider-adapter';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows file locks in test cleanup.
      }
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('tool service', () => {
  it('describes tools with valid object JSON schemas', () => {
    const repository = {
      create() {
        throw new Error('not used');
      },
      listByTask() {
        return [];
      },
    } as unknown as ToolInvocationRepository;
    const service = new ToolService({ repository, cwd: process.cwd() });
    const taskRootExplanation = 'The task root is the task target directory when one is set; otherwise it is the workspace root.';

    expect(service.describeTools()).toEqual([
      {
        name: 'glob',
        description: `Match repository paths by glob pattern relative to the current task root. ${taskRootExplanation}`,
        inputSchema: providerGlobToolInputSchema,
        executionPolicy: getToolExecutionPolicy('glob'),
      },
      {
        name: 'grep',
        description: `Search repository files by regex pattern and optional include glob under the current task root. ${taskRootExplanation}`,
        inputSchema: providerGrepToolInputSchema,
        executionPolicy: getToolExecutionPolicy('grep'),
      },
      {
        name: 'exec',
        description: `Run a local executable command without a shell using the current task root as cwd. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerExecToolInputSchema,
        executionPolicy: getToolExecutionPolicy('exec'),
      },
      {
        name: 'read',
        description: `Read a text file by relative path or absolute path within the current task root and return numbered lines with bounded output. Optionally provide startLine and endLine to read a specific range. ${taskRootExplanation}`,
        inputSchema: providerReadToolInputSchema,
        executionPolicy: getToolExecutionPolicy('read'),
      },
      {
        name: 'edit',
        description: `Edit a text file within the current task root by replacing one exact text match, optionally constrained to a line range. ${taskRootExplanation} Requires user approval before execution.`,
        inputSchema: providerEditToolInputSchema,
        executionPolicy: getToolExecutionPolicy('edit'),
      },
    ]);
  });

  it('reads a workspace file with bounded numbered output', async () => {
    const repository = {
      create() {
        return { id: 'tool-invocation-1' };
      },
      listByTask() {
        return [];
      },
    } as unknown as ToolInvocationRepository;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-read-tool-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'alpha\nbeta\ngamma', 'utf8');
    const service = new ToolService({ repository, cwd: tempDir });

    const result = await service.execute({
      taskId: 'task-1',
      toolName: 'read',
      args: { path: 'sample.txt' },
    });

    expect(result.output.toolName).toBe('read');
    expect(result.output.status).toBe('succeeded');
    expect(result.output.output).toEqual(['1: alpha', '2: beta', '3: gamma']);
  });

  it('persists tool invocation history for a task', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-tool-service-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    try {
      const taskRepository = new AgentTaskRepository({ connection: database.connection });
      taskRepository.create({
        goal: 'test tools',
        sessionId: 'session-1',
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        inputContextSummary: 'tool test',
        status: 'completed',
        outputSummary: 'ok',
        toolInvocationIds: [],
      });

      const repository = new ToolInvocationRepository({ connection: database.connection });
      const service = new ToolService({ repository, cwd: process.cwd() });
      const createdTask = taskRepository.listBySession('session-1')[0];
      const result = await service.runAll(createdTask!.id);

      expect(result.invocations).toHaveLength(3);
      expect(result.outputs.map((output) => output.toolName)).toEqual(['glob', 'grep', 'exec']);
    } finally {
      database.close();
    }
  });
});
