// ---------------------------------------------------------------------------
// DeepSeek Vision MCP Bridge — local stdio MCP server exposing describe_image
// ---------------------------------------------------------------------------
//
// Design: docs/designs/deepseek-vision-mcp-design.md (方案 2, M1)
//
// This is the standalone, external form of the bridge: a plain ESM stdio
// script that lives OUTSIDE the tsc build tree (mcp/). Pueblo spawns it as
// `node <this file>` (see .pueblo/mcp-servers.json), so there is no
// compilation step and no "builtin" server payload inside the main bundle.
// (Migrated 1:1 from the former in-tree src/mcp-servers/deepseek-vision-bridge.ts;
// it depends only on node builtins + global fetch.)
//
// Turns a local image file into a base64 data URL and sends it to
// deepseek-v4-flash-vision-exp via the DeepSeek Chat Completions API.
// Images NEVER enter the Pueblo provider message chain; they only travel on
// the isolated HTTP leg "bridge process -> api.deepseek.com".
//
// Protocol: line-delimited JSON-RPC 2.0 over stdio, aligned with the client
// parsers in src/mcp/mcp-protocol.ts:
//   - handled methods: initialize | notifications/initialized | tools/list |
//     tools/call | ping
//   - notifications (no id): never answered
//   - stdout: JSON-RPC responses only (never log to stdout)
//   - stderr: diagnostics
//
// Security (D5): filePath is resolved and must stay inside one of the
// allowed roots (default: process.cwd(); extend via env
// DEEPSEEK_VISION_ALLOWED_ROOTS with OS path-delimiter separated entries).
//
// Run: node mcp/deepseek-vision-bridge.mjs
// Env:  DEEPSEEK_API_KEY (required at call time, not at startup)
// ---------------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { delimiter, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── Constants (exported for tests) ───────────────────────────────────────

export const BRIDGE_SERVER_ID = 'deepseek-vision';
export const BRIDGE_SERVER_NAME = 'DeepSeek Vision (exp)';
export const BRIDGE_SERVER_VERSION = '0.1.0';
export const BRIDGE_PROTOCOL_VERSION = '2024-11-05';

export const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
export const VISION_API_URL = 'https://api.deepseek.com/chat/completions';
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // upstream limit: 32 MiB
export const DEFAULT_PROMPT = 'Describe this image, including any visible text.';
export const DEFAULT_MAX_TOKENS = 4096;
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 16384;
export const DEFAULT_HTTP_TIMEOUT_MS = 25_000; // stays under client 30s timeout

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const SUPPORTED_FORMATS = [...new Set(Object.values(MIME_BY_EXT))].join(' / ');

// ─── Tool Schema ──────────────────────────────────────────────────────────

const DESCRIBE_IMAGE_TOOL = {
  name: 'describe_image',
  description:
    'Describe a local image file (visible text / OCR included). The image is read ' +
    'inside this bridge process and sent as base64 directly to the DeepSeek vision ' +
    `API (${VISION_MODEL}); it never enters the conversation history. Supported ` +
    `formats: ${SUPPORTED_FORMATS}; max ${MAX_IMAGE_BYTES / 1024 / 1024} MiB. filePath ` +
    'must be inside the allowed workspace roots.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description:
          'Absolute path of the image file to inspect (JPEG/PNG/GIF/WebP, ≤32MiB, inside allowed workspace roots).',
      },
      prompt: {
        type: 'string',
        description: `Optional instruction for the vision model. Default: "${DEFAULT_PROMPT}".`,
      },
      maxTokens: {
        type: 'number',
        description: `Optional max output tokens (default ${DEFAULT_MAX_TOKENS}, range ${MIN_MAX_TOKENS}–${MAX_MAX_TOKENS}).`,
        minimum: MIN_MAX_TOKENS,
        maximum: MAX_MAX_TOKENS,
      },
    },
    required: ['filePath'],
  },
};

// ─── Small helpers ────────────────────────────────────────────────────────

/** Case-insensitive containment test for Windows drive letters / casing. */
function isInsideRoot(root, target) {
  if (root === target) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target.startsWith(prefix);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function mimeForPath(filePath) {
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()];
  return mime ?? null;
}

