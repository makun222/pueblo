import { randomUUID } from 'node:crypto';
import { RepositoryBase, type RepositoryContext } from '../persistence/repository-base';
import { toolInvocationSchema, type ToolInvocation } from '../shared/schema';

export interface CreateToolInvocationInput {
  readonly toolName: ToolInvocation['toolName'];
  readonly taskId: string;
  readonly inputSummary: string;
  readonly resultStatus: ToolInvocation['resultStatus'];
  readonly resultSummary: string;
}

interface ToolInvocationRow {
  id: string;
  tool_name: ToolInvocation['toolName'];
  task_id: string;
  input_summary: string;
  result_status: ToolInvocation['resultStatus'];
  result_summary: string;
  created_at: string;
}

export class ToolInvocationRepository extends RepositoryBase {
  constructor(context: RepositoryContext) {
    super(context);
  }

  create(input: CreateToolInvocationInput): ToolInvocation {
    const invocation = toolInvocationSchema.parse({
      id: randomUUID(),
      toolName: input.toolName,
      taskId: input.taskId,
      inputSummary: input.inputSummary,
      resultStatus: input.resultStatus,
      resultSummary: input.resultSummary,
      createdAt: new Date().toISOString(),
    });

    this.run(
      `INSERT INTO tool_invocations (id, tool_name, task_id, input_summary, result_status, result_summary, created_at)
       VALUES (@id, @tool_name, @task_id, @input_summary, @result_status, @result_summary, @created_at)`,
      {
        id: invocation.id,
        tool_name: invocation.toolName,
        task_id: invocation.taskId,
        input_summary: invocation.inputSummary,
        result_status: invocation.resultStatus,
        result_summary: invocation.resultSummary,
        created_at: invocation.createdAt,
      },
    );

    return invocation;
  }

  listByTask(taskId: string): ToolInvocation[] {
    return this.all<ToolInvocationRow>('SELECT * FROM tool_invocations WHERE task_id = ? ORDER BY created_at ASC', [taskId]).map(
      (row) =>
        toolInvocationSchema.parse({
          id: row.id,
          toolName: row.tool_name,
          taskId: row.task_id,
          inputSummary: row.input_summary,
          resultStatus: row.result_status,
          resultSummary: row.result_summary,
          createdAt: row.created_at,
        }),
    );
  }
}
