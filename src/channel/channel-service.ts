// ---------------------------------------------------------------------------
// Channel Service — Multi-channel lifecycle orchestration.
//
// Inbound: adapter.onMessage → resolve/create pueblo session → submitInput
// Outbound: await submitInput result → extract outputSummary → adapter.send
// ---------------------------------------------------------------------------

import type { RuntimeCoordinator } from '../app/runtime';
import type { CommandResult } from '../shared/result';
import { extractTaskOutputSummaryText } from '../shared/result';
import type { IpcInputEnvelope } from '../shared/schema';
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelConnectionState,
  ChannelControl,
  ChannelEventHandler,
  ChannelSessionMapping,
  InboundMessage,
  OutboundMessage,
} from './channel-types';
import { ChannelRegistry } from './channel-registry';
import {
  clearChannelBinding,
  recordChannelSelection,
  recordChannelSession,
  resolveChannelBinding,
} from './channel-config';
import { parseChannelCommand, runChannelCommand } from './channel-command-router';
import { ChannelConnectionError } from './channel-errors';
import { perfLog } from '../utils/perf-logger';
import { channelDebugLog } from './channel-debug-log';
import { channelLogger } from '../utils/logger.js';

export interface ChannelServiceDependencies {
  readonly runtime: RuntimeCoordinator;
  readonly registry: ChannelRegistry;
  /** Create a new pueblo session for a fresh external conversation */
  readonly createSession: (channelId: string, message: InboundMessage) => Promise<string>;
  /**
   * Host control surface for "/" commands (agent/session selection, status).
   * Optional: without it channels behave as pure pass-through (legacy).
   */
  readonly control?: ChannelControl;
}

/**
 * Commands allowed while the CLI runtime is busy — they do NOT preempt the
 * running turn: read-only views, plus tool-approval responses (which the busy
 * runtime is actively waiting for). Mutating selection commands and plain text
 * are still blocked (no preemption).
 */
const READ_ONLY_CHANNEL_COMMANDS = new Set([
  'help',
  'agents',
  'sessions',
  'status',
  'current',
  'pending',
  'approve',
  'approve-all',
  'deny',
]);

interface ActiveChannel {
  config: ChannelConfig;
  adapter: ChannelAdapter;
}

function buildChannelWindowId(channelId: string, kind: string): string {
  return `channel:${kind}:${channelId}`;
}

export class ChannelService {
  private readonly active = new Map<string, ActiveChannel>();
  private readonly handlers = new Map<string, ChannelEventHandler>();
  private disposed = false;

  constructor(private readonly deps: ChannelServiceDependencies) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Start all enabled channel configs; individual failures do not abort the batch */
  async start(configs: ChannelConfig[]): Promise<void> {
    channelDebugLog(`ChannelService.start: ${configs.filter(c => c.enabled).length}/${configs.length} enabled channels`);
    for (const config of configs) {
      if (!config.enabled) {
        channelDebugLog(`ChannelService.start: SKIP id=${config.id} (disabled)`);
        continue;
      }
      if (this.active.has(config.id)) {
        channelDebugLog(`ChannelService.start: SKIP id=${config.id} (already active)`);
        continue;
      }
      try {
        await this.startChannel(config);
        channelDebugLog(`ChannelService.start: OK id=${config.id} kind=${config.kind}`);
      } catch (err) {
        channelDebugLog(`ChannelService.start: FAIL id=${config.id} kind=${config.kind} err=${String(err)}`);
        channelLogger.error(`Failed to start "${config.id}":`, err);
      }
    }
  }

