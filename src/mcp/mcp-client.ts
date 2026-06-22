// ---------------------------------------------------------------------------
// MCP Client — Singleton orchestrator for all MCP server connections
// ---------------------------------------------------------------------------

import type { McpServerConfig, McpConnectionState, McpToolDefinition } from './mcp-types';
import { McpConnection } from './mcp-connection';
import { loadConfig, upsertServerConfig, deleteServerConfig } from './mcp-config';
import { getApiKey } from './mcp-credentials';

// ─── Namespace ───────────────────────────────────────────────────────────

/** Prefix for MCP tools in the Pueblo tool registry */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Build a qualified tool name: mcp__<serverId>__<toolName> */
export function qualifyToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

/** Parse a qualified tool name back to serverId and toolName */
export function parseQualifiedToolName(qualifiedName: string): { serverId: string; toolName: string } | null {
  if (!qualifiedName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
  const sepIdx = rest.indexOf('__');
  if (sepIdx < 0) return null;
  return {
    serverId: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + 2),
  };
}

/** Check if a tool name is an MCP tool */
export function isMcpTool(qualifiedName: string): boolean {
  return qualifiedName.startsWith(MCP_TOOL_PREFIX);
}

// ─── Singleton ───────────────────────────────────────────────────────────

export class McpClientManager {
  private connections = new Map<string, { connection: McpConnection; state: McpConnectionState }>();
  private initialized = false;

  /** Initialize all enabled servers from config */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = await loadConfig();
    const enabledServers = config.servers.filter((s) => s.enabled);

    const results = await Promise.allSettled(
      enabledServers.map((serverConfig) => this.connectServer(serverConfig))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[MCP] Server initialization error:', result.reason);
      }
    }

    this.initialized = true;
  }

  /** Connect to a single MCP server */
  async connectServer(config: McpServerConfig): Promise<McpConnectionState> {
    // Check if already connected
    const existing = this.connections.get(config.id);
    if (existing && existing.state.status === 'connected') {
      return existing.state;
    }

    const state = McpConnection.createState(config);
    state.status = 'connecting';

    // Load API key once before retry loop
    if (config.apiKeyName) {
      const apiKey = await getApiKey(config.id);
      if (apiKey) {
        config.env = {
          ...config.env,
          [config.apiKeyName]: apiKey,
        };
      }
    }

    const maxRetries = 3;
    const baseDelayMs = 1000; // 1s

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const connection = new McpConnection();
      try {
        await connection.connect(config);
        // Discover tools
        const tools = await connection.listTools();
        state.tools = tools;
        state.status = 'connected';
        state.session = {};
        state.lastDiscoveredAt = Date.now();

        this.connections.set(config.id, { connection, state });
        return state;
      } catch (err) {
        connection.dispose();
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
          console.warn(
            `[MCP] Connection to "${config.id}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${errorMessage}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          state.status = 'error';
          state.lastError = `Connection failed after ${maxRetries + 1} attempts: ${errorMessage}`;
          console.error(
            `[MCP] Connection to "${config.id}" failed after ${maxRetries + 1} attempts: ${errorMessage}`,
          );
        }
      }
    }

    return state;
  }

  /** Disconnect a server */
  async disconnectServer(serverId: string): Promise<void> {
    const entry = this.connections.get(serverId);
    if (entry) {
      entry.state.status = 'disconnected';
      entry.connection.dispose();
      this.connections.delete(serverId);
    }
  }

  /** Get the connection state for a server */
  getState(serverId: string): McpConnectionState | null {
    return this.connections.get(serverId)?.state ?? null;
  }

  /** Get all connection states */
  getAllStates(): McpConnectionState[] {
    return Array.from(this.connections.values()).map((e) => e.state);
  }

  /** Get all discovered MCP tools across all servers */
  getAllTools(): Array<{ serverId: string; qualifiedName: string; definition: McpToolDefinition }> {
    const result: Array<{ serverId: string; qualifiedName: string; definition: McpToolDefinition }> = [];
    for (const [, entry] of this.connections) {
      if (entry.state.status !== 'connected') continue;
      for (const tool of entry.state.tools) {
        result.push({
          serverId: entry.state.serverId,
          qualifiedName: qualifyToolName(entry.state.serverId, tool.name),
          definition: tool,
        });
      }
    }
    return result;
  }

  /** Execute a tool on a connected MCP server */
  async executeTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = parseQualifiedToolName(qualifiedName);
    if (!parsed) {
      throw new Error(`Invalid MCP tool name: ${qualifiedName}`);
    }

    const entry = this.connections.get(parsed.serverId);
    if (!entry) {
      throw new Error(`MCP server "${parsed.serverId}" not connected`);
    }

    if (entry.state.status !== 'connected') {
      throw new Error(`MCP server "${parsed.serverId}" is not connected (status: ${entry.state.status})`);
    }

    return entry.connection.callTool(parsed.toolName, args);
  }

  /** Add a new server configuration and optionally connect it */
  async addServer(config: McpServerConfig, connectNow: boolean = false): Promise<void> {
    await upsertServerConfig(config);
    if (connectNow && config.enabled) {
      await this.connectServer(config);
    }
  }

  /** Remove a server configuration and disconnect */
  async removeServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    await deleteServerConfig(serverId);
  }

  /** Test a connection without persisting it */
  async testConnection(config: McpServerConfig): Promise<{ connected: boolean; toolsFound: number; error?: string }> {
    const maxRetries = 3;
    const baseDelayMs = 1000; // 1s
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const connection = new McpConnection();
      try {
        await connection.connect(config);
        const tools = await connection.listTools();
        connection.disconnect();
        return { connected: true, toolsFound: tools.length };
      } catch (err) {
        connection.dispose();
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
          console.warn(
            `[MCP] Test connection to "${config.id}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${lastError}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      connected: false,
      toolsFound: 0,
      error: `Connection failed after ${maxRetries + 1} attempts: ${lastError}`,
    };
  }

  /** Reinitialize (reload config and re-establish connections) */
  async reinitialize(): Promise<void> {
    // Disconnect all
    for (const [serverId] of this.connections) {
      await this.disconnectServer(serverId);
    }
    this.initialized = false;
    await this.initialize();
  }

  /** Disconnect all and restart with the given server configs (bypasses config file) */
  async restartServers(serverConfigs: McpServerConfig[]): Promise<void> {
    for (const [serverId] of this.connections) {
      await this.disconnectServer(serverId);
    }
    this.initialized = false;
    for (const config of serverConfigs) {
      if (config.enabled) {
        await this.connectServer(config);
      }
    }
    this.initialized = true;
  }
}

/** Singleton instance */
export const mcpClientManager = new McpClientManager();
