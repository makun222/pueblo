import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestAppConfig } from '../helpers/test-config';
import { WorkflowPlanStore } from '../../src/workflow/workflow-plan-store';
import { WorkflowExporter } from '../../src/workflow/workflow-exporter';
import { WorkflowRegistry } from '../../src/workflow/workflow-registry';
import { InMemoryWorkflowRepository } from '../../src/workflow/workflow-repository';
import { WorkflowService } from '../../src/workflow/workflow-service';
import { createWorkflowInstanceModel } from '../../src/workflow/workflow-model';
import { PUEBLO_PLAN_WORKFLOW_TYPE } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';
import { renderPuebloPlanMarkdown, type PuebloPlanDocument } from '../../src/workflow/pueblo-plan/pueblo-plan-markdown';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('workflow service', () => {
  it('exports the final plan when the active round completes the workflow', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-service-'));
    tempDirs.push(tempDir);
    const config = createTestAppConfig({
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new InMemoryWorkflowRepository();
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-1',
      type: 'pueblo-plan',
      goal: 'Ship the plan deliverable',
      status: 'round-active',
      sessionId: 'session-1',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-1', 'ship-the-plan-deliverable.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'ship-the-plan-deliverable.plan.md'),
      activeRoundNumber: 1,
    });
    planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(createCompletedRoundPlan(workflow)));

    const result = workflowService.completeActiveRound({
      sessionId: 'session-1',
      roundSummary: 'Finished all remaining work.',
    });

    expect(result).not.toBeNull();
    expect(result?.workflow.status).toBe('completed');
    expect(result?.exportResult?.status).toBe('exported');
    expect(fs.existsSync(workflow.deliverablePlanPath!)).toBe(true);
  });

  it('recovers workflow status and active round from the runtime plan document', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-service-'));
    tempDirs.push(tempDir);
    const config = createTestAppConfig({
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new InMemoryWorkflowRepository();
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-2',
      type: 'pueblo-plan',
      goal: 'Recover the runtime workflow state',
      status: 'planning',
      sessionId: 'session-2',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-2', 'recover-the-runtime-workflow-state.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'recover-the-runtime-workflow-state.plan.md'),
      activeRoundNumber: null,
    });
    planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(createRecoveredPlan(workflow)));

    const result = workflowService.recoverWorkflowFromRuntimePlan(workflow.id);

    expect(result).not.toBeNull();
    expect(result?.workflow.status).toBe('round-active');
    expect(result?.workflow.activeRoundNumber).toBe(2);
    expect(result?.plan.activeRoundNumber).toBe(2);
  });

  it('marks a workflow as failed and appends the reason to the runtime plan log', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-service-'));
    tempDirs.push(tempDir);
    const config = createTestAppConfig({
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new InMemoryWorkflowRepository();
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-3',
      type: 'pueblo-plan',
      goal: 'Handle task failure cleanly',
      status: 'round-active',
      sessionId: 'session-3',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-3', 'handle-task-failure-cleanly.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'handle-task-failure-cleanly.plan.md'),
      activeRoundNumber: 1,
    });
    planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(createRecoveredPlan(workflow)));

    const result = workflowService.markWorkflowFailed(workflow.id, 'Provider request timed out.');

    expect(result).not.toBeNull();
    expect(result?.workflow.status).toBe('failed');
    expect(result?.workflow.failedAt).toBeTruthy();
    expect(result?.plan?.status).toBe('failed');
    expect(result?.plan?.executionLog.at(-1)).toContain('Provider request timed out.');
  });

  it('marks a workflow as blocked while preserving the active round for resume', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-service-'));
    tempDirs.push(tempDir);
    const config = createTestAppConfig({
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new InMemoryWorkflowRepository();
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-4',
      type: 'pueblo-plan',
      goal: 'Pause for user clarification',
      status: 'round-active',
      sessionId: 'session-4',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-4', 'pause-for-user-clarification.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'pause-for-user-clarification.plan.md'),
      activeRoundNumber: 2,
    });
    planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(createRecoveredPlan({
      ...workflow,
      activeRoundNumber: 2,
    })));

    const result = workflowService.markWorkflowBlocked(workflow.id, 'Waiting for user input.');

    expect(result).not.toBeNull();
    expect(result?.workflow.status).toBe('blocked');
    expect(result?.workflow.activeRoundNumber).toBe(2);
    expect(result?.plan?.status).toBe('blocked');
    expect(result?.plan?.activeRoundNumber).toBe(2);
  });

  it('marks a workflow as failed even when the runtime plan file is missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-service-'));
    tempDirs.push(tempDir);
    const config = createTestAppConfig({
      workflow: {
        runtimeDirectory: path.join(tempDir, '.plans'),
      },
    });
    const repository = new InMemoryWorkflowRepository();
    const planStore = new WorkflowPlanStore(config);
    const workflowService = new WorkflowService({
      repository,
      registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
      planStore,
      exporter: new WorkflowExporter(),
    });
    const workflow = repository.create({
      id: 'workflow-5',
      type: 'pueblo-plan',
      goal: 'Handle missing runtime plan',
      status: 'round-active',
      sessionId: 'session-5',
      runtimePlanPath: path.join(tempDir, '.plans', 'workflow-5', 'handle-missing-runtime-plan.plan.md'),
      deliverablePlanPath: path.join(tempDir, 'app', 'handle-missing-runtime-plan.plan.md'),
      activeRoundNumber: 1,
    });

    const result = workflowService.markWorkflowFailed(workflow.id, 'Runtime plan was deleted.');

    expect(result).not.toBeNull();
    expect(result?.workflow.status).toBe('failed');
    expect(result?.workflow.failedAt).toBeTruthy();
    expect(result?.plan).toBeNull();
    expect(planStore.readPlan(workflow.runtimePlanPath)).toBeNull();
  });
});

function createCompletedRoundPlan(workflow: ReturnType<typeof createWorkflowInstanceModel>): PuebloPlanDocument {
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
      { id: 'task-1', title: 'Finalize implementation', parentId: 'task-root', status: 'in-progress' },
      { id: 'task-2', title: 'Validate the final result', parentId: 'task-root', status: 'in-progress' },
    ],
    activeRoundNumber: 1,
    rounds: [
      { roundNumber: 1, taskIds: ['task-1', 'task-2'], status: 'active', summary: null },
    ],
    executionLog: [],
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function createRecoveredPlan(workflow: ReturnType<typeof createWorkflowInstanceModel>): PuebloPlanDocument {
  return {
    workflowId: workflow.id,
    workflowType: workflow.type,
    status: 'round-active',
    routeReason: 'explicit',
    sessionId: workflow.sessionId ?? 'session-2',
    goal: workflow.goal,
    runtimePlanPath: workflow.runtimePlanPath,
    deliverablePlanPath: workflow.deliverablePlanPath,
    constraints: [],
    acceptanceCriteria: [],
    tasks: [
      { id: 'task-root', title: 'Root', parentId: null, status: 'in-progress' },
      { id: 'task-1', title: 'Carry forward the next round', parentId: 'task-root', status: 'completed' },
      { id: 'task-2', title: 'Continue the remaining work', parentId: 'task-root', status: 'in-progress' },
    ],
    activeRoundNumber: 2,
    rounds: [
      { roundNumber: 1, taskIds: ['task-1'], status: 'completed', summary: 'Round one done.' },
      { roundNumber: 2, taskIds: ['task-2'], status: 'active', summary: null },
    ],
    executionLog: [],
    createdAt: workflow.createdAt,
    updatedAt: new Date().toISOString(),
  };
}