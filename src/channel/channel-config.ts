// ---------------------------------------------------------------------------
// Channel Config — Persistence of channel configurations + session mappings
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type {
  ChannelConfig,
  ChannelsConfig,
  ChannelSessionsStore,
  ChannelSessionMapping,
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

export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  const configPath = getChannelsConfigPath();
  try {
    const data = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(data) as Partial<ChannelsConfig>;
    return {
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
    };
  } catch {
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
  const mapping: ChannelSessionMapping = {
    key,
    channelId,
    externalConversationId,
    sessionId,
    createdAt: Date.now(),
  };
  if (idx >= 0) {
    store.sessions[idx] = { ...store.sessions[idx], sessionId };
  } else {
    store.sessions.push(mapping);
  }
  await saveChannelSessions(store);
}
