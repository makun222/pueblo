import { describe, it, expect, vi } from 'vitest';
import {
  parseChannelCommand,
  resolveRef,
  runChannelCommand,
} from '../../../src/channel/channel-command-router';
import type {
  ChannelAgentOption,
  ChannelAgentSelection,
  ChannelApprovalDecision,
  ChannelApprovalPrompt,
  ChannelApprovalResult,
  ChannelControl,
  ChannelSessionOption,
  ChannelSessionStatus,
} from '../../../src/channel/channel-types';

// ---------------------------------------------------------------------------
// Fake control surface
// ---------------------------------------------------------------------------
function makeSession(id: string, title: string, agentInstanceId: string | null): ChannelSessionOption {
  return { id, title, agentInstanceId, status: 'active', updatedAt: '2026-09-19T10:00:00.000Z' };
}

function makeControl(overrides: Partial<ChannelControl> = {}): ChannelControl {
  const agents: ChannelAgentOption[] = [
    { id: 'agent-1', profileId: 'code-master', name: 'Code Master', isActive: true },
    { id: 'agent-2', profileId: 'writer', name: 'Writer' },
  ];
  const sessions: ChannelSessionOption[] = [
    makeSession('session-1', 'Feature work', 'agent-1'),
    makeSession('session-2', 'Docs', 'agent-1'),
  ];
  return {
    listAgents: () => agents,
    selectAgent: vi.fn(async (ref: string): Promise<ChannelAgentSelection> => {
      const agent = agents.find((a) => a.id === ref) ?? agents[0];
      return { agent, session: sessions.find((s) => s.agentInstanceId === agent.id) ?? null };
    }),
    listSessions: () => sessions,
    createSession: vi.fn(async (title: string, agentInstanceId: string | null) =>
      makeSession('session-new', title, agentInstanceId),
    ),
    selectSession: vi.fn(async (sessionId: string) =>
      sessions.find((s) => s.id === sessionId) ?? sessions[0],
    ),
    getSessionStatus: vi.fn((): ChannelSessionStatus => ({
      sessionId: 'session-1',
      title: 'Feature work',
      agentInstanceId: 'agent-1',
      sessionStatus: 'active',
      taskStatus: 'running',
      goal: 'Add feishu control',
      outputSummary: 'working…',
      updatedAt: '2026-09-19T10:05:00.000Z',
    })),
    ...overrides,
  };
}

const NO_BINDING = { binding: null };

describe('parseChannelCommand', () => {
  it('returns null for plain text', () => {
    expect(parseChannelCommand('hello world')).toBeNull();
    expect(parseChannelCommand('  ')).toBeNull();
  });

  it('returns null for "//" escapes so literal slashes reach the LLM', () => {
    expect(parseChannelCommand('//usr/local')).toBeNull();
  });

  it('parses command + args', () => {
    expect(parseChannelCommand('/agent 2')).toEqual({ command: 'agent', args: ['2'], rawArgs: '2' });
    expect(parseChannelCommand('/new My task')).toEqual({
      command: 'new',
      args: ['My', 'task'],
      rawArgs: 'My task',
    });
    expect(parseChannelCommand('/STATUS')).toEqual({ command: 'status', args: [], rawArgs: '' });
  });
});

describe('resolveRef', () => {
  it('resolves by 1-based index', () => {
    expect(resolveRef('2', ['a', 'b', 'c'], (x) => [x])).toBe('b');
    expect(resolveRef('9', ['a'], (x) => [x])).toBeNull();
  });

  it('resolves by alias (case-insensitive)', () => {
    expect(resolveRef('CODE-MASTER', [{ id: 'agent-1', name: 'Code Master' }], (a) => [a.id, a.name])).toBe(
      'agent-1',
    );
  });

  it('falls back to the raw reference (id passthrough)', () => {
    expect(resolveRef('unknown-id', [], (x) => [x])).toBe('unknown-id');
  });
});

