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
});