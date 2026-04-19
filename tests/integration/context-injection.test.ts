import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
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

describeIfNodeSqlite('context injection integration', () => {
  it('injects selected prompt and memory into task execution context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-context-injection-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      await cli.dispatcher.dispatch({ input: '/new context task' });
      const prompt = await cli.dispatcher.dispatch({ input: '/prompt-add bugfix Analyze root cause first' });
      const memory = await cli.dispatcher.dispatch({ input: '/memory-add session Repo uses sqlite session' });
      await cli.dispatcher.dispatch({ input: `/prompt-sel ${(prompt.data as { id: string }).id}` });
      await cli.dispatcher.dispatch({ input: `/memory-sel ${(memory.data as { id: string }).id}` });
      const result = await cli.dispatcher.dispatch({ input: '/task-run inspect current bug' });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain('promptIds');
      expect(JSON.stringify(result.data)).toContain('memoryIds');
      expect(JSON.stringify(result.data)).toContain('toolResults');
    } finally {
      cli.databaseClose();
    }
  });
});
