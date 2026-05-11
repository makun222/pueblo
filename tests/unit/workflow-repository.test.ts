import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/persistence/migrate';
import { createSqliteDatabase } from '../../src/persistence/sqlite';
import { WorkflowRepository } from '../../src/workflow/workflow-repository';
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

describeIfNodeSqlite('workflow repository', () => {
	it('persists workflow state updates including plan and todo memory pointers', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-repository-'));
		tempDirs.push(tempDir);
		const database = createSqliteDatabase({ dbPath: path.join(tempDir, 'pueblo.db') });
		runMigrations(database.connection);
		const repository = new WorkflowRepository({ connection: database.connection });

		try {
			const created = repository.create({
				id: 'workflow-1',
				type: 'pueblo-plan',
				status: 'planning',
				sessionId: 'session-1',
				goal: 'Persist workflow metadata',
				runtimePlanPath: path.join(tempDir, '.plans', 'workflow-1', 'persist-workflow-metadata.plan.md'),
				deliverablePlanPath: path.join(tempDir, 'app', 'persist-workflow-metadata.plan.md'),
			});

			const failedAt = new Date().toISOString();
			repository.save({
				...created,
				status: 'failed',
				activePlanMemoryId: 'memory-plan-1',
				activeTodoMemoryId: 'memory-todo-1',
				activeRoundNumber: 3,
				failedAt,
				updatedAt: failedAt,
			});

			const restored = repository.getById(created.id);

			expect(restored).not.toBeNull();
			expect(restored?.status).toBe('failed');
			expect(restored?.activePlanMemoryId).toBe('memory-plan-1');
			expect(restored?.activeTodoMemoryId).toBe('memory-todo-1');
			expect(restored?.activeRoundNumber).toBe(3);
			expect(restored?.failedAt).toBe(failedAt);
		} finally {
			database.close();
		}
	});

	it('returns the most recent active workflow while ignoring terminal states', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-workflow-repository-'));
		tempDirs.push(tempDir);
		const database = createSqliteDatabase({ dbPath: path.join(tempDir, 'pueblo.db') });
		runMigrations(database.connection);
		const repository = new WorkflowRepository({ connection: database.connection });

		try {
			repository.create({
				id: 'workflow-completed',
				type: 'pueblo-plan',
				status: 'completed',
				sessionId: 'session-2',
				goal: 'Completed workflow',
				runtimePlanPath: path.join(tempDir, '.plans', 'workflow-completed', 'completed-workflow.plan.md'),
			});

			repository.save({
				...repository.create({
					id: 'workflow-blocked',
					type: 'pueblo-plan',
					status: 'blocked',
					sessionId: 'session-2',
					goal: 'Blocked workflow',
					runtimePlanPath: path.join(tempDir, '.plans', 'workflow-blocked', 'blocked-workflow.plan.md'),
					activeRoundNumber: 2,
				}),
				updatedAt: '2026-05-10T12:00:00.000Z',
			});

			repository.save({
				...repository.create({
					id: 'workflow-failed',
					type: 'pueblo-plan',
					status: 'failed',
					sessionId: 'session-2',
					goal: 'Failed workflow',
					runtimePlanPath: path.join(tempDir, '.plans', 'workflow-failed', 'failed-workflow.plan.md'),
				}),
				updatedAt: '2026-05-10T12:05:00.000Z',
				failedAt: '2026-05-10T12:05:00.000Z',
			});

			const active = repository.getActiveBySession('session-2');

			expect(active).not.toBeNull();
			expect(active?.id).toBe('workflow-blocked');
			expect(active?.status).toBe('blocked');
		} finally {
			database.close();
		}
	});
});