import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { SessionRepository } from '../../src/sessions/session-repository';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';
import { extractTaskOutputSummaryPayload } from '../../src/shared/result';

const tempDirs: string[] = [];
let previousCwd = process.cwd();

beforeEach(() => {
  previousCwd = process.cwd();
});

afterEach(() => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

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

  it('routes plain-text DeepSeek tasks through the read tool without surfacing unsupported tool errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-tool-workflow-deepseek-read-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'alpha\nbeta\ngamma', 'utf8');

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect the file directly.',
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
        const requestBody = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
        };
        const toolMessage = requestBody.messages?.find((message) => message.role === 'tool' && message.tool_call_id === 'read-call-1');

        expect(toolMessage?.content).toContain('1: alpha');
        expect(toolMessage?.content).toContain('2: beta');
        expect(toolMessage?.content).toContain('3: gamma');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'The file contains alpha, beta, and gamma.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
    vi.stubGlobal('fetch', fetchImpl);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'deepseek',
      defaultSessionId: null,
      providers: [{ providerId: 'deepseek', defaultModelId: 'deepseek-v4-pro', enabled: true, credentialSource: 'config-file' }],
      deepseek: {
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com',
      },
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/model deepseek deepseek-v4-pro' });
      const result = await cli.submitInput('Read sample.txt and summarize it.');
      const runtimeStatus = cli.getRuntimeStatus();
      const payload = extractTaskOutputSummaryPayload(result.data && typeof result.data === 'object' && 'outputSummary' in result.data
        ? String((result.data as { outputSummary?: string | null }).outputSummary ?? '')
        : null);

      expect(result.ok).toBe(true);
      expect(result.code).toBe('TASK_COMPLETED');
      expect(result.message).toBe('Agent task completed');
      expect(runtimeStatus.providerId).toBe('deepseek');
      expect(runtimeStatus.modelId).toBe('deepseek-v4-pro');
      expect(payload?.outputSummary).toBe('The file contains alpha, beta, and gamma.');
      expect(JSON.stringify(result.data)).toContain('"toolName":"read"');
      expect(JSON.stringify(result.data)).not.toContain('unsupported tool call');
    } finally {
      cli.databaseClose();
    }
  });
});
