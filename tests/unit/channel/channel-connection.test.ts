import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LongConnectionBase, type LongConnectionOptions } from '../../../src/channel/channel-connection';
import type { ChannelType } from '../../../src/channel/channel-types';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------
type WsEventMap = {
  open: () => void;
  message: (data: string) => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
  ping: () => void;
  pong: () => void;
};

class FakeWebSocket {
  readonly url: string;
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Error) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  closeCalled = false;
  closeCode = 0;
  closeReason = '';

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(ev: string, fn: (...args: any[]) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }

  removeEventListener(ev: string, fn: (...args: any[]) => void) {
    this.listeners.get(ev)?.delete(fn);
  }

  // Test helpers
  fakeOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
    for (const fn of this.listeners.get('open') ?? []) fn();
  }

  fakeMessage(data: string) {
    for (const fn of this.listeners.get('message') ?? []) fn(data);
    this.onmessage?.({ data });
  }

  fakeClose(code: number, reason: string) {
    this.readyState = WebSocket.CLOSED;
    for (const fn of this.listeners.get('close') ?? []) fn(code, reason);
    this.onclose?.({ code, reason });
  }

  fakeError(err: Error) {
    for (const fn of this.listeners.get('error') ?? []) fn(err);
    this.onerror?.(err);
  }

  close(code?: number, reason?: string) {
    this.closeCalled = true;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
    this.readyState = WebSocket.CLOSED;
  }
}

// ---------------------------------------------------------------------------
// Helper: minimal concrete subclass for testing
// ---------------------------------------------------------------------------
class TestConnection extends LongConnectionBase {
  outgoing: string[] = [];
  protected override async handshake(): Promise<void> { /* no-op */ }
  protected override onIncoming(data: string): void { /* no-op */ }
  protected override onOutgoing(data: string): void { this.outgoing.push(data); }
  get wsFake(): FakeWebSocket | null { return (this as any).ws as FakeWebSocket | null; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LongConnectionBase', () => {
  const fakeUrl = 'ws://localhost:9999/test';
  let conn: TestConnection;
  let origWs: any;

  beforeEach(() => {
    origWs = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket as any;
    conn = new TestConnection(fakeUrl, 'test-channel' as ChannelType);
  });

  afterEach(async () => {
    await conn.dispose();
    (globalThis as any).WebSocket = origWs;
  });

  // ---- connect / disconnect ----
  it('connects and sets readyState = CONNECTED', async () => {
    const promise = conn.connect();
    const ws = conn.wsFake!;
    ws.fakeOpen();
    await promise;
    expect(conn.readyState).toBe('CONNECTED');
  });

  it('dispose closes the socket and sets readyState = DISCONNECTED', async () => {
    await conn.connect();
    const ws = conn.wsFake!;
    ws.fakeOpen();

    await conn.dispose();
    expect(conn.readyState).toBe('DISCONNECTED');
    expect(ws.closeCalled).toBe(true);
  });

  it('isConnected returns true only when CONNECTED', async () => {
    expect(conn.isConnected).toBe(false);
    await conn.connect();
    conn.wsFake!.fakeOpen();
    expect(conn.isConnected).toBe(true);
    await conn.dispose();
    expect(conn.isConnected).toBe(false);
  });

  // ---- send ----
  it('send queues outgoing data and calls onOutgoing', async () => {
    await conn.connect();
    conn.wsFake!.fakeOpen();
    conn.send('hello');
    expect(conn.outgoing).toContain('hello');
  });

  it('send before connect throws', () => {
    expect(() => conn.send('data')).toThrow(/not connected/i);
  });

  // ---- pending timeout ----
  it('rejects connect on pending timeout', async () => {
    const fastTimeout = new TestConnection(fakeUrl, 'test-channel' as ChannelType, {
      pendingTimeoutMs: 10,
    });
    await expect(fastTimeout.connect()).rejects.toThrow(/timed?out/i);
    await fastTimeout.dispose();
  });

  // ---- reconnect (exponential backoff) ----
  it('reconnects after close when auto-reconnect is enabled', async () => {
    const autoConn = new TestConnection(fakeUrl, 'test-channel' as ChannelType, {
      autoReconnect: true,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
    // Stub setTimeout so reconnection fires synchronously in test
    const origSetTimeout = globalThis.setTimeout;
    const timerCalls: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, _ms: number) => {
      timerCalls.push(fn);
      return 0 as any;
    }) as any;

    await autoConn.connect();
    (autoConn as any).ws.fakeOpen();

    // Simulate unexpected close
    const reconnectSpy = vi.spyOn(autoConn as any, 'reconnect');
    (autoConn as any).ws.fakeClose(1006, 'connection lost');

    // Execute scheduled reconnect
    for (const cb of timerCalls) cb();

    expect(reconnectSpy).toHaveBeenCalled();

    globalThis.setTimeout = origSetTimeout;
    await autoConn.dispose();
  });

  it('does not reconnect when autoReconnect is false', async () => {
    await conn.connect();
    conn.wsFake!.fakeOpen();

    const reconnectSpy = vi.spyOn(conn as any, 'reconnect');
    conn.wsFake!.fakeClose(1000, 'normal');

    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  // ---- heartbeat ----
  it('sends ping frames during heartbeat interval', async () => {
    vi.useFakeTimers();
    const hbConn = new TestConnection(fakeUrl, 'test-channel' as ChannelType, {
      heartbeatIntervalMs: 100,
    });
    await hbConn.connect();
    (hbConn as any).ws.fakeOpen();

    const sendSpy = vi.spyOn(hbConn as any, 'sendRaw');
    vi.advanceTimersByTime(100);
    expect(sendSpy).toHaveBeenCalledWith(expect.stringMatching(/ping/i));

    vi.useRealTimers();
    await hbConn.dispose();
  });

  // ---- error handling ----
  it('handles WebSocket error by closing', async () => {
    await conn.connect();
    conn.wsFake!.fakeOpen();
    const closeSpy = vi.spyOn(conn as any, 'close');

    conn.wsFake!.fakeError(new Error('test error'));

    expect(closeSpy).toHaveBeenCalled();
  });
});