// ─── Factory ──────────────────────────────────────────────────────────────

export function createVisionBridgeServer(options = {}) {
  const apiBaseUrl = options.apiBaseUrl ?? VISION_API_URL;
  const model = options.model ?? VISION_MODEL;
  const allowedRoots = options.allowedRoots ?? [resolve(process.cwd())];
  const apiKeyProvider =
    options.apiKeyProvider ?? (() => process.env.DEEPSEEK_API_KEY ?? null);
  const fetchImpl =
    options.fetchImpl ?? ((url, init) => fetch(url, init));
  const readFileImpl = options.readFileImpl ?? readFile;
  const log = options.log ?? ((msg) => console.error(`[deepseek-vision] ${msg}`));
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  let closed = false;
  let activeController = null;

  // ─── tools/call: describe_image ─────────────────────────────────────────

  /** Readable tool-level failure; returned as result.isError, never thrown. */
  class ToolFailure extends Error {}

  function validateFileArgs(args) {
    if (!isPlainObject(args)) {
      throw new ToolFailure('参数 filePath 缺失：describe_image 需要 { filePath: string }');
    }
    const filePath = args.filePath;
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new ToolFailure('参数 filePath 必须是图片文件的绝对路径（字符串）');
    }

    let prompt = DEFAULT_PROMPT;
    if (args.prompt !== undefined) {
      if (typeof args.prompt !== 'string') {
        throw new ToolFailure('参数 prompt 必须是字符串');
      }
      prompt = args.prompt;
    }

    let maxTokens = DEFAULT_MAX_TOKENS;
    if (args.maxTokens !== undefined) {
      if (
        typeof args.maxTokens !== 'number' ||
        !Number.isInteger(args.maxTokens) ||
        args.maxTokens < MIN_MAX_TOKENS ||
        args.maxTokens > MAX_MAX_TOKENS
      ) {
        throw new ToolFailure(
          `参数 maxTokens 必须是 ${MIN_MAX_TOKENS}–${MAX_MAX_TOKENS} 之间的整数`,
        );
      }
      maxTokens = args.maxTokens;
    }

    return { filePath: filePath.trim(), prompt, maxTokens };
  }

  function assertAllowedPath(filePath) {
    const abs = resolve(filePath);
    for (const root of allowedRoots) {
      if (isInsideRoot(resolve(root), abs)) return;
    }
    throw new ToolFailure(
      `路径不在允许读取范围内：${abs}（仅允许 workspace / .pueblo-ws / cwd 白名单内的文件）`,
    );
  }

  async function extractVisionText(payload) {
    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    if (Array.isArray(raw)) {
      const parts = raw
        .filter((p) => isPlainObject(p) && p.type === 'text')
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter((t) => t.trim() !== '');
      if (parts.length > 0) return parts.join('\n').trim();
    }
    throw new ToolFailure('DeepSeek vision API 返回中未找到文本内容');
  }

  async function callDescribeImage(args) {
    const { filePath, prompt, maxTokens } = validateFileArgs(args);
    assertAllowedPath(filePath);

    const mime = mimeForPath(filePath);
    if (!mime) {
      throw new ToolFailure(
        `不支持的文件格式：${extname(filePath).toLowerCase() || '(无扩展名)'}（仅支持 ${SUPPORTED_FORMATS}）`,
      );
    }

    let buffer;
    try {
      buffer = await readFileImpl(filePath);
    } catch (err) {
      throw new ToolFailure(`读取图片文件失败：${errText(err)}`);
    }
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new ToolFailure(
        `图片大小 ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB 超过上游 32 MiB 限制`,
      );
    }

    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const apiKey = await apiKeyProvider();
    if (!apiKey) {
      throw new ToolFailure('缺少 DEEPSEEK_API_KEY：无法调用 DeepSeek vision API');
    }

    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    let resp;
    try {
      resp = await fetchImpl(apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const hint =
        err instanceof Error && err.name === 'AbortError'
          ? `（超时 ${requestTimeoutMs}ms）`
          : '';
      throw new ToolFailure(`请求 DeepSeek vision API 失败${hint}：${errText(err)}`);
    } finally {
      clearTimeout(timer);
      activeController = null;
    }

    const respText = await resp.text();
    if (!resp.ok) {
      const snippet = respText.length > 500 ? `${respText.slice(0, 500)}…` : respText;
      throw new ToolFailure(
        `DeepSeek vision API 错误 HTTP ${resp.status}：${snippet || (resp.statusText ?? '')}`,
      );
    }

    let jsonPayload;
    try {
      jsonPayload = JSON.parse(respText);
    } catch {
      throw new ToolFailure('DeepSeek vision API 返回了无法解析的响应');
    }
    const conclusion = await extractVisionText(jsonPayload);
    return {
      content: [{ type: 'text', text: conclusion }],
      isError: false,
    };
  }

  // ─── JSON-RPC dispatch ──────────────────────────────────────────────────

  class RpcError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: BRIDGE_SERVER_VERSION },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [DESCRIBE_IMAGE_TOOL] };
      case 'tools/call': {
        const call = isPlainObject(params) ? params : {};
        const name = call.name;
        if (name !== DESCRIBE_IMAGE_TOOL.name) {
          return {
            content: [{ type: 'text', text: `未知工具：${String(name ?? '(缺省)')}` }],
            isError: true,
          };
        }
        try {
          return await callDescribeImage(call.arguments);
        } catch (err) {
          if (err instanceof ToolFailure) {
            return {
              content: [{ type: 'text', text: `[describe_image] ${err.message}` }],
              isError: true,
            };
          }
          log(`unexpected tools/call error: ${errText(err)}`);
          return {
            content: [{ type: 'text', text: `[describe_image] 内部错误：${errText(err)}` }],
            isError: true,
          };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  return {
    async handleMessage(line) {
      if (closed) return null;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`ignoring non-JSON line: ${line.slice(0, 120)}`);
        return null;
      }
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return null;

      // Notification (no id): never answered.
      if (msg.id === undefined || msg.id === null) return null;

      const id = msg.id;
      const respond = (result) => JSON.stringify({ jsonrpc: '2.0', id, result });
      const respondError = (code, message) =>
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

      try {
        return respond(await dispatch(msg.method, msg.params));
      } catch (err) {
        const code = err instanceof RpcError ? err.code : -32603;
        const message = errText(err);
        log(`request failed method=${msg.method} id=${String(id)}: ${message}`);
        return respondError(code, message);
      }
    },
    close() {
      closed = true;
      if (activeController) activeController.abort();
    },
  };
}

