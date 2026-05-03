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

  it('keeps an external repository path as the active tool root across follow-up turns', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-external-repo-workspace-'));
    const externalRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-external-repo-target-'));
    tempDirs.push(workspaceDir, externalRepoDir);
    process.chdir(workspaceDir);

    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'src', 'wrong.ts'), 'export const wrong = true;', 'utf8');
    fs.mkdirSync(path.join(externalRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(externalRepoDir, 'src', 'right.ts'), 'export const right = true;', 'utf8');
    fs.writeFileSync(path.join(externalRepoDir, 'package.json'), '{"name":"knowledge-base"}', 'utf8');

    let requestCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      requestCount += 1;
      const requestBody = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
      };
      const messages = requestBody.messages ?? [];
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content ?? '')
        .join('\n\n');

      if (requestCount === 1) {
        expect(systemText).toContain(`Use ${externalRepoDir} as the repository root for this task.`);

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect the repository structure first.',
                tool_calls: [
                  {
                    id: 'glob-call-1',
                    type: 'function',
                    function: {
                      name: 'glob',
                      arguments: JSON.stringify({ pattern: 'src/**/*' }),
                    },
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 2) {
        const toolMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'glob-call-1');
        expect(toolMessage?.content).toContain('src/right.ts');
        expect(toolMessage?.content).not.toContain('src/wrong.ts');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'The repository contains a src/right.ts file.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 3) {
        expect(systemText).toContain(`Use ${externalRepoDir} as the repository root for this task.`);
        expect(systemText).toContain(externalRepoDir);

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect the source tree for the follow-up question.',
                tool_calls: [
                  {
                    id: 'glob-call-2',
                    type: 'function',
                    function: {
                      name: 'glob',
                      arguments: JSON.stringify({ pattern: 'src/**/*' }),
                    },
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 4) {
        const toolMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'glob-call-2');
        expect(toolMessage?.content).toContain('src/right.ts');
        expect(toolMessage?.content).not.toContain('src/wrong.ts');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'This directory is a small TypeScript project with src/right.ts.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch invocation count: ${requestCount}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const config = createTestAppConfig({
      databasePath: path.join(workspaceDir, 'pueblo.db'),
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
      const firstResult = await cli.submitInput(`${externalRepoDir}，解析一下这个地址的项目。`);
      const secondResult = await cli.submitInput('继续分析 source code');
      const secondPayload = extractTaskOutputSummaryPayload(secondResult.data && typeof secondResult.data === 'object' && 'outputSummary' in secondResult.data
        ? String((secondResult.data as { outputSummary?: string | null }).outputSummary ?? '')
        : null);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(secondPayload?.outputSummary).toBe('This directory is a small TypeScript project with src/right.ts.');
      expect(JSON.stringify(secondResult.data)).toContain('glob');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      cli.databaseClose();
    }
  });

  it('switches the active tool root when a later turn provides a new absolute repository path', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-repo-switch-workspace-'));
    const firstRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-repo-switch-first-'));
    const secondRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-repo-switch-second-'));
    tempDirs.push(workspaceDir, firstRepoDir, secondRepoDir);
    process.chdir(workspaceDir);

    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'src', 'workspace.ts'), 'export const workspace = true;', 'utf8');
    fs.mkdirSync(path.join(firstRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(firstRepoDir, 'src', 'first.ts'), 'export const first = true;', 'utf8');
    fs.mkdirSync(path.join(secondRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(secondRepoDir, 'src', 'second.ts'), 'export const second = true;', 'utf8');

    let requestCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      requestCount += 1;
      const requestBody = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
      };
      const messages = requestBody.messages ?? [];
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content ?? '')
        .join('\n\n');

      if (requestCount === 1) {
        expect(systemText).toContain(`Use ${firstRepoDir} as the repository root for this task.`);

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect the first repository structure.',
                tool_calls: [
                  {
                    id: 'glob-call-first',
                    type: 'function',
                    function: {
                      name: 'glob',
                      arguments: JSON.stringify({ pattern: 'src/**/*' }),
                    },
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 2) {
        const toolMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'glob-call-first');
        expect(toolMessage?.content).toContain('src/first.ts');
        expect(toolMessage?.content).not.toContain('src/second.ts');
        expect(toolMessage?.content).not.toContain('src/workspace.ts');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'The first repository contains src/first.ts.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 3) {
        expect(systemText).toContain(`Use ${secondRepoDir} as the repository root for this task.`);
        expect(systemText).not.toContain(`Use ${firstRepoDir} as the repository root for this task.`);

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'I should inspect the second repository structure.',
                tool_calls: [
                  {
                    id: 'glob-call-second',
                    type: 'function',
                    function: {
                      name: 'glob',
                      arguments: JSON.stringify({ pattern: 'src/**/*' }),
                    },
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (requestCount === 4) {
        const toolMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'glob-call-second');
        expect(toolMessage?.content).toContain('src/second.ts');
        expect(toolMessage?.content).not.toContain('src/first.ts');
        expect(toolMessage?.content).not.toContain('src/workspace.ts');

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: 'The second repository contains src/second.ts.',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch invocation count: ${requestCount}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const config = createTestAppConfig({
      databasePath: path.join(workspaceDir, 'pueblo.db'),
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
      const firstResult = await cli.submitInput(`${firstRepoDir}，解析一下这个地址的项目。`);
      const secondResult = await cli.submitInput(`简单介绍一下这个目录下的工程，${secondRepoDir}。`);
      const secondPayload = extractTaskOutputSummaryPayload(secondResult.data && typeof secondResult.data === 'object' && 'outputSummary' in secondResult.data
        ? String((secondResult.data as { outputSummary?: string | null }).outputSummary ?? '')
        : null);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(secondPayload?.outputSummary).toBe('The second repository contains src/second.ts.');
      expect(JSON.stringify(secondResult.data)).toContain('glob');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      cli.databaseClose();
    }
  });
});
