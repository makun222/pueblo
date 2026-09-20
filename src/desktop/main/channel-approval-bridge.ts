// ---------------------------------------------------------------------------
// Channel Approval Bridge
//
// Desktop surfaces a tool-approval batch to the renderer (`onToolApprovalState`).
// This bridge mirrors the same batch to every Feishu conversation bound to the
// batch's session, so a user who stepped away from the PC can answer from their
// phone. Answers may come from either terminal — the first one wins, because
// both end up calling `manager.respondToolApproval`.
//
// Reads are synchronous (the command router calls `pendingApproval()` while
// rendering a reply), so the batch state is cached in memory and the outbound
// Feishu fan-out happens fire-and-forget.
// ---------------------------------------------------------------------------

import type {
  ChannelApprovalDecision,
  ChannelApprovalPrompt,
  ChannelApprovalRequest,
  ChannelApprovalResult,
} from '../../channel/channel-types';
import type {
  DesktopToolApprovalBatch,
  DesktopToolApprovalResponse,
  DesktopToolApprovalState,
} from '../shared/ipc-contract';
import { formatApprovalPrompt } from '../../channel/channel-command-router';

/** A Feishu conversation that should receive the approval prompt. */
export interface ChannelApprovalTarget {
  channelId: string;
  externalConversationId: string;
}

export interface ChannelApprovalBridgeDeps {
  /** Desktop tab that owns the channel window (null → channels are inactive). */
  getChannelTabId(): string | null;
  /**
   * Active session on a tab; used to resolve which conversations to notify.
   * Synchronous on purpose: the session must be captured in the same tick the
   * batch is announced, otherwise an async lookup could resolve after the batch
   * was superseded and mirror the prompt to the wrong session.
   */
  getActiveSessionId(tabId: string): string | null;
  /** All conversations bound to a session (fan-out targets). */
  listTargets(sessionId: string): Promise<readonly ChannelApprovalTarget[]>;
  /** Send plain text back to a conversation. */
  sendText(target: ChannelApprovalTarget, text: string): Promise<void>;
  /** Forward a decision to the desktop runtime. */
  respondApproval(response: DesktopToolApprovalResponse): Promise<unknown>;
  logger?: { error(...args: unknown[]): void };
}

export interface ChannelApprovalBridge {
  /** Mirror a tool-approval state change to the channel (idempotent). */
  handleToolApprovalState(tabId: string, state: DesktopToolApprovalState): void;
  /** Snapshot for `/pending`; null when nothing is waiting. */
  pendingApproval(): ChannelApprovalPrompt | null;
  /** Answer the active batch (`requestId` → single request 'allow'). */
  respondApproval(
    decision: ChannelApprovalDecision,
    requestId?: string,
  ): Promise<ChannelApprovalResult>;
}

interface ActiveApproval {
  tabId: string;
  batchId: string;
  sessionId: string | null;
  requests: ChannelApprovalRequest[];
}

export function createChannelApprovalBridge(
  deps: ChannelApprovalBridgeDeps,
): ChannelApprovalBridge {
  let active: ActiveApproval | null = null;

  const logError = (...args: unknown[]): void => {
    deps.logger?.error('[ChannelApprovalBridge]', ...args);
  };

  const toPrompt = (state: ActiveApproval): ChannelApprovalPrompt => ({
    batchId: state.batchId,
    sessionId: state.sessionId,
    requests: state.requests.map((request) => ({ ...request })),
  });

  const mapRequests = (batch: DesktopToolApprovalBatch): ChannelApprovalRequest[] =>
    batch.requests.map((request) => ({
      id: request.id,
      toolName: request.toolName,
      kind: request.kind,
      title: request.title,
      summary: request.summary,
    }));

  // A snapshot is only worth mirroring while it is still the active batch.
  const isStillActive = (snapshot: ActiveApproval): boolean =>
    active?.batchId === snapshot.batchId;

  const notify = async (snapshot: ActiveApproval): Promise<void> => {
    try {
      // Session id was captured synchronously when the batch was announced.
      const { sessionId } = snapshot;
      if (!sessionId) {
        return;
      }
      const targets = await deps.listTargets(sessionId);
      // Second guard: the batch may have been answered or superseded while the
      // target lookup was in flight — never fan out a stale prompt.
      if (!isStillActive(snapshot)) {
        return;
      }
      if (targets.length === 0) {
        return;
      }
      const prompt = toPrompt(snapshot);
      const text = [
        '⚠️ Pueblo 有一个正在等待审批的工具调用。',
        '',
        formatApprovalPrompt(prompt),
      ].join('\n');
      await Promise.all(
        targets.map((target) =>
          deps.sendText(target, text).catch((error) => logError('send failed:', error)),
        ),
      );
    } catch (error) {
      logError('notify failed:', error);
    }
  };

  return {
    handleToolApprovalState(tabId, state) {
      // Only the tab that owns the channel window has Feishu conversations
      // bound to it; other tabs are desktop-only.
      if (tabId !== deps.getChannelTabId()) {
        return;
      }
      if (!state.activeBatch) {
        active = null;
        return;
      }
      if (active?.batchId === state.activeBatch.id) {
        return;
      }
      const snapshot: ActiveApproval = {
        tabId,
        batchId: state.activeBatch.id,
        // Read synchronously so the prompt always targets the session that owns
        // this batch; an async lookup could resolve after a session switch.
        sessionId: deps.getActiveSessionId(tabId),
        requests: mapRequests(state.activeBatch),
      };
      active = snapshot;
      void notify(snapshot);
    },

    pendingApproval() {
      return active ? toPrompt(active) : null;
    },

    async respondApproval(decision, requestId) {
      if (!active) {
        return {
          ok: false,
          decision,
          affectedIds: [],
          message: '⚠️ 当前没有待审批的工具调用。',
        };
      }

      const snapshot = active;
      const allIds = snapshot.requests.map((request) => request.id);
      const selectedRequestIds =
        decision === 'allow' && requestId ? [requestId] : allIds;

      const response: DesktopToolApprovalResponse = {
        tabId: snapshot.tabId,
        batchId: snapshot.batchId,
        decision,
        selectedRequestIds,
      };

      await deps.respondApproval(response);
      if (active?.batchId === snapshot.batchId) {
        active = null;
      }

      const count = selectedRequestIds.length;
      const message =
        decision === 'deny'
          ? `⛔ 已驳回全部 ${count} 项待审批请求。`
          : decision === 'allow-all'
            ? `✅ 已通过全部 ${count} 项待审批请求。`
            : '✅ 已通过该工具调用（其余未选项一并被拒绝）。';

      return { ok: true, decision, affectedIds: selectedRequestIds, message };
    },
  };
}
