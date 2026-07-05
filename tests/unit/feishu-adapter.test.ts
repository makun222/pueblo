import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';
import { FeishuAdapter, safeParseFeishuOptions } from '../../src/channel/channels/feishu/feishu-adapter';
import type {
    ChannelConfig,
    ChannelEventHandler,
    OutboundMessage,
} from '../../src/channel/channel-types';

// ---------------------------------------------------------------------------
// Mock @larksuite/channel — auto-mock all exports
// ---------------------------------------------------------------------------

vi.mock('@larksuite/channel');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLarkChannelMock() {
    return {
        connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        send: vi.fn<(conversationId: string, input: unknown, opts?: unknown) => Promise<{ messageId: string }>>()
            .mockResolvedValue({ messageId: 'mock-msg-123' }),
        on: vi.fn().mockReturnValue(vi.fn()), // returns unsubscribe fn
    };
}

function makeValidConfig(overrides?: Partial<Record<string, unknown>>): ChannelConfig {
    return {
        id: 'feishu-unit-test',
        kind: 'feishu',
        name: 'Unit Test Feishu',
        enabled: true,
        transport: 'long-connection',
        options: {
            appId: 'test-app-id',
            appSecret: 'test-app-secret',
            ...overrides,
        },
    };
}

function makeMockEventHandler(): ChannelEventHandler {
    return {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onStatusChange: vi.fn(),
    };
}

function spyOnCreatedChannel() {
    const spy = vi.fn();
    vi.mocked(createLarkChannel).mockImplementation((opts) => {
        spy(opts);
        return makeLarkChannelMock() as any;
    });
    return spy;
}

// ---------------------------------------------------------------------------
// safeParseFeishuOptions
// ---------------------------------------------------------------------------

describe('safeParseFeishuOptions', () => {
    it('parses valid options', async () => {
        const result = await safeParseFeishuOptions({ appId: 'id', appSecret: 'secret' });
        expect(result).toEqual({ appId: 'id', appSecret: 'secret' });
    });

    it('throws when options is null', async () => {
        await expect(safeParseFeishuOptions(null as any)).rejects.toThrow('options');
    });

    it('throws when options is not an object', async () => {
        await expect(safeParseFeishuOptions('string' as any)).rejects.toThrow('options');
    });

    it('throws when appId is missing', async () => {
        await expect(safeParseFeishuOptions({ appSecret: 'secret' })).rejects.toThrow('appId');
    });

    it('throws when appSecret is missing', async () => {
        await expect(safeParseFeishuOptions({ appId: 'id' })).rejects.toThrow('appSecret');
    });

    it('throws when appId is empty string', async () => {
        await expect(safeParseFeishuOptions({ appId: '', appSecret: 'secret' })).rejects.toThrow('appId');
    });

    it('throws when appSecret is empty string', async () => {
        await expect(safeParseFeishuOptions({ appId: 'id', appSecret: '' })).rejects.toThrow('appSecret');
    });
});

// ---------------------------------------------------------------------------
// FeishuAdapter
// ---------------------------------------------------------------------------

