import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowPlanStore, slugifyGoal } from '../../src/workflow/workflow-plan-store';
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

describe('workflow plan store', () => {
	it('resolves runtime paths and omits deliverable paths when no target directory is provided', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: {
				runtimeDirectory: path.join(tempDir, '.plans'),
			},
		});
		const planStore = new WorkflowPlanStore(config);

		const paths = planStore.resolvePaths({
			workflowId: 'workflow-1',
			goal: '  Build a staged migration plan!  ',
			targetDirectory: null,
		});

		expect(paths.runtimePlanPath).toBe(path.resolve(tempDir, '.plans', 'workflow-1', 'build-a-staged-migration-plan.plan.md'));
		expect(paths.deliverablePlanPath).toBeNull();
	});

	it('writes normalized markdown and reports missing plans as absent', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: {
				runtimeDirectory: path.join(tempDir, '.plans'),
			},
		});
		const planStore = new WorkflowPlanStore(config);
		const filePath = path.join(tempDir, '.plans', 'workflow-2', 'runtime.plan.md');

		expect(planStore.hasPlan(filePath)).toBe(false);
		expect(planStore.readPlan(filePath)).toBeNull();

		planStore.writePlan(filePath, '# Plan');

		expect(planStore.hasPlan(filePath)).toBe(true);
		expect(planStore.readPlan(filePath)).toBe('# Plan\n');
	});

	it('falls back to a stable slug when the goal does not contain ASCII letters or digits', () => {
		expect(slugifyGoal('!!!')).toBe('workflow');
		expect(slugifyGoal('意 识 的 回 声')).toBe('workflow');
	});

	it('disposeWorkflow archives a failed workflow when archiveOnFailure is enabled', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: {
				runtimeDirectory: path.join(tempDir, '.plans'),
				archiveOnFailure: true,
			},
		});
		const planStore = new WorkflowPlanStore(config);
		const workflowDir = planStore.resolveWorkflowDirectoryPath('11111111-1111-1111-1111-111111111111');
		planStore.writePlan(path.join(workflowDir, 'goal.plan.md'), '# Plan');

		planStore.disposeWorkflow('11111111-1111-1111-1111-111111111111', 'failed');

		expect(fs.existsSync(workflowDir)).toBe(false);
		expect(fs.existsSync(path.join(tempDir, '.plans', '_archive', '11111111-1111-1111-1111-111111111111'))).toBe(true);
	});

	it('disposeWorkflow deletes a cancelled workflow when archiveOnFailure is disabled', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: {
				runtimeDirectory: path.join(tempDir, '.plans'),
				archiveOnFailure: false,
			},
		});
		const planStore = new WorkflowPlanStore(config);
		const workflowDir = planStore.resolveWorkflowDirectoryPath('22222222-2222-2222-2222-222222222222');
		planStore.writePlan(path.join(workflowDir, 'goal.plan.md'), '# Plan');

		planStore.disposeWorkflow('22222222-2222-2222-2222-222222222222', 'cancelled');

		expect(fs.existsSync(workflowDir)).toBe(false);
	});

	it('disposeWorkflow keeps the directory for completed workflows', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: { runtimeDirectory: path.join(tempDir, '.plans') },
		});
		const planStore = new WorkflowPlanStore(config);
		const workflowDir = planStore.resolveWorkflowDirectoryPath('33333333-3333-3333-3333-333333333333');
		planStore.writePlan(path.join(workflowDir, 'goal.plan.md'), '# Plan');

		planStore.disposeWorkflow('33333333-3333-3333-3333-333333333333', 'completed');

		expect(fs.existsSync(workflowDir)).toBe(true);
	});

	it('listWorkflowDirectories returns only uuid-shaped directories', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-plan-store-'));
		tempDirs.push(tempDir);
		const config = createTestAppConfig({
			workflow: { runtimeDirectory: path.join(tempDir, '.plans') },
		});
		const planStore = new WorkflowPlanStore(config);
		planStore.writePlan(path.join(tempDir, '.plans', '44444444-4444-4444-4444-444444444444', 'goal.plan.md'), '# Plan');
		fs.mkdirSync(path.join(tempDir, '.plans', '_archive'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.plans', 'not-a-uuid'), { recursive: true });

		const listings = planStore.listWorkflowDirectories();

		expect(listings.map((entry) => entry.workflowId)).toEqual(['44444444-4444-4444-4444-444444444444']);
	});
});