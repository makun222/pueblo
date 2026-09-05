import type { CustomToolProvider } from '../../tools/tool-service';
import { SubAgentService } from './subagent-service';

/**
 * Creates a CustomToolProvider wrapping a SubAgentService instance.
 * Registered tools:
 *   - spawn_subagent(goal, options?) → { taskId }
 *   - check_subagent(taskId) → { status, result? }
 */
export function createSubAgentTool(service: SubAgentService): CustomToolProvider {
  return {
    getDefinitions() {
      return [
        {
          name: 'spawn_subagent',
          description:
            'Spawn an independent sub-agent to run a self-contained goal in the background, ' +
            'returning immediately with a taskId while you continue other work in parallel. ' +
            'PREFER this when the task can be split into independent, long-running, or ' +
            'parallelizable pieces (e.g. research N topics, write tests for separate modules, ' +
            'read/analyze multiple unrelated files). AVOID when subtasks are strictly ' +
            'sequential or need shared in-progress context. The sub-agent runs in its own ' +
            'isolated context, so the goal must be self-contained (include all needed ' +
            'context/constraints). After spawning, keep working and poll via check_subagent.',
          inputSchema: {
            type: 'object',
            properties: {
              goal: {
                type: 'string',
                description: 'The goal for the sub-agent to achieve',
              },
              options: {
                type: 'object',
                properties: {
                  budgetLimit: {
                    type: 'number',
                    description: 'Optional budget limit for the sub-agent',
                  },
                  maxSteps: {
                    type: 'number',
                    description: 'Optional maximum turns for the sub-agent',
                  },
                },
                additionalProperties: false,
              },
            },
            required: ['goal'],
            additionalProperties: false,
          },
          executionPolicy: 'free',
        },
        {
          name: 'check_subagent',
          description:
            'Check the status and result of a previously spawned sub-agent task.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The task ID returned by spawn_subagent',
              },
            },
            required: ['taskId'],
            additionalProperties: false,
          },
          executionPolicy: 'free',
        },
      ];
    },

    async execute(name: string, args: Record<string, unknown>) {
      try {
        switch (name) {
          case 'spawn_subagent': {
            const { goal, options } = args as {
              goal: string;
              options?: { budgetLimit?: number; maxSteps?: number };
            };

            if (typeof goal !== 'string' || goal.trim().length === 0) {
              return {
                status: 'failed' as const,
                output: ['goal must be a non-empty string'],
                summary: 'spawn_subagent failed: invalid goal',
              };
            }

            const taskId = await service.spawn(goal, options ?? {});
            const queued = service.check(taskId)?.status === 'pending';
            const position = queued ? service.queuePosition(taskId) : null;
            const summary = queued
              ? `Sub-agent queued${position != null ? ` (position ${position})` : ''} with taskId: ${taskId}`
              : `Sub-agent spawned (running) with taskId: ${taskId}`;
            return {
              status: 'succeeded' as const,
              output: [JSON.stringify({ taskId })],
              summary,
            };
          }

          case 'check_subagent': {
            const { taskId } = args as { taskId: string };

            if (typeof taskId !== 'string' || taskId.trim().length === 0) {
              return {
                status: 'failed' as const,
                output: ['taskId must be a non-empty string'],
                summary: 'check_subagent failed: invalid taskId',
              };
            }

            const result = service.check(taskId);
            if (!result) {
              return {
                status: 'failed' as const,
                output: [`Unknown taskId: ${taskId}`],
                summary: `check_subagent failed: task ${taskId} not found`,
              };
            }

            return {
              status: 'succeeded' as const,
              output: [JSON.stringify(result)],
              summary: `Sub-agent task ${taskId} status: ${result.status}`,
            };
          }

          default:
            return {
              status: 'failed' as const,
              output: [`Unknown subagent tool: ${name}`],
              summary: `Unknown subagent tool: ${name}`,
            };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          status: 'failed' as const,
          output: [msg],
          summary: `Sub-agent tool ${name} failed: ${msg}`,
        };
      }
    },
  };
}
