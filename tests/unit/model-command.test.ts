import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('model command and task flow', () => {
  it('lists models, selects one, and runs a persisted task', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-cli-'));
    tempDirs.push(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: 'session-1',
      providers: [
        { providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' },
        { providerId: 'anthropic', defaultModelId: 'claude-sonnet-4', enabled: true, credentialSource: 'env' },
      ],
    });

    const cli = createCliDependencies(config);

    try {
      const listResult = await cli.dispatcher.dispatch({ input: '/model' });
      await cli.dispatcher.dispatch({ input: '/new repo work' });
      const created = await cli.dispatcher.dispatch({ input: '/new repo work' });
      const createdSessionId = (created.data as { id: string }).id;
      const selectResult = await cli.dispatcher.dispatch({ input: '/model anthropic claude-sonnet-4' });
      const taskResult = await cli.dispatcher.dispatch({ input: '/task-run inspect repo' });

      expect(listResult.ok).toBe(true);
      expect(selectResult.ok).toBe(true);
      expect(taskResult.ok).toBe(true);
      expect(taskResult.data).toMatchObject({
        sessionId: createdSessionId,
        modelId: 'claude-sonnet-4',
        status: 'completed',
      });
    } finally {
      cli.databaseClose();
    }
  });
});
