import { randomUUID } from 'node:crypto';
import { workflowContextSchema, workflowInstanceSchema, type WorkflowContext, type WorkflowInstance, type WorkflowType } from '../shared/schema';
import type { WorkflowExporter, WorkflowExportResult } from './workflow-exporter';
import type { WorkflowPlanStore } from './workflow-plan-store';
import type { WorkflowDefinition, WorkflowRegistry } from './workflow-registry';
import type { WorkflowStore } from './workflow-repository';
import { parsePuebloPlanMarkdown, renderPuebloPlanMarkdown, type PuebloPlanDocument, type PuebloPlanRound } from './pueblo-plan/pueblo-plan-markdown';
import { advancePuebloPlanAfterRound, applyPuebloPlanLifecycleStatus } from './pueblo-plan/pueblo-plan-workflow';
import { buildWorkflowContextSummaries } from './workflow-context';

export interface StartWorkflowInput {
  readonly type: WorkflowType;
  readonly goal: string;
  readonly sessionId?: string | null;
  readonly agentInstanceId?: string | null;
  readonly targetDirectory?: string | null;
  readonly initialStatus?: WorkflowInstance['status'];
}

export interface WorkflowServiceDependencies {
  readonly repository: WorkflowStore;
  readonly registry: Pick<WorkflowRegistry, 'getDefinition' | 'listDefinitions'>;
  readonly planStore: WorkflowPlanStore;
  readonly exporter: WorkflowExporter;
}

export interface CompleteWorkflowRoundResult {
  readonly workflow: WorkflowInstance;
  readonly plan: PuebloPlanDocument;
  readonly completedRound: PuebloPlanRound;
  readonly nextRound: PuebloPlanRound | null;
  readonly previousPlanMemoryId: string | null;
  readonly previousTodoMemoryId: string | null;
  readonly exportResult: WorkflowExportResult | null;
}

export interface RecoverWorkflowResult {
  readonly workflow: WorkflowInstance;
  readonly plan: PuebloPlanDocument;
  readonly exportResult: WorkflowExportResult | null;
}

export interface WorkflowLifecycleTransitionResult {
  readonly workflow: WorkflowInstance;
  readonly plan: PuebloPlanDocument | null;
}

export class WorkflowService {
  constructor(private readonly dependencies: WorkflowServiceDependencies) {}

  startWorkflow(input: StartWorkflowInput): WorkflowInstance {
    const definition = this.requireDefinition(input.type);
    const workflowId = randomUUID();
    const paths = this.dependencies.planStore.resolvePaths({
      workflowId,
      goal: input.goal,
      targetDirectory: input.targetDirectory ?? null,
    });
    const workflow = this.dependencies.repository.create({
      id: workflowId,
      type: definition.type,
      goal: input.goal,
      status: input.initialStatus ?? 'planning',
      sessionId: input.sessionId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      targetDirectory: input.targetDirectory ?? null,
      runtimePlanPath: paths.runtimePlanPath,
      deliverablePlanPath: paths.deliverablePlanPath,
    });

    return workflowInstanceSchema.parse(workflow);
  }

  listDefinitions(): WorkflowDefinition[] {
    return this.dependencies.registry.listDefinitions();
  }

  listSessionWorkflows(sessionId: string): WorkflowInstance[] {
    return this.dependencies.repository.listBySession(sessionId);
  }

  getWorkflow(workflowId: string): WorkflowInstance | null {
    return this.dependencies.repository.getById(workflowId);
  }

  getActiveWorkflowForSession(sessionId: string): WorkflowInstance | null {
    return this.dependencies.repository.getActiveBySession(sessionId);
  }

