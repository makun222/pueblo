// ---------------------------------------------------------------------------
// Channel Config — Persistence of channel configurations + session mappings
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { channelDebugLog } from './channel-debug-log';
import type {
  ChannelConfig,
  ChannelKind,
  ChannelsConfig,
  ChannelSessionsStore,
  ChannelSessionMapping,
  ChannelTransport,
} from './channel-types';

// ─── Path Helpers ────────────────────────────────────────────────────────

function getConfigDir(): string {
  return join(process.cwd(), '.pueblo');
}

function getChannelsConfigPath(): string {
  return join(getConfigDir(), 'channels.json');
}

function getSessionsConfigPath(): string {
  return join(getConfigDir(), 'channel-sessions.json');
}

// ─── Channel Config Read / Write ─────────────────────────────────────────

const DEFAULT_CHANNELS_CONFIG: ChannelsConfig = { channels: [] };

// ─── Channel Config Normalization ─────────────────────────────────────────

/** Option keys historically placed at the top level of a channel entry. */
const LEGACY_OPTION_KEYS = [
  'appId',
  'appSecret',
  'encryptKey',
  'verificationToken',
  'endpoint',
  'endpointUrl',
  'imApiBaseUrl',
] as const;

const VALID_TRANSPORTS = new Set<ChannelTransport>(['long-connection', 'webhook']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize one raw channel entry into the canonical `ChannelConfig`. Tolerates
 * legacy / hand-written shapes:
 * - `type` instead of `kind`
 * - kind-specific keys (appId / appSecret / endpoint …) at top level instead of `options`
 * - `credential` instead of `credentialTarget`
 * - omitted `name` / `enabled` / `transport`
 * Returns null when the entry has no usable id or kind, so it can be skipped.
 */
export function normalizeChannelEntry(raw: unknown): ChannelConfig | null {
  if (!isPlainObject(raw)) return null;

  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
  const kind =
    (typeof raw.kind === 'string' && raw.kind) ||
    (typeof raw.type === 'string' && raw.type) ||
    null;
  if (!id || !kind) return null;

  const options: Record<string, unknown> = isPlainObject(raw.options) ? { ...raw.options } : {};
  for (const key of LEGACY_OPTION_KEYS) {
    if (options[key] === undefined && raw[key] !== undefined) {
      options[key] = raw[key];
    }
  }
  // The feishu option is `endpointUrl`; tolerate the legacy `endpoint` name.
  if (options.endpointUrl === undefined && typeof options.endpoint === 'string') {
    options.endpointUrl = options.endpoint;
  }
  delete options.endpoint;

  const transport =
    typeof raw.transport === 'string' && VALID_TRANSPORTS.has(raw.transport as ChannelTransport)
      ? (raw.transport as ChannelTransport)
      : 'long-connection';

  const credentialTarget =
    typeof raw.credentialTarget === 'string'
      ? raw.credentialTarget
      : typeof raw.credential === 'string'
        ? raw.credential
        : undefined;

  return {
    id,
    kind: kind as ChannelKind,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    transport,
    options,
    ...(credentialTarget ? { credentialTarget } : {}),
    source: raw.source === 'builtin' ? 'builtin' : 'manual',
  };
}

export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  const configPath = getChannelsConfigPath();
  channelDebugLog(`loadChannelsConfig: path=${configPath}, exists=${existsSync(configPath)}`);
  try {
    const data = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(data);
    // Accept both { channels: [...] } and a bare top-level array.
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : isPlainObject(parsed) && Array.isArray(parsed.channels)
        ? (parsed.channels as unknown[])
        : [];

    // Legacy / hand-written configs may nest arrays; flatten before normalizing.
    const channels: ChannelConfig[] = [];
    for (const entry of rawList.flat(Infinity)) {
      const normalized = normalizeChannelEntry(entry);
      if (normalized) {
        channels.push(normalized);
      } else {
        channelDebugLog('loadChannelsConfig: skipping unusable channel entry (missing id/kind)');
      }
    }
    for (const ch of channels) {
      channelDebugLog(`loadChannelsConfig: channel id=${ch.id} kind=${ch.kind} enabled=${ch.enabled}`);
    }
    channelDebugLog(`loadChannelsConfig: loaded ${channels.length} channel(s)`);
    return { channels };
  } catch (err) {
    channelDebugLog(`loadChannelsConfig: ERROR ${String(err)}`);
    return DEFAULT_CHANNELS_CONFIG;
  }
}

export async function saveChannelsConfig(config: ChannelsConfig): Promise<void> {
  const configPath = getChannelsConfigPath();
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }
  await writeFile(configPath, JSON.stringify({ channels: config.channels }, null, 2), 'utf-8');
}

export async function getChannelConfig(channelId: string): Promise<ChannelConfig | null> {
  const config = await loadChannelsConfig();
  return config.channels.find((c) => c.id === channelId) ?? null;
}

export async function upsertChannelConfig(config: ChannelConfig): Promise<void> {
  const current = await loadChannelsConfig();
  const idx = current.channels.findIndex((c) => c.id === config.id);
  if (idx >= 0) {
    current.channels[idx] = config;
  } else {
    current.channels.push(config);
  }
  await saveChannelsConfig(current);
}