  /** Start (or restart) a single channel by config */
  async startChannel(config: ChannelConfig): Promise<void> {
    channelDebugLog(`startChannel: BEGIN id=${config.id} kind=${config.kind}`);
    if (this.disposed) throw new ChannelConnectionError(config.id, 'service disposed');
    const existing = this.active.get(config.id);
    if (existing) {
      channelDebugLog(`startChannel: id=${config.id} reconnecting (existing adapter found)`);
      await existing.adapter.disconnect();
    }
    const adapter = this.deps.registry.getAdapter(config);
    if (!adapter) {
      channelDebugLog(`startChannel: FAIL id=${config.id} kind=${config.kind} — no adapter in registry`);
      throw new ChannelConnectionError(config.id, `No adapter for kind "${config.kind}"`);
    }
    channelDebugLog(`startChannel: adapter obtained for id=${config.id}, calling connect…`);
    perfLog(`[Channel:${config.id}] connecting...`, 0);
    const handler: ChannelEventHandler = {
      onMessage: (message) => {
        void this.handleInbound(message, config);
      },
      onError: (error) => channelLogger.error(`[${config.id}] error:`, error),
      onStatusChange: (state) => channelLogger.debug(`[${config.id}] status=${state.status}`),
    };
    this.active.set(config.id, { config, adapter });
    this.handlers.set(config.id, handler);
    await adapter.connect(config, handler);
    channelDebugLog(`startChannel: OK id=${config.id} connected and active`);
  }

  async stopChannel(channelId: string): Promise<boolean> {
    const active = this.active.get(channelId);
    if (!active) return false;
    try {
      await active.adapter.disconnect();
    } finally {
      active.adapter.dispose();
      this.active.delete(channelId);
      this.handlers.delete(channelId);
    }
    return true;
  }

