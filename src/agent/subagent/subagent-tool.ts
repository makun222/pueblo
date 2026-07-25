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
            'Create a new sub-agent that works on a given goal in the background. ' +
            'Returns immediately with a taskId. Use check_subagent to poll for results.',
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
                  budget: {
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
              options?: { budget?: number; maxSteps?: number };
            };

            if (typeof goal !== 'string' || goal.trim().length === 0) {
              return {
                status: 'failed' as const,
                output: ['goal must be a non-empty string'],
                summary: 'spawn_subagent failed: invalid goal',
              };
            }

            const taskId = await service.spawn(goal, options ?? {});
            return {
              status: 'succeeded' as const,
              output: [JSON.stringify({ taskId })],
              summary: `Sub-agent spawned with taskId: ${taskId}`,
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