describe('runChannelCommand', () => {
  it('ignores unknown commands (flows to the LLM)', async () => {
    const outcome = await runChannelCommand({ command: 'nope', args: [], rawArgs: '' }, makeControl(), NO_BINDING);
    expect(outcome).toEqual({ handled: false, reply: null });
  });

  it('lists agents with an active marker', async () => {
    const outcome = await runChannelCommand({ command: 'agents', args: [], rawArgs: '' }, makeControl(), NO_BINDING);
    expect(outcome.handled).toBe(true);
    expect(outcome.reply).toContain('Code Master');
    expect(outcome.reply).toContain('✅当前');
  });

  it('/agent selects by index and persists the selection', async () => {
    const control = makeControl();
    const outcome = await runChannelCommand({ command: 'agent', args: ['2'], rawArgs: '2' }, control, NO_BINDING);
    expect(control.selectAgent).toHaveBeenCalledWith('agent-2');
    expect(outcome.selection).toEqual({ agentInstanceId: 'agent-2', selectedSessionId: null });
  });

  it('/new creates a session under the bound agent', async () => {
    const control = makeControl();
    const outcome = await runChannelCommand(
      { command: 'new', args: ['T'], rawArgs: 'T' },
      control,
      { binding: { sessionId: '', agentInstanceId: 'agent-1', selectedSessionId: null } },
    );
    expect(control.createSession).toHaveBeenCalledWith('T', 'agent-1');
    expect(outcome.selection?.selectedSessionId).toBe('session-new');
  });

  it('/status queries the bound session (read-only)', async () => {
    const control = makeControl();
    const outcome = await runChannelCommand({ command: 'status', args: [], rawArgs: '' }, control, {
      binding: { sessionId: 'session-1', agentInstanceId: null, selectedSessionId: 'session-1' },
    });
    expect(control.getSessionStatus).toHaveBeenCalledWith('session-1');
    expect(outcome.reply).toContain('running');
    expect(outcome.reply).toContain('Add feishu control');
  });

  it('/status without binding asks to pick an agent', async () => {
    const outcome = await runChannelCommand({ command: 'status', args: [], rawArgs: '' }, makeControl(), NO_BINDING);
    expect(outcome.reply).toContain('/agents');
  });

  it('/reset requests binding clearance', async () => {
    const outcome = await runChannelCommand({ command: 'reset', args: [], rawArgs: '' }, makeControl(), NO_BINDING);
    expect(outcome.reset).toBe(true);
    expect(outcome.handled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval commands (/pending, /approve, /approve-all, /deny)
// ---------------------------------------------------------------------------
function makeApprovalPrompt(count: number, sessionId: string | null = 'session-1'): ChannelApprovalPrompt {
  const requests = Array.from({ length: count }, (_, i) => ({
    id: `req-${i + 1}`,
    toolName: i === 0 ? 'run_command' : 'edit_file',
    kind: i === 0 ? 'command' : 'file-edit',
    title: `Tool call ${i + 1}`,
    summary: `summary ${i + 1}`,
  }));
  return { batchId: 'batch-1234567890', sessionId, requests };
}

/** Control with an approval surface; `prompt` is served on every read. */
function approvalControl(prompt: ChannelApprovalPrompt | null) {
  const respondApproval = vi.fn(
    async (decision: ChannelApprovalDecision, requestId?: string): Promise<ChannelApprovalResult> => ({
      ok: true,
      decision,
      affectedIds: requestId ? [requestId] : (prompt?.requests.map((r) => r.id) ?? []),
      message: `已提交：${decision}${requestId ? `/${requestId}` : ''}`,
    }),
  );
  const control = makeControl({ pendingApproval: () => prompt, respondApproval });
  return { control, respondApproval };
}

describe('approval commands', () => {
  it('/pending falls back to the desktop when the host has no approval surface', async () => {
    const outcome = await runChannelCommand({ command: 'pending', args: [], rawArgs: '' }, makeControl(), NO_BINDING);
    expect(outcome.handled).toBe(true);
    expect(outcome.reply).toContain('不支持审批');
  });

  it('/pending reports an empty queue', async () => {
    const { control } = approvalControl(null);
    const outcome = await runChannelCommand({ command: 'pending', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(outcome.reply).toContain('没有待审批');
  });

  it('/pending lists each request and the available decisions', async () => {
    const { control } = approvalControl(makeApprovalPrompt(2));
    const outcome = await runChannelCommand({ command: 'pending', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(outcome.reply).toContain('2 项工具调用待审批');
    expect(outcome.reply).toContain('[command] Tool call 1');
    expect(outcome.reply).toContain('[file-edit] Tool call 2');
    expect(outcome.reply).toContain('/approve 1');
    expect(outcome.reply).toContain('/approve 2');
    expect(outcome.reply).toContain('/approve-all');
    expect(outcome.reply).toContain('/deny');
  });

  it('/approve <n> allows the chosen request and warns about the rest', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(2));
    const outcome = await runChannelCommand({ command: 'approve', args: ['1'], rawArgs: '1' }, control, NO_BINDING);
    expect(respondApproval).toHaveBeenCalledWith('allow', 'req-1');
    expect(outcome.reply).toContain('已提交：allow/req-1');
    expect(outcome.reply).toContain('其余 1 项未选择');
  });

  it('/approve with no argument allows the only request', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(1));
    const outcome = await runChannelCommand({ command: 'approve', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(respondApproval).toHaveBeenCalledWith('allow', 'req-1');
    expect(outcome.reply).not.toContain('其余');
  });

  it('/approve with no argument and multiple requests asks for an index', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(3));
    const outcome = await runChannelCommand({ command: 'approve', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(respondApproval).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('请用 /approve <序号>');
  });

  it('/approve rejects a non-numeric index', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(2));
    const outcome = await runChannelCommand({ command: 'approve', args: ['x'], rawArgs: 'x' }, control, NO_BINDING);
    expect(respondApproval).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('序号无效');
  });

  it('/approve rejects an out-of-range index', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(2));
    const outcome = await runChannelCommand({ command: 'approve', args: ['9'], rawArgs: '9' }, control, NO_BINDING);
    expect(respondApproval).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('序号超出范围');
  });

  it('/approve with no pending batch reports an empty queue', async () => {
    const { control, respondApproval } = approvalControl(null);
    const outcome = await runChannelCommand({ command: 'approve', args: ['1'], rawArgs: '1' }, control, NO_BINDING);
    expect(respondApproval).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('没有待审批');
  });

  it('/approve falls back to the desktop without an approval surface', async () => {
    const outcome = await runChannelCommand({ command: 'approve', args: ['1'], rawArgs: '1' }, makeControl(), NO_BINDING);
    expect(outcome.reply).toContain('不支持审批');
  });

  it('/approve-all allows the whole batch', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(3));
    const outcome = await runChannelCommand({ command: 'approve-all', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(respondApproval).toHaveBeenCalledWith('allow-all', undefined);
    expect(outcome.reply).toContain('已提交：allow-all');
  });

  it('/deny rejects the whole batch', async () => {
    const { control, respondApproval } = approvalControl(makeApprovalPrompt(2));
    const outcome = await runChannelCommand({ command: 'deny', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(respondApproval).toHaveBeenCalledWith('deny', undefined);
    expect(outcome.reply).toContain('已提交：deny');
  });

  it('/approve-all with no pending batch reports an empty queue', async () => {
    const { control, respondApproval } = approvalControl(null);
    const outcome = await runChannelCommand({ command: 'approve-all', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(respondApproval).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('没有待审批');
  });

  it('surfaces a host failure instead of throwing', async () => {
    const respondApproval = vi.fn(async (): Promise<ChannelApprovalResult> => {
      throw new Error('bridge offline');
    });
    const control = makeControl({ pendingApproval: () => makeApprovalPrompt(1), respondApproval });
    const outcome = await runChannelCommand({ command: 'deny', args: [], rawArgs: '' }, control, NO_BINDING);
    expect(outcome.handled).toBe(true);
    expect(outcome.reply).toContain('审批失败');
    expect(outcome.reply).toContain('bridge offline');
  });
});
