import type { PuebloPlanDocument, PuebloPlanRound, PuebloPlanTask, PuebloPlanTaskStatus } from './pueblo-plan-markdown';
import { applyTodoRound, selectNextTodoRound } from './pueblo-plan-rounds';

export const PUEBLO_PLAN_WORKFLOW_TYPE = 'pueblo-plan';

export interface PuebloPlanAdvanceResult {
	readonly plan: PuebloPlanDocument;
	readonly completedRound: PuebloPlanRound | null;
	readonly nextRound: PuebloPlanRound | null;
}

export function applyPuebloPlanLifecycleStatus(
	plan: PuebloPlanDocument,
	status: PuebloPlanDocument['status'],
	reason?: string | null,
): PuebloPlanDocument {
	const updatedAt = new Date().toISOString();
	const note = reason?.trim();

	return {
		...plan,
		status,
		activeRoundNumber: status === 'blocked' ? plan.activeRoundNumber : null,
		updatedAt,
		executionLog: [
			...plan.executionLog,
			note
				? `${updatedAt}: Workflow marked ${status}. Reason: ${note}`
				: `${updatedAt}: Workflow marked ${status}.`,
		],
	};
}

export function advancePuebloPlanAfterRound(plan: PuebloPlanDocument, roundSummary?: string | null): PuebloPlanAdvanceResult {
	const activeRound = plan.rounds.find((round) => round.roundNumber === plan.activeRoundNumber) ?? null;
	if (!activeRound) {
		return {
			plan,
			completedRound: null,
			nextRound: null,
		};
	}

	const activeTaskIds = new Set(activeRound.taskIds);
	const updatedAt = new Date().toISOString();
	const completedRound: PuebloPlanRound = {
		...activeRound,
		status: 'completed',
		summary: roundSummary?.trim() || null,
	};
	const completedTasks = syncParentTaskStatuses(
		plan.tasks.map((task) => {
			if (!activeTaskIds.has(task.id) || task.status === 'blocked') {
				return task;
			}

			return {
				...task,
				status: 'completed' as const,
			};
		}),
	);
	const completedPlan: PuebloPlanDocument = {
		...plan,
		status: 'round-review',
		activeRoundNumber: null,
		tasks: completedTasks,
		rounds: plan.rounds.map((round) => round.roundNumber === completedRound.roundNumber ? completedRound : round),
		updatedAt,
		executionLog: [
			...plan.executionLog,
			`${updatedAt}: Completed round ${completedRound.roundNumber}.`,
		],
	};
	const nextRound = selectNextTodoRound(completedPlan);
	if (nextRound) {
		return {
			plan: {
				...applyTodoRound({
					...completedPlan,
					status: 'round-active',
				}, nextRound),
				status: 'round-active',
			},
			completedRound,
			nextRound,
		};
	}

	return {
		plan: {
			...completedPlan,
			status: resolveWorkflowCompletionStatus(completedTasks),
			updatedAt,
		},
		completedRound,
		nextRound: null,
	};
}

function syncParentTaskStatuses(tasks: PuebloPlanTask[]): PuebloPlanTask[] {
	let nextTasks = tasks;
	let changed = true;

	while (changed) {
		changed = false;
		nextTasks = nextTasks.map((task) => {
			const children = nextTasks.filter((candidate) => candidate.parentId === task.id);
			if (children.length === 0) {
				return task;
			}

			const status = deriveParentTaskStatus(children);
			if (status === task.status) {
				return task;
			}

			changed = true;
			return {
				...task,
				status,
			};
		});
	}

	return nextTasks;
}

function deriveParentTaskStatus(children: PuebloPlanTask[]): PuebloPlanTaskStatus {
	if (children.every((child) => child.status === 'completed')) {
		return 'completed';
	}

	if (children.some((child) => child.status === 'blocked')) {
		return 'blocked';
	}

	if (children.some((child) => child.status === 'in-progress' || child.status === 'completed')) {
		return 'in-progress';
	}

	return 'pending';
}

function resolveWorkflowCompletionStatus(tasks: PuebloPlanTask[]): PuebloPlanDocument['status'] {
	if (tasks.some((task) => task.status === 'blocked')) {
		return 'blocked';
	}

	if (tasks.every((task) => task.status === 'completed')) {
		return 'completed';
	}

	return 'planning';
}
