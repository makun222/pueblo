import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { runMigrations } from '../../src/persistence/migrate';
import { WorkflowRepository } from '../../src/workflow/workflow-repository';
import { WorkflowService } from '../../src/workflow/workflow-service';
import { WorkflowRegistry } from '../../src/workflow/workflow-registry';
import { WorkflowPlanStore } from '../../src/workflow/workflow-plan-store';
import { WorkflowExporter } from '../../src/workflow/workflow-exporter';
import { createWorkflowInstanceModel } from '../../src/workflow/workflow-model';
import { renderPuebloPlanMarkdown, type PuebloPlanDocument } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';
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

describeIfNodeSqlite('workflow recovery integration', () => {
  it('recovers workflow status and active round from the runtime plan stored on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-recovery-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'pueblo.db');
    const database = createSqliteDatabase({ dbPath });
    runMigrations(database.connection);

    const config = createTestAppConfig({
      databasePath: dbPath,
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new WorkflowRepository({ connection: database.connection });
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: 'pueblo-plan', description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-1',
      type: 'pueblo-plan',
      goal: 'Recover persisted workflow state',
      status: 'planning',
      sessionId: 'session-1',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-1', 'recover-persisted-workflow-state.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'recover-persisted-workflow-state.plan.md'),
    });
    planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(createRecoveredPlan(workflow)));

    try {
      const recovered = workflowService.recoverWorkflowFromRuntimePlan(workflow.id);

      expect(recovered).not.toBeNull();
      expect(recovered?.workflow.status).toBe('round-active');
      expect(recovered?.workflow.activeRoundNumber).toBe(2);
      expect(repository.getById(workflow.id)?.status).toBe('round-active');
    } finally {
      database.close();
    }
  });
});

function createRecoveredPlan(workflow: ReturnType<typeof createWorkflowInstanceModel>): PuebloPlanDocument {
  return {
    workflowId: workflow.id,
    workflowType: workflow.type,
    status: 'round-active',
    routeReason: 'explicit',
    sessionId: workflow.sessionId ?? 'session-1',
    goal: workflow.goal,
    runtimePlanPath: workflow.runtimePlanPath,
    deliverablePlanPath: workflow.deliverablePlanPath,
    constraints: [],
    acceptanceCriteria: [],
    tasks: [
      { id: 'task-root', title: 'Root', parentId: null, status: 'in-progress' },
      { id: 'task-1', title: 'Completed prior round', parentId: 'task-root', status: 'completed' },
      { id: 'task-2', title: 'Current active round', parentId: 'task-root', status: 'in-progress' },
    ],
    activeRoundNumber: 2,
    rounds: [
      { roundNumber: 1, taskIds: ['task-1'], status: 'completed', summary: 'Round one complete.' },
      { roundNumber: 2, taskIds: ['task-2'], status: 'active', summary: null },
    ],
    executionLog: [],
    createdAt: workflow.createdAt,
    updatedAt: new Date().toISOString(),
  };
}