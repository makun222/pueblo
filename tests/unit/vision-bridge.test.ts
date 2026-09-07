// ---------------------------------------------------------------------------
// Contract tests: DeepSeek Vision MCP Bridge (design 方案 2, M2)
// ---------------------------------------------------------------------------
// Exercises the bridge through line-based JSON-RPC messages and asserts every
// answer round-trips through the real client parsers in src/mcp/mcp-protocol.ts
// (parseResponse / parseListToolsResult / parseCallToolResult).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// The bridge now lives outside the tsc build tree as a standalone plain-ESM
// stdio script (mcp/deepseek-vision-bridge.mjs) with no .d.ts, so the value
// imports below are asserted and the (formerly exported) types are mirrored
// locally — they only shape test code, never runtime behaviour.
// @ts-expect-error — no declaration file for the standalone .mjs bridge module
import {
  createVisionBridgeServer,
  DEFAULT_PROMPT,
  DEFAULT_MAX_TOKENS,
  VISION_MODEL,
  VISION_API_URL,
  MAX_IMAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVER_NAME,
} from '../../mcp/deepseek-vision-bridge.mjs';

// ─── Local type mirror of the bridge exports (.mjs has no declarations) ────

interface VisionHttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

type HttpPostFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<VisionHttpResponse>;

interface VisionBridgeServer {
  handleMessage(line: string): Promise<string | null>;
  close(): void;
}

interface CreateVisionBridgeOptions {
  apiBaseUrl?: string;
  model?: string;
  allowedRoots?: string[];
  apiKeyProvider?: () => string | null | Promise<string | null>;
  fetchImpl?: HttpPostFn;
  readFileImpl?: (filePath: string) => Promise<Buffer>;
  log?: (message: string) => void;
  requestTimeoutMs?: number;
}
import {
  parseResponse,
  parseListToolsResult,
  parseCallToolResult,
  type JsonRpcResponse,
} from '../../src/mcp/mcp-protocol';

// ─── Helpers ──────────────────────────────────────────────────────────────

const ALLOWED_ROOT = resolve(tmpdir());

function inAllowedRoot(name: string): string {
  return join(ALLOWED_ROOT, name);
}

function outsideAllowedRoot(name: string): string {
  // Parent of ALLOWED_ROOT — resolve() must land outside the whitelist.
  return join(ALLOWED_ROOT, '..', name);
}

function okResponse(body: unknown): VisionHttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  };
}

function httpErrorResponse(status: number, text: string): VisionHttpResponse {
  return { ok: false, status, statusText: 'Error', text: async () => text };
}

interface Fixture {
  server: VisionBridgeServer;
  fetchMock: ReturnType<typeof vi.fn<HttpPostFn>>;
  /** The parsed request body of the last fetch call. */
  lastRequestBody(): Record<string, unknown>;
  /** The parsed response message for the given output line. */
  parse(out: string | null): JsonRpcResponse;
}

let servers: VisionBridgeServer[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

function makeFixture(overrides: Partial<CreateVisionBridgeOptions> = {}): Fixture {
  const fetchMock = vi.fn<HttpPostFn>();
  fetchMock.mockResolvedValue(okResponse({ choices: [{ message: { content: '图中是一个红色苹果和文字“HELLO”。' } }] }));

  const server = createVisionBridgeServer({
    allowedRoots: [ALLOWED_ROOT],
    apiKeyProvider: async () => 'test-key',
    fetchImpl: fetchMock,
    readFileImpl: async () => Buffer.from('fake-image-bytes'),
    log: () => undefined,
    ...overrides,
  });
  servers.push(server);

  return {
    server,
    fetchMock,
    lastRequestBody() {
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init).toBeDefined();
      return JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>;
    },
    parse(out) {
      expect(out).not.toBeNull();
      const msg = parseResponse(out as string);
      expect(msg).not.toBeNull();
      return msg as JsonRpcResponse;
    },
  };
}

function contentTextOf(msg: JsonRpcResponse): string {
  const parsed = parseCallToolResult(msg.result);
  return parsed.content.map((c) => c.text ?? '').join('');
}