  async stop(): Promise<void> {
    const ids = [...this.active.keys()];
    for (const id of ids) {
      await this.stopChannel(id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
  }

  getStatus(): ChannelConnectionState[] {
    return [...this.active.values()].map((a) => a.adapter.state);
  }

  getChannel(channelId: string): ActiveChannel | undefined {
    return this.active.get(channelId);
  }

  /** Send an outbound message through a running channel's adapter */
  async send(channelId: string, message: OutboundMessage): Promise<void> {
    const active = this.active.get(channelId);
    if (!active) throw new ChannelConnectionError(channelId, 'channel not started');
    await active.adapter.send(message);
  }

  // ─── Inbound → submitInput → outbound reply ───────────────────────────

  /** Public so adapters (and tests) can drive the inbound pipeline directly. */
  async handleInbound(message: InboundMessage, config: ChannelConfig): Promise<void> {
    channelDebugLog(`[handleInbound] RECV channelId=${message.channelId} kind=${config.kind} senderId=${message.externalConversationId} text="${message.text?.slice(0, 80)}"`);

    // Refresh the host snapshot first so busy/binding reflect the latest state.
    // Best-effort: a refresh failure must not drop the inbound message.
    try {
      await this.deps.control?.refresh?.();
    } catch (err) {
      channelLogger.warn(`[handleInbound] control.refresh() failed (continuing):`, err);
    }

    const binding = await resolveChannelBinding(message.channelId, message.externalConversationId);
    const busy = this.deps.control?.isRuntimeBusy?.() ?? false;

    // "/" control commands operate the CLI runtime selection without the LLM.
    const commandInvocation = this.deps.control ? parseChannelCommand(message.text ?? '') : null;
    if (commandInvocation && this.deps.control) {
      const readOnly = READ_ONLY_CHANNEL_COMMANDS.has(commandInvocation.command);
      if (busy && !readOnly) {
        await this.safeReply(
          message.channelId,
          message.externalConversationId,
          '⏸️ CLI 正在执行任务，channel 不能抢占。请稍后重试，或用 /status 查看进度。',
        );
        return;
      }
      const outcome = await runChannelCommand(commandInvocation, this.deps.control, { binding });
      if (outcome.handled) {
        if (outcome.reset) {
          await clearChannelBinding(message.channelId, message.externalConversationId);
        } else if (outcome.selection) {
          await recordChannelSelection(message.channelId, message.externalConversationId, outcome.selection);
        }
        if (outcome.reply) {
          await this.safeReply(message.channelId, message.externalConversationId, outcome.reply);
        }
        return;
      }
    }

    // Plain text is a task input for the CLI runtime — never preempt a CLI turn.
    if (busy) {
      channelDebugLog('[handleInbound] runtime busy (CLI turn in progress) → dropping channel input');
      await this.safeReply(
        message.channelId,
        message.externalConversationId,
        '⏸️ CLI 正在执行任务，飞书消息已丢弃（暂不排队）。可发 /status 查看进度。',
      );
      return;
    }

    let sessionId = binding?.selectedSessionId ?? binding?.sessionId ?? null;
    channelDebugLog(`[handleInbound] resolveSession: ${sessionId ?? 'null (will create new)'}`);

    if (!sessionId) {
      channelDebugLog(`[handleInbound] creating new session...`);
      sessionId = await this.createSessionForConversation(message, binding);
      channelDebugLog(`[handleInbound] new sessionId=${sessionId}`);
      await recordChannelSession(message.channelId, message.externalConversationId, sessionId);
    }

    const requestId = `${new Date().toISOString()}-${Math.random().toString(16).slice(2)}`;
    const envelope: IpcInputEnvelope = {
      requestId,
      windowId: buildChannelWindowId(message.channelId, config.kind),
      sessionId,
      inputText: message.text,
      attachments: [],
      submittedAt: new Date().toISOString(),
    };

    try {
      channelDebugLog(`[handleInbound] submitInput sessionId=${sessionId} text="${message.text?.slice(0, 80)}"`);
      const result = await this.deps.runtime.submitInput(envelope);
      channelDebugLog(`[handleInbound] submitInput OK, status=${result?.code ?? 'unknown'}`);
      const replyText = extractReplyText(result);
      channelDebugLog(`[handleInbound] replyText=${replyText ? '"' + replyText.slice(0, 80) + '"' : 'null'}`);
      if (replyText) {
        await this.safeReply(message.channelId, message.externalConversationId, replyText);
        channelDebugLog(`[handleInbound] safeReply sent OK`);
      }
    } catch (err) {
      channelDebugLog(`[handleInbound] ERROR: ${err instanceof Error ? err.message : String(err)}`);
      channelLogger.error(`[${message.channelId}] submitInput failed:`, err);
      await this.safeReply(
        message.channelId,
        message.externalConversationId,
        err instanceof Error ? err.message : 'Internal error',
      );
    }
  }

  /**
   * Create a session for a fresh conversation. When a channel-side agent is
   * bound (原则 2：飞书只是窗口), create it under that agent instance so the
   * conversation continues in the agent the user selected.
   */
  private async createSessionForConversation(
    message: InboundMessage,
    binding: ChannelSessionMapping | null,
  ): Promise<string> {
    const agentInstanceId = binding?.agentInstanceId ?? null;
    if (this.deps.control && agentInstanceId) {
      const title = message.text ? `Channel: ${message.text.slice(0, 40)}` : 'Channel session';
      const session = await this.deps.control.createSession(title, agentInstanceId);
      return session.id;
    }
    return this.deps.createSession(message.channelId, message);
  }

  private async safeReply(channelId: string, externalConversationId: string, text: string): Promise<void> {
    if (!text || !text.trim()) return;
    try {
      await this.send(channelId, { externalConversationId, text });
    } catch (err) {
      channelLogger.error(`[${channelId}] reply failed:`, err);
    }
  }
}

/** Extract a plain-text reply from a CommandResult returned by submitInput */
export function extractReplyText(result: CommandResult<unknown>): string | null {
  if (!result) return null;
  if (!result.ok) {
    return result.message || null;
  }
  const data = result.data;
  if (data && typeof data === 'object' && 'outputSummary' in data) {
    const outputSummary = (data as { outputSummary?: unknown }).outputSummary;
    if (typeof outputSummary === 'string') {
      const text = extractTaskOutputSummaryText(outputSummary);
      if (text) return text;
    }
  }
  return result.message || null;
}