describe('FeishuAdapter', () => {
    let larkChannelMock: ReturnType<typeof makeLarkChannelMock>;

    beforeEach(() => {
        vi.clearAllMocks();
        larkChannelMock = makeLarkChannelMock();
        vi.mocked(createLarkChannel).mockReturnValue(larkChannelMock as any);
    });

    describe('construction', () => {
        it('stores channelId and kind', () => {
            const adapter = new FeishuAdapter('ch-feishu');
            expect(adapter.channelId).toBe('ch-feishu');
            expect(adapter.kind).toBe('feishu');
        });

        it('starts in disconnected state', () => {
            const adapter = new FeishuAdapter('ch-1');
            expect(adapter.state.status).toBe('disconnected');
        });

        it('reports correct capabilities', () => {
            const adapter = new FeishuAdapter('ch-1');
            expect(adapter.capabilities).toEqual({
                inboundEvents: true,
                outboundReply: true,
                card: true,
                longConnection: true,
            });
        });
    });

    // -------------------------------------------------------------------
    // testConnection(config) — creates a separate test channel
    // -------------------------------------------------------------------

    describe('testConnection', () => {
        it('returns ok:true when connect+disconnect succeed', async () => {
            const adapter = new FeishuAdapter('ch-1');

            const result = await adapter.testConnection(makeValidConfig());

            expect(result.ok).toBe(true);
            // Test creates its own channel, so the mock connect/disconnect are called
            expect(larkChannelMock.connect).toHaveBeenCalledOnce();
            expect(larkChannelMock.disconnect).toHaveBeenCalledOnce();
        });

        it('returns ok:false when test channel connect throws', async () => {
            const adapter = new FeishuAdapter('ch-1');
            larkChannelMock.connect.mockRejectedValueOnce(new Error('Invalid credentials'));

            const result = await adapter.testConnection(makeValidConfig());

            expect(result.ok).toBe(false);
            expect(result.error).toContain('Invalid credentials');
        });

        it('creates larkChannel with appId / appSecret from config options', async () => {
            const spy = spyOnCreatedChannel();
            const adapter = new FeishuAdapter('ch-1');

            await adapter.testConnection(makeValidConfig({ appId: 'my-id', appSecret: 'my-secret' }));

            expect(spy).toHaveBeenCalledWith({ appId: 'my-id', appSecret: 'my-secret' });
        });

        it('throws when config options are missing', async () => {
            const adapter = new FeishuAdapter('ch-1');
            const badConfig = { ...makeValidConfig(), options: undefined as any };

            await expect(adapter.testConnection(badConfig)).rejects.toThrow('options');
        });
    });

    // -------------------------------------------------------------------
    // connect / disconnect
    // -------------------------------------------------------------------

    describe('connect', () => {
        it('calls larkChannel.connect and transitions to connected', async () => {
            const adapter = new FeishuAdapter('ch-1');

            await adapter.connect(makeValidConfig(), makeMockEventHandler());

            expect(larkChannelMock.connect).toHaveBeenCalledOnce();
            expect(adapter.state.status).toBe('connected');
        });

        it('registers message and error listeners', async () => {
            const adapter = new FeishuAdapter('ch-1');

            await adapter.connect(makeValidConfig(), makeMockEventHandler());

            // Two listeners: 'message' and 'error'
            expect(larkChannelMock.on).toHaveBeenCalledTimes(2);
            expect(larkChannelMock.on).toHaveBeenCalledWith('message', expect.any(Function));
            expect(larkChannelMock.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('stays disconnected and re-throws when connect fails', async () => {
            const adapter = new FeishuAdapter('ch-1');
            larkChannelMock.connect.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(
                adapter.connect(makeValidConfig(), makeMockEventHandler()),
            ).rejects.toThrow('Connection refused');
            // Status never transitions to 'connected', so it remains 'disconnected'
            expect(adapter.state.status).toBe('disconnected');
        });
    });

    describe('disconnect', () => {
        it('calls unsubscribers then larkChannel.disconnect', async () => {
            const adapter = new FeishuAdapter('ch-1');
            // on() returns vi.fn() mocks → those act as unsubscribe callbacks
            const unsub1 = vi.fn();
            const unsub2 = vi.fn();
            larkChannelMock.on.mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2);

            await adapter.connect(makeValidConfig(), makeMockEventHandler());
            await adapter.disconnect();

            expect(unsub1).toHaveBeenCalledOnce();
            expect(unsub2).toHaveBeenCalledOnce();
            expect(larkChannelMock.disconnect).toHaveBeenCalledOnce();
            expect(adapter.state.status).toBe('disconnected');
        });

        it('is idempotent when not connected', async () => {
            const adapter = new FeishuAdapter('ch-1');

            await adapter.disconnect(); // should not throw

            expect(adapter.state.status).toBe('disconnected');
        });
    });

    // -------------------------------------------------------------------
    // send
    // -------------------------------------------------------------------

    describe('send', () => {
        it('sends a plain text message via larkChannel.send', async () => {
            const adapter = new FeishuAdapter('ch-1');
            await adapter.connect(makeValidConfig(), makeMockEventHandler());

            const msg: OutboundMessage = {
                externalConversationId: 'oc_abc123',
                text: 'Hello from test',
            };

            const result = await adapter.send(msg);

            expect(result.ok).toBe(true);
            expect(result.externalMessageId).toBe('mock-msg-123');
            expect(larkChannelMock.send).toHaveBeenCalledOnce();
        });

        it('returns error result when not connected', async () => {
            const adapter = new FeishuAdapter('ch-1');
            const msg: OutboundMessage = {
                externalConversationId: 'oc_abc123',
                text: 'Hello',
            };

            const result = await adapter.send(msg);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('not connected');
        });

        it('returns error result when send throws', async () => {
            const adapter = new FeishuAdapter('ch-1');
            await adapter.connect(makeValidConfig(), makeMockEventHandler());
            larkChannelMock.send.mockRejectedValueOnce(new Error('Rate limited'));

            const msg: OutboundMessage = {
                externalConversationId: 'oc_abc123',
                text: 'spam',
            };

            const result = await adapter.send(msg);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('Rate limited');
        });
    });

    // -------------------------------------------------------------------
    // dispose
    // -------------------------------------------------------------------

    describe('dispose', () => {
        it('cleans up connected session', async () => {
            const adapter = new FeishuAdapter('ch-1');
            await adapter.connect(makeValidConfig(), makeMockEventHandler());

            adapter.dispose();

            // dispose is fire-and-forget, but disconnect is async; wait a tick
            await vi.waitFor(() => {
                expect(larkChannelMock.disconnect).toHaveBeenCalledOnce();
            });
            expect(adapter.state.status).toBe('disconnected');
        });

        it('does not throw when already disconnected', () => {
            const adapter = new FeishuAdapter('ch-1');

            expect(() => adapter.dispose()).not.toThrow();
        });
    });
});
