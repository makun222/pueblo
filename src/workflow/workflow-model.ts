import { randomUUID } from 'node:crypto';
import { workflowContextSchema, workflowInstanceSchema, type WorkflowContext, type WorkflowInstance } from '../shared/schema';

export interface CreateWorkflowInstanceInput {
  readonly id?: string;
  readonly type: WorkflowInstance['type'];
  readonly goal: string;
  readonly status?: WorkflowInstance['status'];
  readonly sessionId?: string | null;
  readonly agentInstanceId?: string | null;
  readonly targetDirectory?: string | null;
  readonly runtimePlanPath: string;
  readonly deliverablePlanPath?: string | null;
  readonly activePlanMemoryId?: string | null;
  readonly activeTodoMemoryId?: string | null;
  readonly activeRoundNumber?: number | null;
}

export function createWorkflowInstanceModel(input: CreateWorkflowInstanceInput): WorkflowInstance {
  const now = new Date().toISOString();

  return workflowInstanceSchema.parse({
    id: input.id ?? randomUUID(),
    type: input.type,
    status: input.status ?? 'planning',
    sessionId: input.sessionId ?? null,
    agentInstanceId: input.agentInstanceId ?? null,
    goal: input.goal,
    targetDirectory: input.targetDirectory ?? null,
    runtimePlanPath: input.runtimePlanPath,
    deliverablePlanPath: input.deliverablePlanPath ?? null,
    activePlanMemoryId: input.activePlanMemoryId ?? null,
    activeTodoMemoryId: input.activeTodoMemoryId ?? null,
    activeRoundNumber: input.activeRoundNumber ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
  });
}

export function toWorkflowContext(input: {
  readonly workflow: WorkflowInstance;
  readonly planSummary?: string | null;
  readonly todoSummary?: string | null;
}): WorkflowContext {
  return workflowContextSchema.parse({
    workflowId: input.workflow.id,
    workflowType: input.workflow.type,
    status: input.workflow.status,
    planSummary: input.planSummary ?? null,
    todoSummary: input.todoSummary ?? null,
    planMemoryId: input.workflow.activePlanMemoryId,
    todoMemoryId: input.workflow.activeTodoMemoryId,
    runtimePlanPath: input.workflow.runtimePlanPath,
    deliverablePlanPath: input.workflow.deliverablePlanPath,
    activeRoundNumber: input.workflow.activeRoundNumber,
    updatedAt: input.workflow.updatedAt,
  });
}