// ─── stdio entrypoint ─────────────────────────────────────────────────────

export function resolveAllowedRootsFromEnv() {
  const roots = [resolve(process.cwd())];
  const extra = process.env.DEEPSEEK_VISION_ALLOWED_ROOTS;
  if (extra) {
    for (const part of extra.split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed) roots.push(resolve(trimmed));
    }
  }
  // Deduplicate keeping first occurrence.
  return roots.filter((root, idx) => roots.indexOf(root) === idx);
}

export function runStdioServer(server) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      void server
        .handleMessage(line)
        .then((out) => {
          if (out !== null) process.stdout.write(`${out}\n`);
        })
        .catch((err) => {
          // Never let a handler failure break the loop; log and continue.
          console.error(`[deepseek-vision] handler error: ${errText(err)}`);
        });
    });
    rl.on('close', () => {
      server.close();
      resolvePromise();
    });
  });
}

export async function main() {
  const server = createVisionBridgeServer({ allowedRoots: resolveAllowedRootsFromEnv() });
  console.error(
    `[deepseek-vision] ready — model=${VISION_MODEL} allowedRoots=${resolveAllowedRootsFromEnv().join('; ')}`,
  );
  await runStdioServer(server);
}

// Only start the stdio loop when executed directly (not when imported by tests).
// ESM equivalent of the old `require.main === module` guard.
const isDirectRun =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
    } catch {
      return false;
    }
  })();

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[deepseek-vision] fatal: ${errText(err)}`);
    process.exitCode = 1;
  });
}