const describeImageArgs = (args: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'describe_image', arguments: args } });

// ─── Tests ────────────────────────────────────────────────────────────────

describe('deepseek-vision-bridge · protocol shape', () => {
  it('initialize: answers with MCP 2024-11-05 result parseable by client', async () => {
    const { server, parse } = makeFixture();
    const out = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'pueblo', version: '0.1.0' },
        },
      }),
    );
    const msg = parse(out);
    expect(msg.id).toBe(1);
    const result = msg.result as {
      protocolVersion?: string;
      capabilities?: { tools?: unknown };
      serverInfo?: { name?: string };
    };
    expect(result.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(result.capabilities?.tools).toEqual({});
    expect(result.serverInfo?.name).toBe(BRIDGE_SERVER_NAME);
  });

  it('tools/list: returns describe_image with required filePath schema', async () => {
    const { server, parse } = makeFixture();
    const out = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const msg = parse(out);
    const tools = parseListToolsResult(msg.result);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('describe_image');
    expect(tool.description.length).toBeGreaterThan(20);
    const schema = tool.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('filePath');
    expect(schema.properties).toHaveProperty('filePath');
    expect(schema.properties).toHaveProperty('prompt');
    expect(schema.properties).toHaveProperty('maxTokens');
  });

  it('ping: answers with empty result', async () => {
    const { server, parse } = makeFixture();
    const msg = parse(await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })));
    expect(msg.result).toEqual({});
  });

  it('notifications/initialized: never answered (returns null)', async () => {
    const { server } = makeFixture();
    const out = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(out).toBeNull();
  });

  it('unknown method: answers with JSON-RPC error -32601', async () => {
    const { server, parse } = makeFixture();
    const msg = parse(
      await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' })),
    );
    expect(msg.error?.code).toBe(-32601);
  });

  it('malformed line: ignored without response', async () => {
    const { server } = makeFixture();
    expect(await server.handleMessage('this is not json')).toBeNull();
  });
});

