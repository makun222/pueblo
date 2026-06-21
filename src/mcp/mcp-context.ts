import type { McpServerConfig } from './mcp-types';
import type { McpClientManager } from './mcp-client';

/**
 * MCP tool representation that can be injected into the agent's available tools list.
 */
export interface McpToolDefinition {
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Builds a flat list of MCP tool definitions from all connected MCP servers.
 */
export function buildMcpToolDefinitions(
  servers: McpServerConfig[],
  client: McpClientManager
): McpToolDefinition[] {
  const definitions: McpToolDefinition[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    try {
      const state = client.getState(server.name);
      if (!state || state.status !== 'connected' || !state.tools) continue;

      for (const tool of state.tools) {
        definitions.push({
          serverName: server.name,
          toolName: tool.name,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // Skip servers that fail to respond; agent will work without them
    }
  }

  return definitions;
}

/**
 * Converts an MCP tool definition into a tool descriptor compatible with
 * the agent's available tools list.
 */
export function toAgentToolDescriptor(def: McpToolDefinition): Record<string, unknown> {
  return {
    name: `mcp__${def.serverName}__${def.toolName}`,
    description: def.description,
    parameters: def.inputSchema,
  };
}
