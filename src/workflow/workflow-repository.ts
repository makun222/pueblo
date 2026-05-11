import { fromJson, RepositoryBase, toJson, type RepositoryContext } from '../persistence/repository-base';
import { workflowInstanceSchema, type WorkflowInstance } from '../shared/schema';
import { createWorkflowInstanceModel, type CreateWorkflowInstanceInput } from './workflow-model';

interface WorkflowInstanceRow {
  id: string;
  type: WorkflowInstance['type'];
  status: WorkflowInstance['status'];
  session_id: string | null;
  agent_instance_id: string | null;
  goal: string;
  target_directory: string | null;
  runtime_plan_path: string;
  deliverable_plan_path: string | null;
  active_plan_memory_id: string | null;
  active_todo_memory_id: string | null;
  active_round_number: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
}

export interface WorkflowStore {
  create(input: CreateWorkflowInstanceInput): WorkflowInstance;
  list(): WorkflowInstance[];
  listBySession(sessionId: string): WorkflowInstance[];
  getById(workflowId: string): WorkflowInstance | null;
  getActiveBySession(sessionId: string): WorkflowInstance | null;
  save(workflow: WorkflowInstance): WorkflowInstance;
}

export class InMemoryWorkflowRepository implements WorkflowStore {
  private readonly workflows = new Map<string, WorkflowInstance>();

  create(input: CreateWorkflowInstanceInput): WorkflowInstance {
    const workflow = createWorkflowInstanceModel(input);
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  list(): WorkflowInstance[] {
    return [...this.workflows.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listBySession(sessionId: string): WorkflowInstance[] {
    return this.list().filter((workflow) => workflow.sessionId === sessionId);
  }

  getById(workflowId: string): WorkflowInstance | null {
    return this.workflows.get(workflowId) ?? null;
  }

  getActiveBySession(sessionId: string): WorkflowInstance | null {
    return this.listBySession(sessionId).find((workflow) => isWorkflowActive(workflow.status)) ?? null;
  }

  save(workflow: WorkflowInstance): WorkflowInstance {
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }
}

export class WorkflowRepository extends RepositoryBase implements WorkflowStore {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(input: CreateWorkflowInstanceInput): WorkflowInstance {
    const workflow = createWorkflowInstanceModel(input);
    this.save(workflow);
    return workflow;
  }

  list(): WorkflowInstance[] {
    const rows = this.all<WorkflowInstanceRow>('SELECT * FROM workflow_instances ORDER BY updated_at DESC');
    return rows.map((row) => this.mapRow(row));
  }

  listBySession(sessionId: string): WorkflowInstance[] {
    const rows = this.all<WorkflowInstanceRow>(
      'SELECT * FROM workflow_instances WHERE session_id = ? ORDER BY updated_at DESC',
      [sessionId],
    );

    return rows.map((row) => this.mapRow(row));
  }

  getById(workflowId: string): WorkflowInstance | null {
    const row = this.get<WorkflowInstanceRow>('SELECT * FROM workflow_instances WHERE id = ?', [workflowId]);
    return row ? this.mapRow(row) : null;
  }

  getActiveBySession(sessionId: string): WorkflowInstance | null {
    const row = this.get<WorkflowInstanceRow>(
      `
      SELECT *
        FROM workflow_instances
       WHERE session_id = ?
         AND status IN ('assessing', 'planning', 'round-active', 'round-review', 'blocked')
       ORDER BY updated_at DESC
       LIMIT 1
      `,
      [sessionId],
    );

    return row ? this.mapRow(row) : null;
  }

  save(workflow: WorkflowInstance): WorkflowInstance {
    const existing = this.getById(workflow.id);

    if (existing) {
      this.run(
        `
        UPDATE workflow_instances
           SET type = @type,
               status = @status,
               session_id = @session_id,
               agent_instance_id = @agent_instance_id,
               goal = @goal,
               target_directory = @target_directory,
               runtime_plan_path = @runtime_plan_path,
               deliverable_plan_path = @deliverable_plan_path,
               active_plan_memory_id = @active_plan_memory_id,
               active_todo_memory_id = @active_todo_memory_id,
               active_round_number = @active_round_number,
               created_at = @created_at,
               updated_at = @updated_at,
               completed_at = @completed_at,
               failed_at = @failed_at,
               cancelled_at = @cancelled_at
         WHERE id = @id
        `,
        this.toParams(workflow),
      );
    } else {
      this.run(
        `
        INSERT INTO workflow_instances (
          id, type, status, session_id, agent_instance_id, goal,
          target_directory, runtime_plan_path, deliverable_plan_path,
          active_plan_memory_id, active_todo_memory_id, active_round_number,
          created_at, updated_at, completed_at, failed_at, cancelled_at
        ) VALUES (
          @id, @type, @status, @session_id, @agent_instance_id, @goal,
          @target_directory, @runtime_plan_path, @deliverable_plan_path,
          @active_plan_memory_id, @active_todo_memory_id, @active_round_number,
          @created_at, @updated_at, @completed_at, @failed_at, @cancelled_at
        )
        `,
        this.toParams(workflow),
      );
    }

    return workflow;
  }

  private mapRow(row: WorkflowInstanceRow): WorkflowInstance {
    return workflowInstanceSchema.parse({
      id: row.id,
      type: row.type,
      status: row.status,
      sessionId: row.session_id,
      agentInstanceId: row.agent_instance_id,
      goal: row.goal,
      targetDirectory: row.target_directory,
      runtimePlanPath: row.runtime_plan_path,
      deliverablePlanPath: row.deliverable_plan_path,
      activePlanMemoryId: row.active_plan_memory_id,
      activeTodoMemoryId: row.active_todo_memory_id,
      activeRoundNumber: row.active_round_number,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      cancelledAt: row.cancelled_at,
    });
  }

  private toParams(workflow: WorkflowInstance) {
    return {
      id: workflow.id,
      type: workflow.type,
      status: workflow.status,
      session_id: workflow.sessionId,
      agent_instance_id: workflow.agentInstanceId,
      goal: workflow.goal,
      target_directory: workflow.targetDirectory,
      runtime_plan_path: workflow.runtimePlanPath,
      deliverable_plan_path: workflow.deliverablePlanPath,
      active_plan_memory_id: workflow.activePlanMemoryId,
      active_todo_memory_id: workflow.activeTodoMemoryId,
      active_round_number: workflow.activeRoundNumber,
      created_at: workflow.createdAt,
      updated_at: workflow.updatedAt,
      completed_at: workflow.completedAt,
      failed_at: workflow.failedAt,
      cancelled_at: workflow.cancelledAt,
    };
  }
}

function isWorkflowActive(status: WorkflowInstance['status']): boolean {
  return ['assessing', 'planning', 'round-active', 'round-review', 'blocked'].includes(status);
}