describe('deepseek-vision-bridge · describe_image success', () => {
  it('POSTs model/prompt/dataURL to DeepSeek and returns extracted text', async () => {
    const { server, fetchMock, lastRequestBody, parse } = makeFixture();

    const out = await server.handleMessage(
      describeImageArgs({ filePath: inAllowedRoot('snap.png'), prompt: 'What color is it?', maxTokens: 2048 }),
    );
    const msg = parse(out);
    expect(msg.error).toBeUndefined();

    // One HTTP POST to the official endpoint with bearer auth.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(VISION_API_URL);
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = lastRequestBody() as {
      model?: string;
      max_tokens?: number;
      messages?: Array<{
        content?: Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
      }>;
    };
    expect(body.model).toBe(VISION_MODEL);
    expect(body.max_tokens).toBe(2048);
    const content = body.messages?.[0]?.content ?? [];
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('What color is it?');
    expect(content[1]?.type).toBe('image_url');
    expect(content[1]?.image_url?.url).toBe(
      'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==', // base64("fake-image-bytes")
    );

    // Result text extracted from choices[0].message.content.
    expect(parseCallToolResult(msg.result).isError).toBe(false);
    expect(contentTextOf(msg)).toContain('红色苹果');
  });

  it('uses default prompt and maxTokens when omitted', async () => {
    const { server, lastRequestBody } = makeFixture();
    await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('a.jpeg') }));
    const body = lastRequestBody() as { max_tokens?: number; messages?: Array<{ content?: Array<{ text?: string }> }> };
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    const textPart = body.messages?.[0]?.content?.[0];
    expect(textPart?.text).toBe(DEFAULT_PROMPT);
  });

  it('accepts uppercase extensions and maps them to the right mime', async () => {
    const { server, lastRequestBody } = makeFixture();
    await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('shot.JPG') }));
    const body = lastRequestBody() as { messages?: Array<{ content?: Array<{ image_url?: { url?: string } }> }> };
    const url = body.messages?.[0]?.content?.[1]?.image_url?.url ?? '';
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('deepseek-vision-bridge · describe_image errors', () => {
  it('path outside whitelist → isError, no HTTP call', async () => {
    const { server, fetchMock, parse } = makeFixture();
    const msg = parse(await server.handleMessage(describeImageArgs({ filePath: outsideAllowedRoot('secret.png') })));
    expect(fetchMock).not.toHaveBeenCalled();
    const parsed = parseCallToolResult(msg.result);
    expect(parsed.isError).toBe(true);
    expect(parsed.content.map((c) => c.text ?? '').join('')).toContain('不在允许读取范围内');
  });

  it('non-image extension → isError mentioning supported formats', async () => {
    const { server, fetchMock, parse } = makeFixture();
    const msg = parse(await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('doc.bmp') })));
    expect(fetchMock).not.toHaveBeenCalled();
    const text = contentTextOf(msg);
    expect(text).toContain('不支持的文件格式');
    expect(text).toContain('image/jpeg');
  });

  it('file over 32MiB → isError, no HTTP call', async () => {
    const { server, fetchMock } = makeFixture({
      readFileImpl: async () => Buffer.alloc(MAX_IMAGE_BYTES + 1),
    });
    const msg = await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('big.png') }));
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('超过上游 32 MiB');
  });

  it('missing DEEPSEEK_API_KEY → isError, no HTTP call', async () => {
    const { server, fetchMock } = makeFixture({ apiKeyProvider: async () => null });
    const msg = await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('a.png') }));
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('DEEPSEEK_API_KEY');
  });

  it('read failure → isError with readable message', async () => {
    const { server, fetchMock } = makeFixture({
      readFileImpl: async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    });
    const msg = await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('missing.png') }));
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('读取图片文件失败');
  });

  it('HTTP error status → isError containing status code', async () => {
    const { server } = makeFixture({
      fetchImpl: (async () => httpErrorResponse(429, 'rate limited')) as HttpPostFn,
    });
    const msg = await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('a.png') }));
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(text).toContain('HTTP 429');
    expect(text).toContain('rate limited');
  });

  it('HTTP 200 without text content → isError', async () => {
    const { server } = makeFixture({
      fetchImpl: (async () => okResponse({ choices: [] })) as HttpPostFn,
    });
    const msg = await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('a.png') }));
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(text).toContain('未找到文本内容');
  });

  it('invalid maxTokens → isError with range hint', async () => {
    const { server, fetchMock } = makeFixture();
    for (const bad of [0, 99999, 'many', 12.5]) {
      const msg = await server.handleMessage(
        describeImageArgs({ filePath: inAllowedRoot('a.png'), maxTokens: bad }),
      );
      const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
      expect(text).toContain('maxTokens');
      expect(text).toContain('1–16384');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing filePath argument → isError', async () => {
    const { server, fetchMock } = makeFixture();
    const msg = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'describe_image', arguments: {} } }),
    );
    const text = contentTextOf(parseResponse(msg as string) as JsonRpcResponse);
    expect(text).toContain('filePath');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown tool name → isError without crashing', async () => {
    const { server, fetchMock } = makeFixture();
    const msg = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'other_tool', arguments: {} } }),
    );
    const parsed = parseCallToolResult(parseResponse(msg as string)?.result);
    expect(parsed.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deepseek-vision-bridge · transport resilience', () => {
  it('network failure of HTTP leg → isError, server keeps serving next request', async () => {
    const failing = vi.fn<HttpPostFn>();
    failing.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    failing.mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '恢复后成功' } }] }));
    const { server, parse } = makeFixture({ fetchImpl: failing });

    const badMsg = parse(await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('a.png') })));
    expect(contentTextOf(badMsg)).toContain('请求 DeepSeek vision API 失败');

    // A subsequent (successful) request on the same server still works.
    const goodMsg = parse(await server.handleMessage(describeImageArgs({ filePath: inAllowedRoot('b.png') })));
    expect(parseCallToolResult(goodMsg.result).isError).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('unknown tool name with non-object arguments does not throw', async () => {
    const { server } = makeFixture();
    const msg = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'describe_image', arguments: 'oops' } }),
    );
    const parsed = parseCallToolResult(parseResponse(msg as string)?.result);
    expect(parsed.isError).toBe(true);
  });
});
