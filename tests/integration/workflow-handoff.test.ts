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

describeIfNodeSqlite('workflow handoff integration', () => {
  it('starts a workflow from the explicit /workflow command and writes a runtime plan', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-explicit-'));
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
      const result = await cli.dispatcher.dispatch({ input: '/workflow build a staged migration plan' });

      expect(result.ok).toBe(true);
      expect(result.code).toBe('WORKFLOW_STARTED');

      const data = result.data as {
        runtimePlanPath: string;
        workflowType: string;
        planMemoryId: string;
        sessionId: string;
      };

      expect(data.workflowType).toBe('pueblo-plan');
      expect(fs.existsSync(data.runtimePlanPath)).toBe(true);
      expect(fs.readFileSync(data.runtimePlanPath, 'utf8')).toContain('# Plan: build a staged migration plan');

      const memories = cli.listSessionMemories(data.sessionId);
      expect(memories.some((memory) => memory.id === data.planMemoryId && memory.tags.includes('plan'))).toBe(true);
    } finally {
      cli.databaseClose();
    }
  });

  it('routes workflow-keyword plain text into workflow startup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-keyword-'));
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
      const result = await cli.submitInput('Please create a workflow for this repository refactor.');

      expect(result.ok).toBe(true);
      expect(result.code).toBe('TASK_COMPLETED');
      expect((result.data as { workflow?: { routeReason?: string } }).workflow?.routeReason).toBe('keyword');
      expect((result.data as { workflow?: { runtimePlanPath?: string } }).workflow?.runtimePlanPath).toContain(`${path.sep}.plans${path.sep}`);
    } finally {
      cli.databaseClose();
    }
  });

  it('routes follow-up plain text into the active workflow instead of starting a parallel task', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-follow-up-'));
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
      const start = await cli.dispatcher.dispatch({ input: '/workflow build a staged migration plan' });
      expect(start.ok).toBe(true);
      const workflowId = (start.data as { workflowId: string }).workflowId;

      const result = await cli.submitInput('Look at the current plan and continue what still needs to be done.');

      expect(result.ok).toBe(true);
      expect(result.code).toBe('TASK_COMPLETED');
      expect((result.data as { workflow?: { workflowId?: string } }).workflow?.workflowId).toBe(workflowId);
    } finally {
      cli.databaseClose();
    }
  });

  it('exposes status and cancel controls for the active workflow', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-controls-'));
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
      const start = await cli.dispatcher.dispatch({ input: '/workflow build a staged migration plan' });
      expect(start.ok).toBe(true);

      const status = await cli.submitInput('/workflow-status');
      expect(status.ok).toBe(true);
      expect(status.code).toBe('WORKFLOW_STATUS');
      expect((status.data as { status: string }).status).toBe('round-active');

      const cancelled = await cli.submitInput('/workflow-cancel no longer needed');
      expect(cancelled.ok).toBe(true);
      expect(cancelled.code).toBe('WORKFLOW_CANCELLED');
      expect((cancelled.data as { status: string }).status).toBe('cancelled');

      const missing = await cli.submitInput('/workflow-status');
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe('NO_ACTIVE_WORKFLOW');
    } finally {
      cli.databaseClose();
    }
  });

  it('clears stale workflow memories when no active workflow remains', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-stale-memory-'));
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
      const start = await cli.dispatcher.dispatch({ input: '/workflow build a staged migration plan' });
      expect(start.ok).toBe(true);

      const startData = start.data as {
        sessionId: string;
        planMemoryId: string;
        todoMemoryId: string | null;
      };

      expect(startData.todoMemoryId).not.toBeNull();

      const cancelled = await cli.submitInput('/workflow-cancel no longer needed');
      expect(cancelled.ok).toBe(true);

      await cli.submitInput(`/memory-sel ${startData.planMemoryId}`);
      await cli.submitInput(`/memory-sel ${startData.todoMemoryId}`);

      const stale = await cli.submitInput('/workflow-status');
      expect(stale.ok).toBe(false);
      expect(stale.code).toBe('WORKFLOW_CONTEXT_STALE');

      const selected = cli.selectSession(startData.sessionId);
      expect(selected.session?.selectedMemoryIds).not.toContain(startData.planMemoryId);
      expect(selected.session?.selectedMemoryIds).not.toContain(startData.todoMemoryId);
    } finally {
      cli.databaseClose();
    }
  });
});
