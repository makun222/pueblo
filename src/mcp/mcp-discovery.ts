// ---------------------------------------------------------------------------
// MCP Server Discovery — Scan local environment for MCP configurations
// ---------------------------------------------------------------------------

import type { McpServerConfig } from './mcp-types';

/**
 * Result of a local discovery scan.
 */
export interface DiscoveryResult {
  readonly hostConfigs: McpServerConfig[];
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Host config file locations
// These files are commonly used by MCP-aware editors/CLIs.
// ---------------------------------------------------------------------------

const HOST_CONFIG_PATTERNS: string[] = [
  // Claude Desktop
  '.claude.json',
  'claude_desktop_config.json',
  'Library/Application Support/Claude/claude_desktop_config.json',
  // Cline (VS Code extension)
  '.vscode/cline_mcp_config.json',
  // Continue.dev
  '.continue/config.json',
];

/**
 * Scans the user's home directory for MCP server configurations
 * from other compatible hosts (Claude Desktop, Cline, Continue, etc.).
 */
export async function scanHostConfigs(homeDir: string): Promise<DiscoveryResult> {
  const errors: string[] = [];
  const hostConfigs: McpServerConfig[] = [];
  const fs = await import('fs/promises');
  const path = await import('path');

  for (const pattern of HOST_CONFIG_PATTERNS) {
    const fullPath = path.join(homeDir, pattern);
    try {
      await fs.access(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Different hosts have different config schemas; extract MCP servers
      const servers = extractServersFromHostConfig(parsed, pattern);
      hostConfigs.push(...servers);
    } catch {
      // File doesn't exist or can't be parsed — skip silently
    }
  }

  // Remove duplicates by name
  const seen = new Set<string>();
  const unique: McpServerConfig[] = [];
  for (const cfg of hostConfigs) {
    if (!seen.has(cfg.name)) {
      seen.add(cfg.name);
      unique.push(cfg);
    }
  }

  return { hostConfigs: unique, errors };
}

/**
 * Extracts MCP server configs from a host configuration object.
 */
function extractServersFromHostConfig(
  config: Record<string, unknown>,
  source: string
): McpServerConfig[] {
  const result: McpServerConfig[] = [];

  // Claude Desktop format: { mcpServers: { name: { command, args, env } } }
  const claudeMcp = (config as Record<string, unknown>)['mcpServers'] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (claudeMcp) {
    for (const [name, cfg] of Object.entries(claudeMcp)) {
      if (typeof cfg === 'object' && cfg !== null) {
        result.push({
          id: name,
          name,
          enabled: true,
          command: String(cfg.command ?? ''),
          args: (cfg.args as string[]) ?? [],
          env: (cfg.env as Record<string, string>) ?? {},
          source: 'local-scan',
        });
      }
    }
    return result;
  }

  // Cline / Continue format: { tools: [...] } or { servers: [...] }
  const toolsOrServers = (config.tools ?? config.servers) as
    | Record<string, unknown>[]
    | undefined;
  if (Array.isArray(toolsOrServers)) {
    for (const tool of toolsOrServers) {
      if (typeof tool === 'object' && tool !== null && tool.name) {
        result.push({
          id: String(tool.name),
          name: String(tool.name),
          enabled: true,
          command: String(tool.command ?? '') || String((tool as any).cmd ?? ''),
          args: (tool.args as string[]) ?? [],
          env: (tool.env as Record<string, string>) ?? {},
          source: 'local-scan',
        });
      }
    }
  }

  return result;
}
