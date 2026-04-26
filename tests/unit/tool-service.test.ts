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
  providerExecToolInputSchema,
  providerGlobToolInputSchema,
  providerGrepToolInputSchema,
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

    expect(service.describeTools()).toEqual([
      {
        name: 'glob',
        description: 'Match repository paths by glob pattern relative to the workspace root.',
        inputSchema: providerGlobToolInputSchema,
      },
      {
        name: 'grep',
        description: 'Search repository files by regex pattern and optional include glob.',
        inputSchema: providerGrepToolInputSchema,
      },
      {
        name: 'exec',
        description: 'Run a local executable command without a shell using the workspace as cwd.',
        inputSchema: providerExecToolInputSchema,
      },
    ]);
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
