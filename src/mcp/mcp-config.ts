// ---------------------------------------------------------------------------
// MCP Config — Persistence of MCP server configurations
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { McpServerConfig, McpServersConfig } from './mcp-types';

// ─── Path Helpers ────────────────────────────────────────────────────────

/** Get the .pueblo directory under the current working directory for config storage */
function getConfigDir(): string {
  return join(process.cwd(), '.pueblo');
}

/** Full path to the MCP servers config file */
function getConfigPath(): string {
  return join(getConfigDir(), 'mcp-servers.json');
}

// ─── Read / Write ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: McpServersConfig = { servers: [] };

/** Load MCP server configurations from disk */
export async function loadConfig(): Promise<McpServersConfig> {
  const configPath = getConfigPath();
  try {
    const data = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(data) as McpServersConfig;
    return {
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Save MCP server configurations to disk */
export async function saveConfig(config: McpServersConfig): Promise<void> {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }
  await writeFile(configPath, JSON.stringify({ servers: config.servers }, null, 2), 'utf-8');
}

/** Get a single server config by id */
export async function getServerConfig(serverId: string): Promise<McpServerConfig | null> {
  const config = await loadConfig();
  return config.servers.find((s) => s.id === serverId) ?? null;
}

/** Add or update a server configuration */
export async function upsertServerConfig(config: McpServerConfig): Promise<void> {
  const current = await loadConfig();
  const idx = current.servers.findIndex((s) => s.id === config.id);
  if (idx >= 0) {
    current.servers[idx] = config;
  } else {
    current.servers.push(config);
  }
  await saveConfig(current);
}

/** Delete a server configuration */
export async function deleteServerConfig(serverId: string): Promise<boolean> {
  const current = await loadConfig();
  const idx = current.servers.findIndex((s) => s.id === serverId);
  if (idx < 0) return false;
  current.servers.splice(idx, 1);
  await saveConfig(current);
  return true;
}
