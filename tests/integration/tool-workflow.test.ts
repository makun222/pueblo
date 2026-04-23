import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { SessionRepository } from '../../src/sessions/session-repository';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('tool workflow integration', () => {
  it('runs task-relevant tools with persisted tool invocation history', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-tool-workflow-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/new tool task' });
      await cli.dispatcher.dispatch({ input: '/model openai gpt-4.1-mini' });
      const result = await cli.dispatcher.dispatch({ input: '/task-run inspect workflow with tools' });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain('toolInvocationIds');
      expect(JSON.stringify(result.data)).toContain('grep');
      expect(JSON.stringify(result.data)).toContain('glob');
      expect(JSON.stringify(result.data)).toContain('exec');
    } finally {
      cli.databaseClose();
    }
  });

  it('skips tool execution for simple conversational goals', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-tool-workflow-skip-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/new plain task' });
      await cli.dispatcher.dispatch({ input: '/model openai gpt-4.1-mini' });
      const result = await cli.dispatcher.dispatch({ input: '/task-run summarize current state' });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain('toolInvocationIds');
      expect(JSON.stringify(result.data)).not.toContain('"grep"');
      expect(JSON.stringify(result.data)).not.toContain('"glob"');
      expect(JSON.stringify(result.data)).not.toContain('"exec"');
    } finally {
      cli.databaseClose();
    }
  });

  it('auto-creates a session and records user and assistant turns for plain-text tasks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-tool-workflow-history-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/model openai gpt-4.1-mini' });
      const result = await cli.submitInput('inspect repo');
      const runtimeStatus = cli.getRuntimeStatus();

      expect(result.ok).toBe(true);
      expect(runtimeStatus.activeSessionId).not.toBeNull();

      cli.databaseClose();

      const database = createSqliteDatabase({ dbPath: config.databasePath });
      const repository = new SessionRepository({ connection: database.connection });
      const session = repository.getCurrentSession();

      expect(session?.messageHistory).toHaveLength(2);
      expect(session?.messageHistory[0]).toMatchObject({
        role: 'user',
        content: 'inspect repo',
      });
      expect(session?.messageHistory[1]).toMatchObject({
        role: 'assistant',
        content: 'Task completed: inspect repo',
      });

      database.close();
    } finally {
      try {
        cli.databaseClose();
      } catch {
        // Ignore repeated close calls during test cleanup.
      }
    }
  });
});
