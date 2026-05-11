import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliDependencies } from '../../src/cli/index';
import { createTestAppConfig } from '../helpers/test-config';
import { nodeSqliteAvailable } from '../helpers/sqlite-runtime';
import { parsePuebloPlanMarkdown } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
import { extractTaskOutputSummaryPayload } from '../../src/shared/result';

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

describeIfNodeSqlite('workflow rounds integration', () => {
  it('creates an initial todo round and todo memory when workflow starts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-rounds-'));
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
      const result = await cli.dispatcher.dispatch({ input: '/workflow create the migration rollout plan' });

      expect(result.ok).toBe(true);
      const data = result.data as {
        sessionId: string;
        runtimePlanPath: string;
        todoMemoryId: string | null;
        activeRoundNumber: number | null;
      };

      expect(data.activeRoundNumber).toBe(1);
      expect(data.todoMemoryId).toBeTruthy();

      const plan = parsePuebloPlanMarkdown(fs.readFileSync(data.runtimePlanPath, 'utf8'));
      expect(plan.activeRoundNumber).toBe(1);
      expect(plan.rounds).toHaveLength(1);
      expect(plan.tasks.some((task) => task.status === 'in-progress')).toBe(true);

      const memories = cli.listSessionMemories(data.sessionId);
      expect(memories.some((memory) => memory.id === data.todoMemoryId && memory.tags.includes('todo'))).toBe(true);

      const taskResult = await cli.dispatcher.dispatch({ input: '/task-run continue the current workflow round' });
      expect(taskResult.ok).toBe(true);

      const payload = extractTaskOutputSummaryPayload(
        taskResult.data && typeof taskResult.data === 'object' && 'outputSummary' in taskResult.data
          ? String((taskResult.data as { outputSummary?: string | null }).outputSummary ?? '')
          : null,
      );
      expect(payload?.workflow?.workflowId).toBe(plan.workflowId);
      expect(payload?.workflow?.activeRoundNumber).toBe(1);

      const rewrittenPlan = parsePuebloPlanMarkdown(fs.readFileSync(data.runtimePlanPath, 'utf8'));
      expect(rewrittenPlan.status).toBe('completed');
      expect(rewrittenPlan.activeRoundNumber).toBeNull();
      expect(rewrittenPlan.rounds[0]?.status).toBe('completed');
      expect(rewrittenPlan.tasks.every((task) => task.status === 'completed')).toBe(true);
    } finally {
      cli.databaseClose();
    }
  });
});
