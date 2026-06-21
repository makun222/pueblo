// ---------------------------------------------------------------------------
// MCP Protocol — JSON-RPC message construction & parsing for MCP
// ---------------------------------------------------------------------------

import type {
  McpToolDefinition,
  McpToolArgs,
  McpToolResult,
  McpToolContent,
} from './mcp-types';

// ─── JSON-RPC Message Shapes ─────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ─── MCP Methods ─────────────────────────────────────────────────────────

export const MCP_METHODS = {
  INITIALIZE: 'initialize',
  LIST_TOOLS: 'tools/list',
  CALL_TOOL: 'tools/call',
  LIST_RESOURCES: 'resources/list',
  READ_RESOURCE: 'resources/read',
  PING: 'ping',
  NOTIFICATION_INITIALIZED: 'notifications/initialized',
} as const;

// ─── Initialize / Capabilities ───────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    logging?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// ─── List Tools ──────────────────────────────────────────────────────────

export interface ListToolsResult {
  tools: McpToolDefinition[];
}

// ─── Call Tool ───────────────────────────────────────────────────────────

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// ─── Message Builders ────────────────────────────────────────────────────

let _nextId = 1;
let _idLock = false;

function nextId(): number {
  return _nextId++;
}

/** Build a JSON-RPC request */
export function buildRequest(method: string, params?: unknown): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params,
  };
}

/** Build a JSON-RPC notification (no id) */
export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/** Parse a JSON-RPC response line */
export function parseResponse(line: string): JsonRpcResponse | JsonRpcNotification | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    if (parsed.jsonrpc !== '2.0') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Check if a parsed message is a response (has id) */
export function isResponse(msg: JsonRpcResponse | JsonRpcNotification): msg is JsonRpcResponse {
  return 'id' in msg;
}

// ─── Result Parsers ──────────────────────────────────────────────────────

/** Parse a tools/list result from JSON-RPC response */
export function parseListToolsResult(result: unknown): McpToolDefinition[] {
  const r = result as ListToolsResult;
  if (!r || !Array.isArray(r.tools)) return [];
  return r.tools.map((t) => ({
    name: String(t.name ?? ''),
    description: String(t.description ?? ''),
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
  }));
}

/** Parse a tools/call result from JSON-RPC response */
export function parseCallToolResult(result: unknown): McpToolResult {
  const r = result as McpToolResult;
  const content: McpToolContent[] = Array.isArray(r?.content) ? r.content : [];
  return {
    content: content.map((c) => ({
      type: (c.type as 'text' | 'image' | 'resource') || 'text',
      text: c.text,
      mimeType: c.mimeType,
      data: c.data,
      uri: c.uri,
    })),
    isError: !!r?.isError,
  };
}
