// ---------------------------------------------------------------------------
// MCP Connection — Child process lifecycle & stdio transport management
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { McpServerConfig, McpConnectionState, McpToolDefinition } from './mcp-types';
import {
  buildRequest,
  buildNotification,
  parseResponse,
  isResponse,
  parseListToolsResult,
  type JsonRpcResponse,
} from './mcp-protocol';

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const MAX_STARTUP_MS = 10_000;

// ─── Pending Request Map ─────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ─── MCP Connection ──────────────────────────────────────────────────────

export class McpConnection {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private pingInterval: NodeJS.Timeout | null = null;
  private _disposed = false;

  /** Create a state snapshot for the connection */
  static createState(config: McpServerConfig): McpConnectionState {
    return {
      serverId: config.id,
      config,
      process: null,
      session: null,
      tools: [],
      status: 'disconnected',
      lastError: null,
      lastDiscoveredAt: null,
    };
  }

  // ─── Connection Lifecycle ───────────────────────────────────────────────

  /** Start the child process and establish transport */
  async connect(config: McpServerConfig): Promise<void> {
    if (this._disposed) throw new Error('Connection already disposed');
    if (this.process) await this.disconnect();

    // Build environment with API key injections
    const env: Record<string, string> = { ...(config.env ?? {}) };
    // Copy parent process env selectively
    const parentEnv = process.env as Record<string, string | undefined>;
    for (const key of Object.keys(parentEnv)) {
      if (parentEnv[key] !== undefined && !(key in env)) {
        env[key] = parentEnv[key]!;
      }
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP server "${config.id}" startup timed out after ${MAX_STARTUP_MS}ms`));
      }, MAX_STARTUP_MS);

      try {
        const child = spawn(config.command, config.args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });

        this.process = child;

        // Handle stderr (log but don't treat as error)
        child.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) {
            console.debug(`[MCP:${config.id}] stderr:`, msg);
          }
        });

        // Set up readline for stdout
        this.readline = createInterface({ input: child.stdout! });
        this.readline.on('line', (line: string) => this.handleLine(line));

        // Handle process exit
        child.on('exit', (code) => {
          console.debug(`[MCP:${config.id}] process exited with code ${code}`);
          this.cleanup();
          // Reject all pending requests
          for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`MCP server "${config.id}" process exited with code ${code}`));
          }
          this.pending.clear();
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Failed to start MCP server "${config.id}": ${err.message}`));
        });

        // Send initialize request
        this.sendInitialize().then(() => {
          clearTimeout(timer);
          resolve();
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Disconnect cleanly */
  async disconnect(): Promise<void> {
    this.cleanup();
  }

  /** Full cleanup */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Already dead
      }
      this.process = null;
    }
  }

  /** Dispose permanently (cannot reconnect) */
  dispose(): void {
    this._disposed = true;
    this.cleanup();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection disposed'));
    }
    this.pending.clear();
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ─── Message Handling ──────────────────────────────────────────────────

  private handleLine(line: string): void {
    const msg = parseResponse(line);
    if (!msg) return;

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    }
    // Notifications are ignored for now
  }

  // ─── Request / Response ────────────────────────────────────────────────

  private async sendRequest(method: string, params?: unknown, timeout?: number): Promise<JsonRpcResponse> {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP connection not established');
    }

    const request = buildRequest(method, params);
    const actualTimeout = timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`MCP request "${method}" timed out after ${actualTimeout}ms`));
      }, actualTimeout);

      this.pending.set(request.id, { resolve, reject, timer });

      try {
        this.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(err);
      }
    });
  }

  // ─── MCP Initialization ────────────────────────────────────────────────

  private async sendInitialize(): Promise<void> {
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'pueblo',
        version: '1.0.0',
      },
    });

    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    // Send initialized notification
    this.sendNotification('notifications/initialized');
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const notification = buildNotification(method, params);
    try {
      this.process.stdin.write(JSON.stringify(notification) + '\n');
    } catch {
      // Best-effort notification
    }
  }

  // ─── Tool Discovery ────────────────────────────────────────────────────

  /** List all tools available from this server */
  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.sendRequest('tools/list');
    if (response.error) {
      throw new Error(`MCP tools/list failed: ${response.error.message}`);
    }
    return parseListToolsResult(response.result);
  }

  // ─── Tool Execution ────────────────────────────────────────────────────

  /** Execute a tool on this server */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    if (response.error) {
      throw new Error(`MCP tools/call "${name}" failed: ${response.error.message}`);
    }

    return response.result;
  }
}
