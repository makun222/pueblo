import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';

const tempDirs: string[] = [];
let previousCwd = process.cwd();

beforeEach(() => {
  previousCwd = process.cwd();
});

afterEach(() => {
  process.chdir(previousCwd);

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const describeIfNodeSqlite = nodeSqliteAvailable ? describe : describe.skip;

describeIfNodeSqlite('workflow pass-through integration', () => {
  it('keeps simple plain text on the normal task path instead of starting a workflow', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-pass-through-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const runtimePlansDir = path.join(tempDir, '.plans');
    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: { enabled: false },
      workflow: {
        runtimeDirectory: runtimePlansDir,
      },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      const result = await cli.submitInput('inspect repo');

      expect(result.ok).toBe(true);
      expect(result.code).toBe('TASK_COMPLETED');
      expect(fs.existsSync(runtimePlansDir)).toBe(false);
    } finally {
      cli.databaseClose();
    }
  });
});
