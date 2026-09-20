import { describe, it, expect, vi, afterEach } from 'vitest';
import { LongConnectionBase, type LongConnectionOptions } from '../../../src/channel/channel-connection';

// ---------------------------------------------------------------------------
// Fake WebSocket — satisfies the subset of the `ws` API the base class uses.
// ---------------------------------------------------------------------------
type Handler = (...args: any[]) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static latest: FakeWebSocket | null = null;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  closeCalled = false;
  private listeners = new Map<string, Set<Handler>>();

  constructor(url: string, _options?: unknown) {
    this.url = url;
    FakeWebSocket.latest = this;
  }

  on(event: string, handler: Handler): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  once(event: string, handler: Handler): this {
    const wrapped: Handler = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, handler: Handler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  send(_data: unknown): void {
    /* no-op */
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000, 'normal');
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(...args);
  }

  // ---- test drivers ----
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  message(data: string): void {
    this.emit('message', data);
  }

  error(err: Error): void {
    this.emit('error', err);
  }

  serverClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, reason);
  }
}

// ---------------------------------------------------------------------------
// Concrete connection under test
// ---------------------------------------------------------------------------
class TestConnection extends LongConnectionBase {
  handshakeCalls = 0;
  heartbeatCalls = 0;
  frames: string[] = [];
  hangHandshake = false;
  reconnectPolicy: (code?: number) => boolean = () => true;

  constructor(over: Partial<LongConnectionOptions> = {}) {
    super({
      channelId: 'test-channel',
      kind: 'feishu',
      webSocketCtor: FakeWebSocket as never,
      startupTimeoutMs: 50,
      pingIntervalMs: 1000,
      ...over,
    });
  }

  protected buildUrl(): Promise<string> {
    return Promise.resolve('ws://localhost/test');
  }

  protected startHandshake(): Promise<void> {
    this.handshakeCalls++;
    return this.hangHandshake ? new Promise<void>(() => undefined) : Promise.resolve();
  }

  protected sendHeartbeat(): void {
    this.heartbeatCalls++;
  }

  protected handleFrame(data: string): void {
    this.frames.push(data);
  }

  protected shouldReconnect(code?: number): boolean {
    return this.reconnectPolicy(code);
  }

  setErrorHandler(handler: (err: Error) => void): void {
    this.onError = handler;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function bringUp(conn: TestConnection): Promise<FakeWebSocket> {
  const pending = conn.connect();
  await flushMicrotasks();
  const socket = FakeWebSocket.latest!;
  socket.open();
  await pending;
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LongConnectionBase', () => {
  it('connect opens the socket, runs the handshake and reports connected', async () => {
    const conn = new TestConnection();
    const socket = await bringUp(conn);
    expect(socket).toBeInstanceOf(FakeWebSocket);

    expect(conn.handshakeCalls).toBe(1);
    expect(conn.state.status).toBe('connected');
    await conn.dispose();
  });

  it('routes inbound message frames to handleFrame', async () => {
    const conn = new TestConnection();
    const socket = await bringUp(conn);

    socket.message('payload-1');
    socket.message('payload-2');

    expect(conn.frames).toEqual(['payload-1', 'payload-2']);
    await conn.dispose();
  });

  it('forwards socket errors to the error handler', async () => {
    const conn = new TestConnection();
    const onError = vi.fn();
    conn.setErrorHandler(onError);
    const socket = await bringUp(conn);

    const err = new Error('socket exploded');
    socket.error(err);

    expect(onError).toHaveBeenCalledWith(err);
    await conn.dispose();
  });

  it('fires the heartbeat on the ping interval while connected', async () => {
    vi.useFakeTimers();
    const conn = new TestConnection({ pingIntervalMs: 100 });
    const socket = await bringUp(conn);

    vi.advanceTimersByTime(100);
    expect(conn.heartbeatCalls).toBeGreaterThanOrEqual(1);

    conn.dispose();
  });

  it('schedules a reconnect after an unexpected close', async () => {
    vi.useFakeTimers();
    const conn = new TestConnection();
    const socket = await bringUp(conn);

    const reconnectSpy = vi.spyOn(conn, 'connect');
    socket.serverClose(1006, 'connection lost');
    expect(conn.state.status).toBe('disconnected');

    vi.advanceTimersByTime(60000);
    expect(reconnectSpy).toHaveBeenCalled();

    conn.dispose();
  });

  it('does not reconnect when the policy declines', async () => {
    vi.useFakeTimers();
    const conn = new TestConnection();
    conn.reconnectPolicy = () => false;
    const socket = await bringUp(conn);

    const reconnectSpy = vi.spyOn(conn, 'connect');
    socket.serverClose(1000, 'normal');
    vi.advanceTimersByTime(60000);

    expect(reconnectSpy).not.toHaveBeenCalled();
    conn.dispose();
  });

  it('rejects with a startup timeout and closes the socket when the handshake hangs', async () => {
    const conn = new TestConnection({ startupTimeoutMs: 10 });
    conn.hangHandshake = true;
    const pending = conn.connect();
    await flushMicrotasks();
    const socket = FakeWebSocket.latest!;
    socket.open();
    await flushMicrotasks();

    await expect(pending).rejects.toThrow(/timed out/i);
    expect(socket.closeCalled).toBe(true);
  });

  it('marks the connection permanently disposed and refuses further connects', async () => {
    const conn = new TestConnection();
    const socket = await bringUp(conn);

    conn.dispose();

    expect(conn.disposed).toBe(true);
    await expect(conn.connect()).rejects.toThrow(/disposed/i);
  });
});