  getWorkflowContext(sessionId: string): WorkflowContext | null {
    const workflow = this.getActiveWorkflowForSession(sessionId);
    if (!workflow) {
      return null;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    const planDocument = planMarkdown ? parsePuebloPlanMarkdown(planMarkdown) : null;
    const summaries = planDocument
      ? buildWorkflowContextSummaries(planDocument)
      : { planSummary: null, todoSummary: null };

    return workflowContextSchema.parse({
      workflowId: workflow.id,
      workflowType: workflow.type,
      status: workflow.status,
      planSummary: summaries.planSummary,
      todoSummary: summaries.todoSummary,
      planMemoryId: workflow.activePlanMemoryId,
      todoMemoryId: workflow.activeTodoMemoryId,
      runtimePlanPath: workflow.runtimePlanPath,
      deliverablePlanPath: workflow.deliverablePlanPath,
      activeRoundNumber: workflow.activeRoundNumber,
      updatedAt: workflow.updatedAt,
    });
  }

  saveWorkflow(workflow: WorkflowInstance): WorkflowInstance {
    return this.dependencies.repository.save(workflowInstanceSchema.parse(workflow));
  }

  completeActiveRound(args: {
    readonly sessionId: string;
    readonly roundSummary?: string | null;
  }): CompleteWorkflowRoundResult | null {
    const workflow = this.getActiveWorkflowForSession(args.sessionId);
    if (!workflow || workflow.type !== 'pueblo-plan') {
      return null;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    if (!planMarkdown) {
      return null;
    }

    const planDocument = parsePuebloPlanMarkdown(planMarkdown);
    const transition = advancePuebloPlanAfterRound(planDocument, args.roundSummary ?? null);
    if (!transition.completedRound) {
      return null;
    }

    this.dependencies.planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(transition.plan));

    const updatedWorkflow = this.saveWorkflow({
      ...workflow,
      status: transition.plan.status,
      activeRoundNumber: transition.plan.activeRoundNumber,
      activeTodoMemoryId: null,
      updatedAt: transition.plan.updatedAt,
      completedAt: transition.plan.status === 'completed' ? transition.plan.updatedAt : workflow.completedAt,
    });
    const exportResult = transition.plan.status === 'completed'
      ? this.exportWorkflowPlan(updatedWorkflow.id)
      : null;

    return {
      workflow: updatedWorkflow,
      plan: transition.plan,
      completedRound: transition.completedRound,
      nextRound: transition.nextRound,
      previousPlanMemoryId: workflow.activePlanMemoryId,
      previousTodoMemoryId: workflow.activeTodoMemoryId,
      exportResult,
    };
  }

  recoverWorkflowFromRuntimePlan(workflowId: string): RecoverWorkflowResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow) {
      return null;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    if (!planMarkdown) {
      return null;
    }

    const plan = parsePuebloPlanMarkdown(planMarkdown);
    const recoveredWorkflow = this.saveWorkflow({
      ...workflow,
      status: plan.status,
      activeRoundNumber: plan.activeRoundNumber,
      updatedAt: plan.updatedAt,
      completedAt: plan.status === 'completed' ? workflow.completedAt ?? plan.updatedAt : workflow.completedAt,
    });
    const exportResult = plan.status === 'completed'
      ? this.exportWorkflowPlan(recoveredWorkflow.id)
      : null;

    return {
      workflow: recoveredWorkflow,
      plan,
      exportResult,
    };
  }

  markWorkflowBlocked(workflowId: string, reason?: string | null): WorkflowLifecycleTransitionResult | null {
    return this.transitionWorkflowStatus(workflowId, 'blocked', reason ?? null);
  }

  markWorkflowFailed(workflowId: string, reason?: string | null): WorkflowLifecycleTransitionResult | null {
    return this.transitionWorkflowStatus(workflowId, 'failed', reason ?? null);
  }

  cancelWorkflow(workflowId: string, reason?: string | null): WorkflowLifecycleTransitionResult | null {
    return this.transitionWorkflowStatus(workflowId, 'cancelled', reason ?? null);
  }

  exportWorkflowPlan(workflowId: string): WorkflowExportResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow?.deliverablePlanPath) {
      return null;
    }

    return this.dependencies.exporter.exportPlan({
      runtimePlanPath: workflow.runtimePlanPath,
      deliverablePlanPath: workflow.deliverablePlanPath,
    });
  }

  private requireDefinition(type: WorkflowType): WorkflowDefinition {
    const definition = this.dependencies.registry.getDefinition(type);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${type}`);
    }

    return definition;
  }

  private transitionWorkflowStatus(
    workflowId: string,
    status: WorkflowInstance['status'],
    reason: string | null,
  ): WorkflowLifecycleTransitionResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow) {
      return null;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    const plan = planMarkdown ? parsePuebloPlanMarkdown(planMarkdown) : null;
    const nextPlan = plan && workflow.type === 'pueblo-plan'
      ? applyPuebloPlanLifecycleStatus(plan, status, reason)
      : null;

    if (nextPlan) {
      this.dependencies.planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(nextPlan));
    }

    const now = nextPlan?.updatedAt ?? new Date().toISOString();
    const updatedWorkflow = this.saveWorkflow({
      ...workflow,
      status,
      activeRoundNumber: status === 'blocked' ? workflow.activeRoundNumber : null,
      updatedAt: now,
      completedAt: status === 'completed' ? (workflow.completedAt ?? now) : workflow.completedAt,
      failedAt: status === 'failed' ? (workflow.failedAt ?? now) : workflow.failedAt,
      cancelledAt: status === 'cancelled' ? (workflow.cancelledAt ?? now) : workflow.cancelledAt,
    });

    return {
      workflow: updatedWorkflow,
      plan: nextPlan,
    };
  }
}
