import { randomUUID } from 'node:crypto';
import { workflowContextSchema, workflowInstanceSchema, type WorkflowContext, type WorkflowInstance, type WorkflowType } from '../shared/schema';
import type { AppConfig } from '../shared/config';
import type { WorkflowExporter, WorkflowExportResult } from './workflow-exporter';
import type { WorkflowPlanStore } from './workflow-plan-store';
import type { WorkflowDefinition, WorkflowRegistry } from './workflow-registry';
import type { WorkflowStore } from './workflow-repository';
import { parsePuebloPlanMarkdown, renderPuebloPlanMarkdown, type PuebloPlanDocument, type PuebloPlanRound } from './pueblo-plan/pueblo-plan-markdown';
import { advancePuebloPlanAfterRound, applyPuebloPlanLifecycleStatus } from './pueblo-plan/pueblo-plan-workflow';
import { buildWorkflowContextSummaries } from './workflow-context';
import {
  DEFAULT_FSM_CONFIG,
  isTerminalWorkflowState,
  markBlocked as fsmMarkBlocked,
  markCancelled as fsmMarkCancelled,
  markCompleted as fsmMarkCompleted,
  markFailed as fsmMarkFailed,
  observeTaskOutcome as fsmObserveTaskOutcome,
  resolveFsmConfig,
  evaluateWatchdog as fsmEvaluateWatchdog,
  type WorkflowTaskOutcome,
} from './workflow-fsm';

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
  readonly getConfig?: () => Pick<AppConfig, 'workflow'>;
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

  pauseWorkflow(workflowId: string): WorkflowLifecycleTransitionResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow) {
      return null;
    }

    const now = new Date().toISOString();
    const nextWorkflow = this.saveWorkflow({
      ...workflow,
      pausedAt: workflow.pausedAt ?? now,
      updatedAt: now,
    });

    return { workflow: nextWorkflow, plan: null };
  }

  clearWorkflowPause(workflowId: string): WorkflowLifecycleTransitionResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow) {
      return null;
    }

    const now = new Date().toISOString();
    const nextWorkflow = this.saveWorkflow({
      ...workflow,
      pausedAt: null,
      updatedAt: now,
    });

    return { workflow: nextWorkflow, plan: null };
  }

  observeTaskOutcome(
    workflowId: string,
    outcome: WorkflowTaskOutcome,
  ): WorkflowLifecycleTransitionResult | null {
    const workflow = this.dependencies.repository.getById(workflowId);
    if (!workflow) {
      return null;
    }

    const config = this.resolveFsmConfig();
    const now = new Date().toISOString();
    const transition = fsmObserveTaskOutcome(workflow, outcome, config, now);

    const persistedPlan = this.applyLifecyclePlan(workflow, transition.toStatus, transition.reason);
    const updatedWorkflow = this.saveWorkflow(transition.workflow);
    this.handleTerminalDisposal(updatedWorkflow);

    return { workflow: updatedWorkflow, plan: persistedPlan };
  }

  runWatchdogSweep(): WorkflowLifecycleTransitionResult[] {
    const config = this.resolveFsmConfig();

    const now = new Date().toISOString();
    const results: WorkflowLifecycleTransitionResult[] = [];
    for (const workflow of this.dependencies.repository.list()) {
      if (isTerminalWorkflowState(workflow.status)) {
        continue;
      }

      const transition = fsmEvaluateWatchdog(workflow, config, now);
      if (!transition) {
        continue;
      }

      const persistedPlan = this.applyLifecyclePlan(workflow, transition.toStatus, transition.reason);
      const updatedWorkflow = this.saveWorkflow(transition.workflow);
      this.handleTerminalDisposal(updatedWorkflow);
      results.push({ workflow: updatedWorkflow, plan: persistedPlan });
    }

    return results;
  }

  private resolveFsmConfig() {
    return this.dependencies.getConfig ? resolveFsmConfig(this.dependencies.getConfig()) : DEFAULT_FSM_CONFIG;
  }

  private handleTerminalDisposal(workflow: WorkflowInstance): void {
    if (!isTerminalWorkflowState(workflow.status)) {
      return;
    }

    if (workflow.status === 'failed' || workflow.status === 'cancelled') {
      this.dependencies.planStore.disposeWorkflow?.(workflow.id, workflow.status);
    }
  }

  private applyLifecyclePlan(
    workflow: WorkflowInstance,
    status: WorkflowInstance['status'],
    reason: string | null,
  ): PuebloPlanDocument | null {
    if (workflow.type !== 'pueblo-plan') {
      return null;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    const plan = planMarkdown ? parsePuebloPlanMarkdown(planMarkdown) : null;
    if (!plan) {
      return null;
    }

    const nextPlan = applyPuebloPlanLifecycleStatus(plan, status, reason);
    this.dependencies.planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(nextPlan));
    return nextPlan;
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

    const now = new Date().toISOString();
    let nextWorkflow: WorkflowInstance;
    switch (status) {
      case 'blocked':
        nextWorkflow = fsmMarkBlocked(workflow, reason, now).workflow;
        break;
      case 'failed':
        nextWorkflow = fsmMarkFailed(workflow, reason, now).workflow;
        break;
      case 'cancelled':
        nextWorkflow = fsmMarkCancelled(workflow, reason, now).workflow;
        break;
      case 'completed':
        nextWorkflow = fsmMarkCompleted(workflow, now).workflow;
        break;
      default:
        nextWorkflow = { ...workflow, status, updatedAt: now };
        break;
    }

    const planMarkdown = this.dependencies.planStore.readPlan(workflow.runtimePlanPath);
    const plan = planMarkdown ? parsePuebloPlanMarkdown(planMarkdown) : null;
    const nextPlan = plan && workflow.type === 'pueblo-plan'
      ? applyPuebloPlanLifecycleStatus(plan, status, reason)
      : null;

    if (nextPlan) {
      this.dependencies.planStore.writePlan(workflow.runtimePlanPath, renderPuebloPlanMarkdown(nextPlan));
      nextWorkflow = { ...nextWorkflow, updatedAt: nextPlan.updatedAt };
    }

    const updatedWorkflow = this.saveWorkflow(nextWorkflow);
    this.handleTerminalDisposal(updatedWorkflow);

    return {
      workflow: updatedWorkflow,
      plan: nextPlan,
    };
  }
}
