// ---------------------------------------------------------------------------
// MCP Types — Type definitions for Model Context Protocol integration
// ---------------------------------------------------------------------------

// ─── MCP Server Configuration ────────────────────────────────────────────

/** Describes a single MCP server entry (stored in mcp-servers.json) */
export interface McpServerConfig {
  /** Unique identifier for this server (e.g. "filesystem", "github") */
  id: string;
  /** Human-readable label shown in UI */
  name: string;
  /** Command to launch the server process (e.g. "npx", "node", "uvx") */
  command: string;
  /** Arguments passed to the command */
  args: string[];
  /** Environment variables injected into the child process */
  env?: Record<string, string>;
  /** Whether this server is enabled */
  enabled: boolean;
  /** Optional API key name used for credential lookup */
  apiKeyName?: string;
  /** Optional discovery source tag for UI grouping */
  source?: 'manual' | 'builtin' | 'local-scan';
}

/** Full persisted configuration shape */
export interface McpServersConfig {
  servers: McpServerConfig[];
}

// ─── Connection & Protocol Types ─────────────────────────────────────────

/** Runtime state of a single MCP server connection */
export interface McpConnectionState {
  serverId: string;
  config: McpServerConfig;
  /** Child process handle */
  process: import('child_process').ChildProcess | null;
  /** JSON-RPC transport session reference */
  session: unknown | null;
  /** Cached tool definitions discovered from this server */
  tools: McpToolDefinition[];
  /** Connection status */
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** Last error message */
  lastError: string | null;
  /** Timestamp of last successful tool discovery */
  lastDiscoveredAt: number | null;
}

/** Tool definition as returned by a MCP server's listTools */
export interface McpToolDefinition {
  /** Tool name as reported by the server */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool arguments */
  inputSchema: Record<string, unknown>;
}

/** Arguments passed to a MCP tool call */
export interface McpToolArgs {
  /** Tool name (within the server namespace) */
  toolName: string;
  /** Server identifier */
  serverId: string;
  /** Arguments for the tool */
  arguments: Record<string, unknown>;
}

/** Result from a tool execution */
export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

/** Content item within a tool result */
export interface McpToolContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  resource?: unknown;
}

// ─── IPC Types ───────────────────────────────────────────────────────────

/** IPC: List server configurations */
export interface McpIpcListServersRequest {
  type: 'list-servers';
}
export interface McpIpcListServersResponse {
  servers: McpConnectionState[];
}

/** IPC: Add or update a server configuration */
export interface McpIpcSaveServerRequest {
  type: 'save-server';
  config: McpServerConfig;
}
export interface McpIpcSaveServerResponse {
  success: boolean;
  error?: string;
}

/** IPC: Delete a server configuration */
export interface McpIpcDeleteServerRequest {
  type: 'delete-server';
  serverId: string;
}
export interface McpIpcDeleteServerResponse {
  success: boolean;
  error?: string;
}

/** IPC: Test a server connection */
export interface McpIpcTestConnectionRequest {
  type: 'test-connection';
  config: McpServerConfig;
}
export interface McpIpcTestConnectionResponse {
  connected: boolean;
  toolsFound: number;
  error?: string;
}

/** IPC: Set API key for a server */
export interface McpIpcSetApiKeyRequest {
  type: 'set-api-key';
  serverId: string;
  apiKey: string;
}
export interface McpIpcSetApiKeyResponse {
  success: boolean;
  error?: string;
}

/** IPC: Discover available servers */
export interface McpIpcDiscoverServersRequest {
  type: 'discover-servers';
}
export interface McpIpcDiscoverServersResponse {
  discovered: McpServerConfig[];
}

/** Union of all MCP IPC requests */
export type McpIpcRequest =
  | McpIpcListServersRequest
  | McpIpcSaveServerRequest
  | McpIpcDeleteServerRequest
  | McpIpcTestConnectionRequest
  | McpIpcSetApiKeyRequest
  | McpIpcDiscoverServersRequest;

/** Union of all MCP IPC responses */
export type McpIpcResponse =
  | McpIpcListServersResponse
  | McpIpcSaveServerResponse
  | McpIpcDeleteServerResponse
  | McpIpcTestConnectionResponse
  | McpIpcSetApiKeyResponse
  | McpIpcDiscoverServersResponse;

// ─── Provider Adapter Integration Types ──────────────────────────────────

/** A Pueblo-internal tool definition wrapping a MCP tool */
export interface McpProviderToolMeta {
  /** Server that owns this tool */
  serverId: string;
  /** Original tool name within MCP namespace */
  mcpToolName: string;
}

/** Mapping from qualified tool name → server tool metadata */
export interface McpToolRegistry {
  /** qualified name → server tool */
  [qualifiedName: string]: {
    serverId: string;
    definition: McpToolDefinition;
  };
}
