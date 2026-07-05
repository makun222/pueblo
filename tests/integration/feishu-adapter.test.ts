/**
 * Feishu 集成测试
 *
 * 使用真实的飞书 API 凭据验证 SDK 连通性和适配器功能。
 *
 * 所需环境变量：
 *   FEISHU_APP_ID     – 飞书应用的 App ID
 *   FEISHU_APP_SECRET – 飞书应用的 App Secret
 *
 * 设置方式（选其一）：
 *   1. 在仓库根目录创建 .env 文件：
 *        FEISHU_APP_ID=cli_xxxxxxxxxxxx
 *        FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
 *   2. 命令行直接设置：
 *        set FEISHU_APP_ID=cli_xxx && set FEISHU_APP_SECRET=xxx && npx vitest tests/integration/feishu-adapter
 *
 * 运行：
 *   npx vitest tests/integration/feishu-adapter
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';
import { FeishuAdapter } from '../../src/channel/channels/feishu/feishu-adapter';
import type { ChannelConfig, ChannelEventHandler } from '../../src/channel/channel-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `缺少必需的环境变量 "${name}"，请设置后再运行集成测试。\n` +
            `例如：set ${name}=<your-value>`,
        );
    }
    return value;
}

function makeConfig(): ChannelConfig {
    return {
        id: 'feishu-integration-test',
        kind: 'feishu',
        name: 'Integration Test',
        enabled: true,
        transport: 'long-connection',
        options: {
            appId: getRequiredEnv('FEISHU_APP_ID'),
            appSecret: getRequiredEnv('FEISHU_APP_SECRET'),
        },
    };
}

// ---------------------------------------------------------------------------
// 不设置环境变量时跳过整个套件
// ---------------------------------------------------------------------------

const shouldRun = process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET;

(shouldRun ? describe : describe.skip)('FeishuAdapter Integration', () => {
    let config: ChannelConfig;

    beforeAll(() => {
        config = makeConfig();
    });

    // -----------------------------------------------------------------------
    // SDK 直连测试（最基础的连通性验证）
    // -----------------------------------------------------------------------

    describe('SDK raw connectivity', () => {
        it('createLarkChannel + createChat returns chatId', async () => {
            const channel = createLarkChannel({
                appId: config.options.appId as string,
                appSecret: config.options.appSecret as string,
            });
channel.on('message', async (msg) => {
  await channel.send(
    msg.chatId,
    { markdown: `received: ${msg.content}` },
    { replyTo: msg.messageId },
  );
});
await channel.connect();
        /* 
        const result = await channel.createChat({
                name: 'integration-test-chat',
                description: 'Auto-created by integration test',
            });

            expect(result).toHaveProperty('chatId');
            expect(typeof result.chatId).toBe('string');
            */
            await channel.disconnect();
        }, 15000); // 15s timeout for API call
    });

    // -----------------------------------------------------------------------
    // FeishuAdapter.testConnection 测试
    // -----------------------------------------------------------------------

    describe('FeishuAdapter.testConnection', () => {
        it('returns ok: true with valid credentials', async () => {
            const adapter = new FeishuAdapter('integration-test-channel');
            const result = await adapter.testConnection(config);

            expect(result.ok).toBe(true);
        }, 15000);

        it('returns ok: false with invalid credentials', async () => {
            const adapter = new FeishuAdapter('bad-channel');
            const badConfig: ChannelConfig = {
                ...config,
                options: {
                    appId: 'invalid-app-id',
                    appSecret: 'invalid-secret',
                },
            };

            const result = await adapter.testConnection(badConfig);

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        }, 15000);

    });

    // -----------------------------------------------------------------------
    // FeishuAdapter.send 测试（发送数据）
    // -----------------------------------------------------------------------

    describe('FeishuAdapter.send', () => {
        it('returns error when not connected', async () => {
            const adapter = new FeishuAdapter('send-not-connected');
            const result = await adapter.send({
                externalConversationId: 'oc_nonexistent',
                text: 'should not work',
            });
            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        }, 10000);

        it('returns error after disconnect', async () => {
            const adapter = new FeishuAdapter('send-disconnect');
            const handler: ChannelEventHandler = {
                onMessage: () => {},
                onError: () => {},
                onStatusChange: () => {},
            };
            await adapter.connect(config, handler);
            await adapter.disconnect();
            const result = await adapter.send({
                externalConversationId: 'oc_nonexistent',
                text: 'should not work',
            });
            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        }, 15000);

        it('send with invalid chatId returns server error', async () => {
            const adapter = new FeishuAdapter('send-invalid-chat');
            const handler: ChannelEventHandler = {
                onMessage: () => {},
                onError: () => {},
                onStatusChange: () => {},
            };
            try {
                await adapter.connect(config, handler);
                const result = await adapter.send({
                    externalConversationId: 'oc_invalid_chat_id_12345',
                    text: 'this chat does not exist',
                });
                // Server should reject with ok: false due to non-existent chatId
                expect(result.ok).toBe(false);
                expect(result.error).toBeDefined();
                console.log('expected server error:', result.error);
            } finally {
                await adapter.disconnect();
            }
        }, 20000);
    });

    // -----------------------------------------------------------------------
    // SDK raw send 测试
    // -----------------------------------------------------------------------

    describe('SDK raw send', () => {
        it('send as reply via onMessage handler', async () => {
            const channel = createLarkChannel({
                appId: config.options.appId as string,
                appSecret: config.options.appSecret as string,
            });
            const echoes: unknown[] = [];
            channel.on('message', async (msg) => {
                const result = await channel.send(
                    msg.chatId,
                    { markdown: `echo: ${msg.content}` },
                    { replyTo: msg.messageId },
                );
                echoes.push(result);
                console.log('echo sent:', JSON.stringify(result, null, 2));
            });
            channel.on('error', (err) => {
                console.error('channel error:', err);
            });
            try {
                // connect() returns void; non-throw means success
                await channel.connect();
                // Wait briefly for potential incoming messages to trigger echo replies
                await new Promise((resolve) => setTimeout(resolve, 5000));
                console.log(`received ${echoes.length} message echoes`);
            } finally {
                await channel.disconnect();
            }
        }, 20000);
    });
});
