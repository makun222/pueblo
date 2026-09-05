import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubAgentTool } from '../subagent-tool';
import type { SubAgentService } from '../subagent-service';
import type { SubAgentTask, SubAgentStatus } from '../subagent-types';

// ---------------------------------------------------------------------------
// Mock SubAgentService
// ---------------------------------------------------------------------------
function createMockService(): SubAgentService {
  return {
    spawn: vi.fn<(goal: string) => Promise<string>>().mockResolvedValue('task-001'),
    check: vi.fn<(taskId: string) => SubAgentTask | null>().mockImplementation(
      (taskId: string): SubAgentTask | null => {
        if (taskId === 'task-001') {
          return {
            taskId: 'task-001',
            status: 'completed',
            result: 'Task completed successfully.',
            createdAt: 1000,
            completedAt: 2000,
          };
        }
        if (taskId === 'task-running') {
          return {
            taskId: 'task-running',
            status: 'running',
            createdAt: 3000,
          };
        }
        return null;
      },
    ),
    cancel: vi.fn<(taskId: string) => void>().mockReturnValue(undefined),
    queuePosition: vi.fn<(taskId: string) => number | null>().mockReturnValue(null),
    activeTasks: new Map<string, SubAgentTask>(),
  } as unknown as SubAgentService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SubAgentTool', () => {
  let service: SubAgentService;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    service = createMockService();
    tool = createSubAgentTool(service);
  });

  describe('getDefinitions()', () => {
    it('should return spawn_subagent and check_subagent definitions', () => {
      const defs = tool.getDefinitions();
      expect(defs).toHaveLength(2);

      const spawnDef = defs.find((d) => d.name === 'spawn_subagent');
      expect(spawnDef).toBeDefined();
      expect(spawnDef!.description).toContain('sub-agent');
      expect(spawnDef!.inputSchema).toBeDefined();
      expect(spawnDef!.executionPolicy).toBe('free');

      const checkDef = defs.find((d) => d.name === 'check_subagent');
      expect(checkDef).toBeDefined();
      expect(checkDef!.description).toContain('sub-agent');
      expect(checkDef!.inputSchema).toBeDefined();
      expect(checkDef!.executionPolicy).toBe('free');
    });

    it('should expose budgetLimit (not the legacy budget name) in spawn_subagent options schema', () => {
      const defs = tool.getDefinitions();
      const spawnDef = defs.find((d) => d.name === 'spawn_subagent');
      expect(spawnDef).toBeDefined();

      const optionsProps = (
        spawnDef!.inputSchema as {
          properties: { options: { properties: Record<string, unknown> } };
        }
      ).properties.options.properties;
      expect(optionsProps.budgetLimit).toBeDefined();
      expect(optionsProps.budget).toBeUndefined();
    });
  });

  describe('execute() – spawn_subagent', () => {
    it('should spawn a sub-agent and return success with taskId', async () => {
      const result = await tool.execute('spawn_subagent', { goal: 'Write unit tests' });

      expect(result.status).toBe('succeeded');
      expect(Array.isArray(result.output)).toBe(true);
      expect(result.output[0]).toContain('task-001');
      expect(result.summary).toContain('task-001');

      // Verify the underlying service was called
      expect(service.spawn).toHaveBeenCalledWith('Write unit tests', {});
    });

    it('should report queued status and position when spawn lands in the pending queue', async () => {
      (service.spawn as ReturnType<typeof vi.fn>).mockResolvedValue('task-queued');
      (service.check as ReturnType<typeof vi.fn>).mockImplementation((taskId: string) =>
        taskId === 'task-queued'
          ? { taskId: 'task-queued', status: 'pending' as const, createdAt: 1000 }
          : null,
      );
      (service.queuePosition as ReturnType<typeof vi.fn>).mockReturnValue(2);

      const result = await tool.execute('spawn_subagent', { goal: 'queued-goal' });

      expect(result.status).toBe('succeeded');
      expect(result.summary).toContain('queued');
      expect(result.summary).toContain('position 2');
      expect(result.summary).toContain('task-queued');
    });

    it('should fail when goal is missing', async () => {
      const result = await tool.execute('spawn_subagent', {});

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('goal');
    });

    it('should handle service rejection gracefully', async () => {
      (service.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Service unavailable'),
      );

      const result = await tool.execute('spawn_subagent', { goal: 'test' });

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Service unavailable');
    });
  });

  describe('execute() – check_subagent', () => {
    it('should return completed status for a finished task', async () => {
      const result = await tool.execute('check_subagent', { taskId: 'task-001' });

      expect(result.status).toBe('succeeded');
      expect(Array.isArray(result.output)).toBe(true);
      expect(result.output.join(' ')).toContain('completed');
      expect(result.summary).toContain('completed');
    });

    it('should return succeeded status for a running task', async () => {
      const result = await tool.execute('check_subagent', { taskId: 'task-running' });

      expect(result.status).toBe('succeeded');
      expect(result.output.join(' ')).toContain('running');
      expect(result.summary).toContain('running');
    });

    it('should return failed status for a missing task', async () => {
      const result = await tool.execute('check_subagent', { taskId: 'task-unknown' });

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('not found');
    });

    it('should fail when taskId is missing', async () => {
      const result = await tool.execute('check_subagent', {});

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('taskId');
    });
  });

  describe('execute() – unknown tool', () => {
    it('should return failed status for an unrecognised tool name', async () => {
      const result = await tool.execute('unknown_tool', {});

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('unknown');
    });
  });
});