export async function deleteChannelConfig(channelId: string): Promise<boolean> {
  const current = await loadChannelsConfig();
  const idx = current.channels.findIndex((c) => c.id === channelId);
  if (idx < 0) return false;
  current.channels.splice(idx, 1);
  await saveChannelsConfig(current);
  return true;
}

// ─── Session Mapping Read / Write ─────────────────────────────────────────

const DEFAULT_SESSIONS_STORE: ChannelSessionsStore = { sessions: [] };

export async function loadChannelSessions(): Promise<ChannelSessionsStore> {
  const sessionsPath = getSessionsConfigPath();
  try {
    const data = await readFile(sessionsPath, 'utf-8');
    const parsed = JSON.parse(data) as Partial<ChannelSessionsStore>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return DEFAULT_SESSIONS_STORE;
  }
}

export async function saveChannelSessions(store: ChannelSessionsStore): Promise<void> {
  const sessionsPath = getSessionsConfigPath();
  const sessionsDir = dirname(sessionsPath);
  if (!existsSync(sessionsDir)) {
    await mkdir(sessionsDir, { recursive: true });
  }
  await writeFile(sessionsPath, JSON.stringify({ sessions: store.sessions }, null, 2), 'utf-8');
}

/** Composite key for a channel + external conversation mapping */
export function buildSessionMappingKey(channelId: string, externalConversationId: string): string {
  return `${channelId}::${externalConversationId}`;
}

/** Look up an existing pueblo session id for a channel conversation, returns null if none */
export async function resolveChannelSessionId(
  channelId: string,
  externalConversationId: string,
): Promise<string | null> {
  const store = await loadChannelSessions();
  const key = buildSessionMappingKey(channelId, externalConversationId);
  return store.sessions.find((s) => s.key === key)?.sessionId ?? null;
}

/** Create or update the mapping for a channel conversation */
export async function recordChannelSession(
  channelId: string,
  externalConversationId: string,
  sessionId: string,
): Promise<void> {
  const store = await loadChannelSessions();
  const key = buildSessionMappingKey(channelId, externalConversationId);
  const idx = store.sessions.findIndex((s) => s.key === key);
  const now = Date.now();
  if (idx >= 0) {
    // Preserve channel-side selection when only the owning session changes.
    const existing = store.sessions[idx];
    store.sessions[idx] = {
      ...existing,
      sessionId,
      selectedSessionId: existing.selectedSessionId ?? sessionId,
      updatedAt: now,
    };
  } else {
    const mapping: ChannelSessionMapping = {
      key,
      channelId,
      externalConversationId,
      sessionId,
      agentInstanceId: null,
      selectedSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
    };
    store.sessions.push(mapping);
  }
  await saveChannelSessions(store);
}

/** Full binding (owning session + channel-side selection) for a conversation */
export async function resolveChannelBinding(
  channelId: string,
  externalConversationId: string,
): Promise<ChannelSessionMapping | null> {
  const store = await loadChannelSessions();
  const key = buildSessionMappingKey(channelId, externalConversationId);
  return store.sessions.find((s) => s.key === key) ?? null;
}

/**
 * Update the channel-side selection (agent instance / current session) without
 * touching the owning sessionId. Creates the mapping when absent so an agent
 * can be chosen before any session exists.
 */
export async function recordChannelSelection(
  channelId: string,
  externalConversationId: string,
  selection: { agentInstanceId?: string | null; selectedSessionId?: string | null },
): Promise<void> {
  const store = await loadChannelSessions();
  const key = buildSessionMappingKey(channelId, externalConversationId);
  const idx = store.sessions.findIndex((s) => s.key === key);
  const now = Date.now();
  if (idx >= 0) {
    store.sessions[idx] = { ...store.sessions[idx], ...selection, updatedAt: now };
  } else {
    store.sessions.push({
      key,
      channelId,
      externalConversationId,
      sessionId: selection.selectedSessionId ?? '',
      agentInstanceId: selection.agentInstanceId ?? null,
      selectedSessionId: selection.selectedSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
  await saveChannelSessions(store);
}

/** Remove a conversation binding entirely (used by /reset). */
export async function clearChannelBinding(
  channelId: string,
  externalConversationId: string,
): Promise<void> {
  const store = await loadChannelSessions();
  const key = buildSessionMappingKey(channelId, externalConversationId);
  const next = store.sessions.filter((s) => s.key !== key);
  if (next.length !== store.sessions.length) {
    await saveChannelSessions({ sessions: next });
  }
}

/**
 * Every conversation bound to a pueblo session. Matches both the owning
 * `sessionId` and the channel-side `selectedSessionId`, so an approval request
 * fans out to all terminals (Feishu conversations) sharing that session.
 */
export async function listChannelBindingsBySession(
  sessionId: string,
): Promise<ChannelSessionMapping[]> {
  if (!sessionId) {
    return [];
  }
  const store = await loadChannelSessions();
  return store.sessions.filter(
    (s) => s.sessionId === sessionId || s.selectedSessionId === sessionId,
  );
}
