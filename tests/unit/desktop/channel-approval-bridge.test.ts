import { describe, expect, it, vi } from 'vitest';

import {
  createChannelApprovalBridge,
  type ChannelApprovalBridgeDeps,
  type ChannelApprovalTarget,
} from '../../../src/desktop/main/channel-approval-bridge';
import type {
  DesktopToolApprovalBatch,
  DesktopToolApprovalRequest,
  DesktopToolApprovalState,
} from '../../../src/desktop/shared/ipc-contract';

const CHANNEL_TAB_ID = 'desktop-tab-1';

function makeRequest(id: string, title: string): DesktopToolApprovalRequest {
  return {
    id,
    toolCallId: `call-${id}`,
    toolName: 'shell_command',
    kind: 'command',
    title,
    summary: `${title} summary`,
    detail: `${title} detail`,
    primaryText: 'allow',
    targetLabel: 'target',
    operationLabel: 'run',
  };
}

function makeBatch(id: string, requestIds: string[] = ['req-1']): DesktopToolApprovalBatch {
  return {
    id,
    taskId: `task-${id}`,
    createdAt: new Date(0).toISOString(),
    requests: requestIds.map((requestId) => makeRequest(requestId, `${requestId} title`)),
  };
}

function makeState(batch: DesktopToolApprovalBatch | null): DesktopToolApprovalState {
  return { activeBatch: batch, activeFileReview: null };
}

const target = (externalConversationId: string): ChannelApprovalTarget => ({
  channelId: 'feishu-main',
  externalConversationId,
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeDeps(overrides: Partial<ChannelApprovalBridgeDeps> = {}): {
  deps: ChannelApprovalBridgeDeps;
  getActiveSessionId: ReturnType<typeof vi.fn>;
  listTargets: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
} {
  const getActiveSessionId = vi.fn(() => 'session-1');
  const listTargets = vi.fn(async () => [target('conv-1')]);
  const sendText = vi.fn(async () => undefined);

  const deps: ChannelApprovalBridgeDeps = {
    getChannelTabId: () => CHANNEL_TAB_ID,
    getActiveSessionId,
    listTargets,
    sendText,
    respondApproval: vi.fn(),
    ...overrides,
  };

  return { deps, getActiveSessionId, listTargets, sendText };
}

describe('channel-approval-bridge', () => {
  it('captures the session synchronously and mirrors the batch once targets resolve', async () => {
    const { deps, getActiveSessionId, listTargets, sendText } = makeDeps();
    const bridge = createChannelApprovalBridge(deps);

    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(makeBatch('batch-1')));

    // No microtask/await required: the session is already attached.
    expect(getActiveSessionId).toHaveBeenCalledWith(CHANNEL_TAB_ID);
    expect(bridge.pendingApproval()?.sessionId).toBe('session-1');
    expect(listTargets).toHaveBeenCalledWith('session-1');

    await flush();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]).toEqual(target('conv-1'));
  });

  it('never fans out a stale prompt when the batch is superseded mid-lookup', async () => {
    const pending: Array<(targets: readonly ChannelApprovalTarget[]) => void> = [];
    const listTargets = vi.fn(
      () =>
        new Promise<readonly ChannelApprovalTarget[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { deps, sendText } = makeDeps({ listTargets });
    const bridge = createChannelApprovalBridge(deps);

    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(makeBatch('batch-A')));
    // A newer batch replaces the first while its target lookup is still pending.
    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(makeBatch('batch-B')));

    // The superseded batch resolves late: its prompt must be dropped.
    pending[0]?.([target('conv-A')]);
    await flush();
    expect(sendText).not.toHaveBeenCalled();

    pending[1]?.([target('conv-B')]);
    await flush();

    // Exactly one fan-out, and it belongs to the still-active batch.
    const conversations = sendText.mock.calls.map(([sent]) => sent.externalConversationId);
    expect(conversations).toEqual(['conv-B']);
  });

  it('never fans out when the batch is cleared while the lookup is pending', async () => {
    let resolveTargets: ((targets: readonly ChannelApprovalTarget[]) => void) | undefined;
    const listTargets = vi.fn(
      () =>
        new Promise<readonly ChannelApprovalTarget[]>((resolve) => {
          resolveTargets = resolve;
        }),
    );
    const { deps, sendText } = makeDeps({ listTargets });
    const bridge = createChannelApprovalBridge(deps);

    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(makeBatch('batch-1')));
    // The batch ends (answered locally on the PC) before the lookup resolves.
    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(null));

    resolveTargets?.([target('conv-1')]);
    await flush();

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips the fan-out entirely when no session is active', async () => {
    const { deps, listTargets, sendText } = makeDeps({ getActiveSessionId: vi.fn(() => null) });
    const bridge = createChannelApprovalBridge(deps);

    bridge.handleToolApprovalState(CHANNEL_TAB_ID, makeState(makeBatch('batch-1')));
    await flush();

    expect(listTargets).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(bridge.pendingApproval()?.sessionId).toBeNull();
  });

  it('ignores batches from tabs that do not own the channel window', async () => {
    const { deps, getActiveSessionId, listTargets, sendText } = makeDeps();
    const bridge = createChannelApprovalBridge(deps);

    bridge.handleToolApprovalState('desktop-tab-2', makeState(makeBatch('batch-1')));
    await flush();

    expect(getActiveSessionId).not.toHaveBeenCalled();
    expect(listTargets).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(bridge.pendingApproval()).toBeNull();
  });
});
