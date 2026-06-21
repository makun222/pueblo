// ---------------------------------------------------------------------------
// MCP Module — Barrel export
// ---------------------------------------------------------------------------

export * from './mcp-types';
export * from './mcp-protocol';
export { McpConnection } from './mcp-connection';
export * from './mcp-config';
export * from './mcp-credentials';
export {
  McpClientManager,
  mcpClientManager,
  qualifyToolName,
  parseQualifiedToolName,
  isMcpTool,
  MCP_TOOL_PREFIX,
} from './mcp-client';
