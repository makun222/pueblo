import { describe, it, expect, vi, beforeEach } from 'vitest';

// Persistence is fs-backed; stub it so the routing logic is testable in memory.
const configMock = vi.hoisted(() => ({
  binding: null as null | {
    sessionId: string;
    agentInstanceId?: string | null;
    selectedSessionId?: string | null;
  },
  recordSelection: vi.fn(async () => undefined),
  clearBinding: vi.fn(async () => undefined),
  recordSession: vi.fn(async () => undefined),
}));

vi.mock('../../../src/channel/channel-config', () => ({
  resolveChannelBinding: vi.fn(async () => configMock.binding),
  recordChannelSelection: configMock.recordSelection,
  clearChannelBinding: configMock.clearBinding,
  recordChannelSession: configMock.recordSession,
}));

import { ChannelService } from '../../../src/channel/channel-service';
import { ChannelRegistry } from '../../../src/channel/channel-registry';
import type {
  ChannelConfig,
  ChannelControl,
  InboundMessage,
} from '../../../src/channel/channel-types';
import type { RuntimeCoordinator } from '../../../src/app/runtime';
import type { IpcInputEnvelope } from '../../../src/shared/schema';
import type { CommandResult } from '../../../src/shared/result';

function makeConfig(): ChannelConfig {
  return { id: 'feishu-1', kind: 'feishu' } as unknown as ChannelConfig;
}

function makeMessage(text: string): InboundMessage {
  return {
    channelId: 'feishu-1',
    externalConversationId: 'chat-1',
    externalMessageId: 'msg-1',
    senderId: 'user-1',
    text,
    raw: { text },
    receivedAt: Date.now(),
  };
}

/** submitInput mock typed against the real envelope so `mock.calls` is readable. */
function makeSubmitInput() {
  return vi.fn<(envelope: IpcInputEnvelope) => Promise<CommandResult<unknown>>>(async () => ({
    ok: true,
    code: 'ok',
    message: 'done',
    suggestions: [],
  }));
}

function makeControl(overrides: Partial<ChannelControl> = {}): ChannelControl {
  return {
    isRuntimeBusy: () => false,
    listAgents: () => [{ id: 'agent-1', profileId: 'code-master', name: 'Code Master', isActive: true }],
    selectAgent: async () => ({
      agent: { id: 'agent-1', profileId: 'code-master', name: 'Code Master' },
      session: { id: 'session-1', title: 'Work', agentInstanceId: 'agent-1', status: 'active', updatedAt: 'now' },
    }),
    listSessions: () => [],
    createSession: async (title, agentInstanceId) => ({
      id: 'session-new',
      title,
      agentInstanceId,
      status: 'active',
      updatedAt: 'now',
    }),
    selectSession: async (sessionId) => ({
      id: sessionId,
      title: 'Work',
      agentInstanceId: 'agent-1',
      status: 'active',
      updatedAt: 'now',
    }),
    getSessionStatus: () => ({
      sessionId: 'session-1',
      sessionStatus: 'active',
      taskStatus: 'running',
      goal: 'g',
      outputSummary: 'o',
      updatedAt: 'now',
    }),
    ...overrides,
  };
}

function makeService(submitInput: ReturnType<typeof vi.fn>, control?: ChannelControl): ChannelService {
  const runtime = { submitInput } as unknown as RuntimeCoordinator;
  return new ChannelService({
    runtime,
    registry: new ChannelRegistry(),
    createSession: async () => 'session-created',
    control,
  });
}

describe('ChannelService control (飞书窗口)', () => {
  beforeEach(() => {
    configMock.binding = null;
    configMock.recordSelection.mockClear();
    configMock.clearBinding.mockClear();
    configMock.recordSession.mockClear();
  });

  it('drops plain text while the CLI runtime is busy (原则 1)', async () => {
    const submitInput = makeSubmitInput();
    const service = makeService(submitInput, makeControl({ isRuntimeBusy: () => true }));
    const send = vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('do something'), makeConfig());

    expect(submitInput).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].text).toContain('已丢弃');
  });

  it('still allows read-only /status while busy (确认点 2)', async () => {
    const submitInput = makeSubmitInput();
    const getSessionStatus = vi.fn(() => ({
      sessionId: 'session-1',
      sessionStatus: 'active' as const,
      taskStatus: 'running' as const,
      goal: 'g',
      outputSummary: 'o',
      updatedAt: 'now',
    }));
    configMock.binding = { sessionId: 'session-1', selectedSessionId: 'session-1', agentInstanceId: null };
    const service = makeService(
      submitInput,
      makeControl({ isRuntimeBusy: () => true, getSessionStatus }),
    );
    const send = vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('/status'), makeConfig());

    expect(getSessionStatus).toHaveBeenCalledWith('session-1');
    expect(submitInput).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1].text).toContain('running');
  });

  it('blocks mutating /agent while busy', async () => {
    const submitInput = makeSubmitInput();
    const selectAgent = vi.fn();
    const service = makeService(
      submitInput,
      makeControl({ isRuntimeBusy: () => true, selectAgent: selectAgent as never }),
    );
    const send = vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('/agent 1'), makeConfig());

    expect(selectAgent).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1].text).toContain('不能抢占');
  });

  it('routes plain text to the bound session', async () => {
    const submitInput = makeSubmitInput();
    configMock.binding = { sessionId: 'session-owner', selectedSessionId: 'session-selected', agentInstanceId: 'agent-1' };
    const service = makeService(submitInput, makeControl());
    vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('build it'), makeConfig());

    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(submitInput.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-selected',
      inputText: 'build it',
    });
  });

  it('creates a session under the bound agent when none exists', async () => {
    const submitInput = makeSubmitInput();
    const createSession = vi.fn(async (title: string, agentInstanceId: string | null) => ({
      id: 'session-new',
      title,
      agentInstanceId,
      status: 'active' as const,
      updatedAt: 'now',
    }));
    configMock.binding = { sessionId: '', selectedSessionId: null, agentInstanceId: 'agent-1' };
    const service = makeService(submitInput, makeControl({ createSession }));
    vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('hello'), makeConfig());

    expect(createSession).toHaveBeenCalledWith(expect.stringContaining('hello'), 'agent-1');
    expect(submitInput.mock.calls[0][0]).toMatchObject({ sessionId: 'session-new' });
  });

  it('behaves as pass-through when no control is injected (legacy)', async () => {
    const submitInput = makeSubmitInput();
    const service = makeService(submitInput);
    vi.spyOn(service, 'send').mockResolvedValue(undefined);

    await service.handleInbound(makeMessage('/agents'), makeConfig());

    // No control → "/agents" is treated as ordinary input for the runtime.
    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(submitInput.mock.calls[0][0].inputText).toBe('/agents');
  });
});
