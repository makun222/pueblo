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

describe('tool workflow integration', () => {
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
});
