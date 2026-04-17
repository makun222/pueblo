import { randomUUID } from 'node:crypto';
import { RepositoryBase, fromJson, toJson, type RepositoryContext } from '../persistence/repository-base';
import { agentTaskSchema, type AgentTask } from '../shared/schema';

export interface CreateAgentTaskInput {
  readonly goal: string;
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputContextSummary: string;
  readonly status: AgentTask['status'];
  readonly outputSummary?: string | null;
  readonly toolInvocationIds?: string[];
}

interface AgentTaskRow {
  id: string;
  goal: string;
  status: AgentTask['status'];
  session_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  input_context_summary: string;
  output_summary: string | null;
  tool_invocation_ids_json: string;
  created_at: string;
  completed_at: string | null;
}

export class AgentTaskRepository extends RepositoryBase {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(input: CreateAgentTaskInput): AgentTask {
    const now = new Date().toISOString();
    const task: AgentTask = agentTaskSchema.parse({
      id: randomUUID(),
      goal: input.goal,
      status: input.status,
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      inputContextSummary: input.inputContextSummary,
      outputSummary: input.outputSummary ?? null,
      toolInvocationIds: input.toolInvocationIds ?? [],
      createdAt: now,
      completedAt: input.status === 'completed' || input.status === 'failed' ? now : null,
    });

    this.run(
      `
      INSERT INTO agent_tasks (
        id, goal, status, session_id, model_id, input_context_summary,
        provider_id, output_summary, tool_invocation_ids_json, created_at, completed_at
      ) VALUES (
        @id, @goal, @status, @session_id, @model_id, @input_context_summary,
        @provider_id, @output_summary, @tool_invocation_ids_json, @created_at, @completed_at
      )
      `,
      {
        id: task.id,
        goal: task.goal,
        status: task.status,
        session_id: task.sessionId,
        provider_id: task.providerId,
        model_id: task.modelId,
        input_context_summary: task.inputContextSummary,
        output_summary: task.outputSummary,
        tool_invocation_ids_json: toJson(task.toolInvocationIds),
        created_at: task.createdAt,
        completed_at: task.completedAt,
      },
    );

    return task;
  }

  listBySession(sessionId: string): AgentTask[] {
    const rows = this.all<AgentTaskRow>(
      'SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );

    return rows.map((row) => this.mapRow(row));
  }

  update(taskId: string, input: Omit<CreateAgentTaskInput, 'goal' | 'sessionId' | 'modelId' | 'inputContextSummary'> & {
    goal: string;
    sessionId: string | null;
    providerId: string;
    modelId: string;
    inputContextSummary: string;
  }): AgentTask {
    const existing = this.get<AgentTaskRow>('SELECT * FROM agent_tasks WHERE id = ?', [taskId]);

    if (!existing) {
      throw new Error(`Agent task not found: ${taskId}`);
    }

    const completedAt = input.status === 'completed' || input.status === 'failed' ? new Date().toISOString() : null;
    const task: AgentTask = agentTaskSchema.parse({
      id: taskId,
      goal: input.goal,
      status: input.status,
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      inputContextSummary: input.inputContextSummary,
      outputSummary: input.outputSummary ?? null,
      toolInvocationIds: input.toolInvocationIds ?? [],
      createdAt: existing.created_at,
      completedAt,
    });

    this.run(
      `
      UPDATE agent_tasks
      SET goal=@goal,
          status=@status,
          session_id=@session_id,
          provider_id=@provider_id,
          model_id=@model_id,
          input_context_summary=@input_context_summary,
          output_summary=@output_summary,
          tool_invocation_ids_json=@tool_invocation_ids_json,
          completed_at=@completed_at
      WHERE id=@id
      `,
      {
        id: task.id,
        goal: task.goal,
        status: task.status,
        session_id: task.sessionId,
        provider_id: task.providerId,
        model_id: task.modelId,
        input_context_summary: task.inputContextSummary,
        output_summary: task.outputSummary,
        tool_invocation_ids_json: toJson(task.toolInvocationIds),
        completed_at: task.completedAt,
      },
    );

    return task;
  }

  private mapRow(row: AgentTaskRow): AgentTask {
    return agentTaskSchema.parse({
      id: row.id,
      goal: row.goal,
      status: row.status,
      sessionId: row.session_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      inputContextSummary: row.input_context_summary,
      outputSummary: row.output_summary,
      toolInvocationIds: fromJson<string[]>(row.tool_invocation_ids_json),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  }
}
