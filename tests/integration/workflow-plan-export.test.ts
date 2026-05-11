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

describeIfNodeSqlite('workflow plan export integration', () => {
  it('keeps the runtime plan in .plans and exports the final version to the deliverable path on completion', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-export-'));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const config = createTestAppConfig({
      databasePath: path.join(tempDir, 'pueblo.db'),
      defaultProviderId: 'openai',
      defaultSessionId: null,
      pepe: { enabled: false },
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
      providers: [{ providerId: 'openai', defaultModelId: 'gpt-4.1-mini', enabled: true, credentialSource: 'env' }],
    });

    const cli = createCliDependencies(config);

    try {
      const start = await cli.dispatcher.dispatch({ input: '/workflow deliver the final engineering plan' });
      expect(start.ok).toBe(true);

      const startData = start.data as {
        runtimePlanPath: string;
        deliverablePlanPath: string | null;
      };
      expect(startData.runtimePlanPath).toContain(`${path.sep}.plans${path.sep}`);
      expect(startData.deliverablePlanPath).toBeTruthy();
      expect(fs.existsSync(startData.runtimePlanPath)).toBe(true);
      expect(startData.deliverablePlanPath ? fs.existsSync(startData.deliverablePlanPath) : false).toBe(false);

      const taskResult = await cli.dispatcher.dispatch({ input: '/task-run complete the active workflow round' });
      expect(taskResult.ok).toBe(true);

      const deliverablePlanPath = startData.deliverablePlanPath;
      expect(deliverablePlanPath).toBeTruthy();
      expect(deliverablePlanPath ? fs.existsSync(deliverablePlanPath) : false).toBe(true);
      expect(deliverablePlanPath ? fs.readFileSync(deliverablePlanPath, 'utf8') : '').toContain('# Plan: deliver the final engineering plan');
    } finally {
      cli.databaseClose();
    }
  });
});