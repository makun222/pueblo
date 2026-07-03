// ---------------------------------------------------------------------------
// Channel Connection — LongConnectionBase abstract base over WebSocket.
// Mirrors McpConnection lifecycle (pending map / timeout / ping / dispose)
// but swaps child process stdio for a `ws` WebSocket transport.
// ---------------------------------------------------------------------------

import WebSocket from 'ws';
import type {
  ChannelConnectionState,
  ChannelConnectionStatus,
  ChannelKind,
} from './channel-types';

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const MAX_STARTUP_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 500;

// ─── Pending Request Map ─────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ─── LongConnectionBase ───────────────────────────────────────────────────

export interface LongConnectionOptions {
  channelId: string;
  kind: ChannelKind;
  /** Optional override for startup timeout (ms) */
  startupTimeoutMs?: number;
  /** Optional override for ping interval (ms) */
  pingIntervalMs?: number;
  /** Inject a WebSocket constructor for testing */
  webSocketCtor?: typeof WebSocket;
}

/**
 * Abstract base class for long-lived channel connections over WebSocket.
 *
 * Subclasses implement transport-specific concerns:
 *  - {@link buildUrl} / {@link buildHeaders}: where & how to connect
 *  - {@link startHandshake}: first-frame negotiation after open
 *  - {@link sendHeartbeat}: periodic keep-alive frame
 *  - {@link handleFrame}: per-frame event dispatch
 *  - {@link shouldReconnect}: whether a close should trigger reconnect
 */
export abstract class LongConnectionBase {
  protected readonly channelId: string;
  protected readonly kind: ChannelKind;
  protected readonly startupTimeoutMs: number;
  protected readonly pingIntervalMs: number;
  private readonly webSocketCtor: typeof WebSocket;

  private socket: WebSocket | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private _disposed = false;
  private closed = false;
  private connecting = false;

  /** Listener invoked when the connection status changes */
  protected onStatusChange?: (state: ChannelConnectionState) => void;
  /** Listener invoked when an error occurs that should surface to the service */
  protected onError?: (error: Error) => void;

  constructor(options: LongConnectionOptions) {
    this.channelId = options.channelId;
    this.kind = options.kind;
    this.startupTimeoutMs = options.startupTimeoutMs ?? MAX_STARTUP_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.webSocketCtor = options.webSocketCtor ?? WebSocket;
  }

  // ─── Abstract transport hooks ─────────────────────────────────────────

  /** Build the WebSocket URL to connect to (may be async if it requires a lookup) */
  protected abstract buildUrl(): Promise<string>;
  /** Optional headers to pass during the WebSocket handshake */
  protected buildHeaders(): Record<string, string> | undefined {
    return undefined;
  }
  /** First-frame handshake negotiation, resolves once the connection is ready */
  protected abstract startHandshake(): Promise<void>;
  /** Send a heartbeat frame to keep the connection alive */
  protected abstract sendHeartbeat(): void;
  /** Handle a single text frame received from the server */
  protected abstract handleFrame(data: string): void;
  /** Decide whether the given close code/reason should trigger a reconnect */
  protected shouldReconnect(_code: number | undefined, _reason: string | undefined): boolean {
    return true;
  }

  // ─── Public lifecycle ──────────────────────────────────────────────────

  get state(): ChannelConnectionState {
    return {
      channelId: this.channelId,
      kind: this.kind,
      status: this.resolveStatus(),
      lastError: null,
      connectedAt: null,
    };
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /** Open the WebSocket connection and complete the handshake */
  async connect(): Promise<void> {
    if (this._disposed) throw new Error(`Channel connection "${this.channelId}" already disposed`);
    if (this.socket) await this.disconnect();

    this.closed = false;
    this.connecting = true;
    this.publishStatus('connecting');

    await this.openSocket();
    try {
      await this.withStartupTimeout(() => this.startHandshake());
      this.connecting = false;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.startPing();
      this.publishStatus('connected');
    } catch (err) {
      this.connecting = false;
      this.socket?.close();
      this.socket = null;
      throw err;
    }
  }

  /** Cleanly close the WebSocket and stop timers (does not prevent reconnect) */
  async disconnect(): Promise<void> {
    this.stopPing();
    this.clearReconnectTimer();
    this.closed = true;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed
      }
      this.socket = null;
    }
    this.rejectPending(new Error(`Channel connection "${this.channelId}" disconnected`));
    this.publishStatus('disconnected');
  }

  /** Permanent teardown — cannot reconnect afterwards */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    void this.disconnect();
    this.rejectPending(new Error(`Channel connection "${this.channelId}" disposed`));
  }

  // ─── Frame send / request helpers ──────────────────────────────────────

  /** Send a raw string frame to the server */
  protected sendFrame(data: string): void {
    if (this.closed || !this.socket || this.socket.readyState !== this.webSocketCtor.OPEN) {
      throw new Error(`Channel connection "${this.channelId}" is not open`);
    }
    this.socket.send(data);
  }

  /** Send a frame and track a pending response keyed by id with a timeout */
  protected sendRequest(id: string | number, payload: string, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.socket || this.socket.readyState !== this.webSocketCtor.OPEN) {
      return Promise.reject(new Error(`Channel connection "${this.channelId}" is not open`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Channel request id=${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Resolve a pending request by id (called from handleFrame) */
  protected resolvePending(id: string | number, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(value);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async openSocket(): Promise<void> {
    const url = await this.buildUrl();
    const socket = new this.webSocketCtor(url, {
      headers: this.buildHeaders(),
    });
    this.socket = socket;

    socket.on('message', (data: WebSocket.RawData) => {
      const text = typeof data === 'string' ? data : data.toString();
      this.handleFrame(text);
    });

    socket.on('close', (code: number | undefined, reason: Buffer | string) => {
      const reasonText = Buffer.isBuffer(reason) ? reason.toString() : reason;
      this.stopPing();
      this.rejectPending(new Error(`WebSocket closed code=${code} reason=${reasonText}`));
      this.socket = null;
      this.publishStatus('disconnected');
      if (!this._disposed && !this.closed && this.shouldReconnect(code, reasonText)) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err: Error) => {
      this.onError?.(err);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.off('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        socket.off('error', onError);
        resolve();
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
  }

  private withStartupTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Channel "${this.channelId}" startup timed out after ${this.startupTimeoutMs}ms`));
      }, this.startupTimeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.sendHeartbeat();
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = this.reconnectDelay + Math.floor(Math.random() * RECONNECT_JITTER_MS);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.publishStatus('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._disposed || this.closed) return;
      this.connect().catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resolveStatus(): ChannelConnectionStatus {
    if (this._disposed) return 'disconnected';
    if (this.socket && this.socket.readyState === this.webSocketCtor.OPEN) return 'connected';
    if (this.connecting) return 'connecting';
    return this.closed ? 'disconnected' : 'disconnected';
  }

  private publishStatus(status: ChannelConnectionStatus): void {
    this.onStatusChange?.({
      channelId: this.channelId,
      kind: this.kind,
      status,
      lastError: null,
      connectedAt: status === 'connected' ? Date.now() : null,
    });
  }
}
