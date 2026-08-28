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
import { WorkflowSupervisor } from '../../src/workflow/workflow-supervisor';
import { PUEBLO_PLAN_WORKFLOW_TYPE } from '../../src/workflow/pueblo-plan/pueblo-plan-workflow';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function createService(configOverrides: Record<string, unknown> = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-supervisor-'));
  tempDirs.push(tempDir);
  const config = createTestAppConfig({
    workflow: {
      runtimeDirectory: path.join(tempDir, '.plans'),
      ...configOverrides,
    },
  });
  const repository = new InMemoryWorkflowRepository();
  const planStore = new WorkflowPlanStore(config);
  const workflowService = new WorkflowService({
    repository,
    registry: new WorkflowRegistry([{ type: PUEBLO_PLAN_WORKFLOW_TYPE, description: 'Structured workflow' }]),
    planStore,
    exporter: new WorkflowExporter(),
    getConfig: () => config,
  });

  return { workflowService, repository, planStore, tempDir, config };
}

describe('workflow supervisor', () => {
  it('start/stop toggles the running state', () => {
    const { workflowService, config } = createService();
    const supervisor = new WorkflowSupervisor({ config, workflowService, sweepIntervalMs: 10 });
    expect(supervisor.isRunning()).toBe(false);
    supervisor.start();
    expect(supervisor.isRunning()).toBe(true);
    supervisor.stop();
    expect(supervisor.isRunning()).toBe(false);
  });

  it('observeTaskOutcome marks a blocked workflow failed after blocked timeout via sweep', () => {
    const { workflowService, repository, config } = createService({
      blockedTimeoutMs: 60_000,
      roundTimeoutMs: 60 * 60 * 1000,
      pauseTimeoutMs: 60 * 60 * 1000,
    });
    const supervisor = new WorkflowSupervisor({ config, workflowService });

    const workflow = repository.create({
      id: 'workflow-blocked',
      type: 'pueblo-plan',
      goal: 'Stuck workflow',
      status: 'round-active',
      sessionId: 'session-1',
      runtimePlanPath: path.join('unused', 'plan.plan.md'),
      activeRoundNumber: 1,
    });
    repository.save({
      ...workflow,
      status: 'blocked',
      blockedAt: '2020-01-01T00:00:00.000Z',
      roundStartedAt: null,
    });

    supervisor.observeTaskOutcome('session-1', { kind: 'success', hasAssistantOutput: true });
    supervisor.sweep();

    const reloaded = repository.getById(workflow.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.failedAt).toBeTruthy();
  });

  it('sweep is a no-op when there are no active workflows', async () => {
    const { workflowService, config } = createService();
    const supervisor = new WorkflowSupervisor({ config, workflowService });
    await supervisor.sweep();
    expect(supervisor.isRunning()).toBe(false);
  });
});
