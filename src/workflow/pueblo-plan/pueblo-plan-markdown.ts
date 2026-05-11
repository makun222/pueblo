import type { WorkflowInstance } from '../../shared/schema';
import type { PuebloPlanOutline } from './pueblo-plan-planner';

export type PuebloPlanTaskStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';
export type PuebloPlanRoundStatus = 'active' | 'completed';

export interface PuebloPlanTask {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly status: PuebloPlanTaskStatus;
}

export interface PuebloPlanRound {
  readonly roundNumber: number;
  readonly taskIds: string[];
  readonly status: PuebloPlanRoundStatus;
  readonly summary: string | null;
}

export interface PuebloPlanDocument {
  readonly workflowId: string;
  readonly workflowType: WorkflowInstance['type'];
  readonly status: WorkflowInstance['status'];
  readonly routeReason: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly runtimePlanPath: string;
  readonly deliverablePlanPath: string | null;
  readonly constraints: string[];
  readonly acceptanceCriteria: string[];
  readonly tasks: PuebloPlanTask[];
  readonly activeRoundNumber: number | null;
  readonly rounds: PuebloPlanRound[];
  readonly executionLog: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STATE_BLOCK_OPEN = '```pueblo-plan-state';
const STATE_BLOCK_CLOSE = '```';

export function createInitialPuebloPlanDocument(args: {
  readonly workflow: WorkflowInstance;
  readonly routeReason: string;
  readonly sessionId: string;
  readonly outline: PuebloPlanOutline;
}): PuebloPlanDocument {
  return {
    workflowId: args.workflow.id,
    workflowType: args.workflow.type,
    status: args.workflow.status,
    routeReason: args.routeReason,
    sessionId: args.sessionId,
    goal: args.workflow.goal,
    runtimePlanPath: args.workflow.runtimePlanPath,
    deliverablePlanPath: args.workflow.deliverablePlanPath,
    constraints: args.outline.constraints,
    acceptanceCriteria: args.outline.acceptanceCriteria,
    tasks: args.outline.tasks.map((task) => ({
      ...task,
      status: 'pending',
    })),
    activeRoundNumber: null,
    rounds: [],
    executionLog: [`${args.workflow.createdAt}: Workflow created and runtime plan initialized.`],
    createdAt: args.workflow.createdAt,
    updatedAt: args.workflow.updatedAt,
  };
}

export function renderPuebloPlanMarkdown(plan: PuebloPlanDocument): string {
  const currentRound = plan.rounds.find((round) => round.roundNumber === plan.activeRoundNumber) ?? null;
  const taskLines = plan.tasks.map((task) => {
    const depth = computeTaskDepth(plan.tasks, task);
    const indent = '  '.repeat(depth);
    return `${indent}- [${statusToCheckbox(task.status)}] ${task.title} (${task.id})`;
  });

  return [
    `# Plan: ${plan.goal}`,
    '',
    '## Workflow Metadata',
    `- Workflow ID: ${plan.workflowId}`,
    `- Workflow Type: ${plan.workflowType}`,
    `- Status: ${plan.status}`,
    `- Session ID: ${plan.sessionId}`,
    `- Route Reason: ${plan.routeReason}`,
    `- Runtime Plan Path: ${plan.runtimePlanPath}`,
    `- Deliverable Plan Path: ${plan.deliverablePlanPath ?? 'pending'}`,
    '',
    '## Goal',
    plan.goal,
    '',
    '## Constraints',
    ...plan.constraints.map((constraint) => `- ${constraint}`),
    '',
    '## Acceptance Criteria',
    ...plan.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '## Task Tree',
    ...taskLines,
    '',
    '## Current Round',
    `- Active Round: ${plan.activeRoundNumber ?? 'none'}`,
    `- Active Tasks: ${currentRound?.taskIds.join(', ') ?? 'pending'}`,
    '',
    '## Execution Log',
    ...plan.executionLog.map((entry) => `- ${entry}`),
    '',
    STATE_BLOCK_OPEN,
    JSON.stringify(plan, null, 2),
    STATE_BLOCK_CLOSE,
  ].join('\n');
}

export function parsePuebloPlanMarkdown(markdown: string): PuebloPlanDocument {
  const startIndex = markdown.indexOf(STATE_BLOCK_OPEN);
  if (startIndex === -1) {
    throw new Error('Missing pueblo-plan-state block');
  }

  const afterOpen = markdown.indexOf('\n', startIndex);
  const endIndex = markdown.indexOf(`\n${STATE_BLOCK_CLOSE}`, afterOpen);
  if (afterOpen === -1 || endIndex === -1) {
    throw new Error('Invalid pueblo-plan-state block');
  }

  const jsonText = markdown.slice(afterOpen + 1, endIndex).trim();
  return JSON.parse(jsonText) as PuebloPlanDocument;
}

function statusToCheckbox(status: PuebloPlanTaskStatus): string {
  switch (status) {
    case 'completed':
      return 'x';
    case 'in-progress':
      return '~';
    case 'blocked':
      return '!';
    default:
      return ' ';
  }
}

function computeTaskDepth(tasks: PuebloPlanTask[], task: PuebloPlanTask): number {
  let depth = 0;
  let currentParentId = task.parentId;

  while (currentParentId) {
    const parent = tasks.find((candidate) => candidate.id === currentParentId);
    if (!parent) {
      break;
    }

    depth += 1;
    currentParentId = parent.parentId;
  }

  return depth;
}


