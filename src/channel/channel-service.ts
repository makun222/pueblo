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
  ChannelEventHandler,
  InboundMessage,
  OutboundMessage,
} from './channel-types';
import { ChannelRegistry } from './channel-registry';
import {
  recordChannelSession,
  resolveChannelSessionId,
} from './channel-config';
import { ChannelConnectionError } from './channel-errors';
import { perfLog } from '../utils/perf-logger';
import { channelDebugLog } from './channel-debug-log';
import { channelLogger } from '../utils/logger.js';

export interface ChannelServiceDependencies {
  readonly runtime: RuntimeCoordinator;
  readonly registry: ChannelRegistry;
  /** Create a new pueblo session for a fresh external conversation */
  readonly createSession: (channelId: string, message: InboundMessage) => Promise<string>;
}

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

  private async handleInbound(message: InboundMessage, config: ChannelConfig): Promise<void> {
    channelDebugLog(`[handleInbound] RECV channelId=${message.channelId} kind=${config.kind} senderId=${message.externalConversationId} text="${message.text?.slice(0, 80)}"`);

    let sessionId = await resolveChannelSessionId(message.channelId, message.externalConversationId);
    channelDebugLog(`[handleInbound] resolveSession: ${sessionId ?? 'null (will create new)'}`);

    if (!sessionId) {
      channelDebugLog(`[handleInbound] creating new session...`);
      sessionId = await this.deps.createSession(message.channelId, message);
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
