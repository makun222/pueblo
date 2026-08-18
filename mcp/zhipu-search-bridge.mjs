// zhipu-search-bridge.mjs
// ---------------------------------------------------------------------------
// 智谱 web-search MCP 的本地 stdio 桥接器
// Pueblo 只支持 stdio 型 MCP server（spawn command + args），不支持远程 SSE/HTTP。
// 本脚本以 stdio 方式向 Pueblo 提供 MCP 服务，内部通过 REST (POST)
// 转发到智谱开放平台的 web_search API（/api/paas/v4/web_search）。
//
// 用法: node zhipu-search-bridge.mjs
// 环境变量: ZHIPU_API_KEY (必填；缺失时脚本启动即报错退出)
// ---------------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const API_KEY = process.env.ZHIPU_API_KEY;
if (!API_KEY) {
  console.error('[zhipu-search-bridge] 错误：缺少环境变量 ZHIPU_API_KEY。');
  console.error('[zhipu-search-bridge] 请先在智谱开放平台 (https://open.bigmodel.cn) 创建 API Key，');
  console.error('[zhipu-search-bridge] 设置环境变量后再启动本脚本：');
  console.error('[zhipu-search-bridge]   Windows PowerShell: $env:ZHIPU_API_KEY="your-api-key"');
  console.error('[zhipu-search-bridge]   Linux/macOS:        export ZHIPU_API_KEY=your-api-key');
  process.exit(1);
}
// 上游通道：智谱 MCP broker 端点（本 Key 无权限，401，保留备查）
const ZHIPU_MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
// 实际可用通道：智谱 REST web_search（paas/v4，已验证 HTTP 200）
const ZHIPU_REST_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

const SERVER_INFO = {
  name: 'zhipu-web-search-bridge',
  version: '1.1.0',
};

// ─── 转发到智谱 REST web_search（paas/v4，已验证可用）────────────────
const ENGINE_BY_TOOL = {
  // 官方枚举（docs.bigmodel.cn API 参考）：search_std / search_pro / search_pro_sogou / search_pro_quark
  webSearchSogou: 'search_pro_sogou',
  webSearchQuark: 'search_pro_quark',
  webSearchPro: 'search_pro',
  webSearchStd: 'search_std',
};

async function callZhipuRest(toolName, args) {
  const engine = ENGINE_BY_TOOL[toolName];
  if (!engine) throw new Error(`未知工具: ${toolName}`);
  const payload = {
    search_query: args.search_query,
    search_engine: engine,
    count: args.count ?? 10,
    search_domain_filter: args.search_domain_filter ?? '',
    search_recency_filter: args.search_recency_filter ?? 'noLimit',
    request_id: randomUUID(),
    user_id: 'pueblo-agent',
  };
  const resp = await fetch(ZHIPU_REST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`智谱 REST 返回 HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  const items = data.search_result || data.results || [];
  if (!items.length) return `（无搜索结果）\n${JSON.stringify(data).slice(0, 500)}`;
  return items
    .map((it, i) => {
      const title = it.title || '(无标题)';
      const url = it.url || it.link || '';
      const snippet = it.content || it.snippet || it.summary || '';
      return `${i + 1}. ${title}\n${url}\n${snippet}`.trim();
    })
    .join('\n\n');
}

// ─── 智谱工具定义（来源: 智谱 tools/list, 2026-08）────────────────────
const TOOLS = [
  {
    name: 'webSearchSogou',
    description: '搜索网络信息，返回结果包括网页标题、网页URL、网页摘要、网站名称、网站图标等。',
    inputSchema: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: '需要进行搜索的内容, 建议搜索 query 不超过 70 个字符' },
        count: { type: 'integer', description: '返回结果的条数，可选枚举值：10、20、30、40、50，默认为10' },
        search_domain_filter: { type: 'string', description: '用于限定搜索结果的范围，仅返回指定白名单域名的内容，如: www.example.com。' },
        search_recency_filter: { type: 'string', description: '搜索指定时间范围内的网页。默认为 noLimit。可填值：oneDay/oneWeek/oneMonth/oneYear/noLimit' },
        content_size: { type: 'string', description: '控制网页摘要的字数；默认值为 medium（400-600字），high（2500字）' },
      },
      required: ['search_query'],
      additionalProperties: false,
    },
  },
  {
    name: 'webSearchQuark',
    description: '搜索网络信息，返回结果包括网页标题、网页URL、网页摘要、网站名称、网站图标等。',
    inputSchema: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: '需要进行搜索的内容, 建议搜索 query 不超过 70 个字符' },
        search_recency_filter: { type: 'string', description: '搜索指定时间范围内的网页。默认为 noLimit。可填值：oneDay/oneWeek/oneMonth/oneYear/noLimit' },
        content_size: { type: 'string', description: '控制网页摘要的字数；默认值为 medium（400-600字），high（2500字）' },
      },
      required: ['search_query'],
      additionalProperties: false,
    },
  },
  {
    name: 'webSearchPro',
    description: '搜索网络信息，返回结果包括网页标题、网页URL、网页摘要、网站名称、网站图标等。',
    inputSchema: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: '需要进行搜索的内容, 建议搜索 query 不超过 70 个字符' },
        count: { type: 'integer', description: '返回结果的条数，可填范围：1-50，默认为10。' },
        search_domain_filter: { type: 'string', description: '用于限定搜索结果的范围，仅返回指定白名单域名的内容，如: www.example.com。' },
        search_recency_filter: { type: 'string', description: '搜索指定时间范围内的网页。默认为 noLimit。可填值：oneDay/oneWeek/oneMonth/oneYear/noLimit' },
        content_size: { type: 'string', description: '控制网页摘要的字数；默认值为 medium（400-600字），high（2500字）' },
      },
      required: ['search_query'],
      additionalProperties: false,
    },
  },
  {
    name: 'webSearchStd',
    description: '搜索网络信息，返回结果包括网页标题、网页URL、网页摘要、网站名称、网站图标等。',
    inputSchema: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: '需要进行搜索的内容, 建议搜索 query 不超过 70 个字符' },
        count: { type: 'integer', description: '返回结果的条数，可填范围：1-50，默认为10。' },
        search_domain_filter: { type: 'string', description: '用于限定搜索结果的范围，仅返回指定白名单域名的内容，如: www.example.com。' },
        search_recency_filter: { type: 'string', description: '搜索指定时间范围内的网页。默认为 noLimit。可填值：oneDay/oneWeek/oneMonth/oneYear/noLimit' },
        content_size: { type: 'string', description: '控制网页摘要的字数；默认值为 medium（400-600字），high（2500字）' },
      },
      required: ['search_query'],
      additionalProperties: false,
    },
  },
];

// ─── 转发到智谱 Streamable HTTP ────────────────────────────────────────
let zhipuRpcId = 0;

async function zhipuRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++zhipuRpcId, method, params });
  let resp;
  try {
    resp = await fetch(ZHIPU_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error(`无法连接智谱 MCP: ${e.message}`);
  }
  const text = await resp.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) {
    // 非 SSE 错误响应（如欠费、鉴权失败），body 即错误信息
    throw new Error(`智谱返回 HTTP ${resp.status}: ${text.trim().slice(0, 300)}`);
  }
  const msg = JSON.parse(dataLine.slice(5));
  if (msg.error) {
    throw new Error(`智谱 MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`);
  }
  return msg.result;
}

// 提取文本内容（兼容字符串 / text / resource 三种形式）
function extractText(result) {
  if (typeof result === 'string') return result;
  const content = (result && result.content) || [];
  const parts = content.map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'resource') return `[资源] ${c.resource?.uri || ''}\n${c.resource?.text || ''}`;
    return JSON.stringify(c);
  });
  return parts.join('\n\n');
}

// ─── stdio JSON-RPC 处理（与 Pueblo McpConnection 兼容）─────────────────
const rl = createInterface({ input: process.stdin });

let pending = 0;      // 进行中的请求数
let stdinEnded = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 忽略无法解析的行
  }
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) {
    return; // 通知类消息（如 notifications/initialized）无需响应
  }
  pending++;
  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        break;
      case 'ping':
        sendResult(id, {});
        break;
      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const { name, arguments: args } = params;
        if (!name) throw new Error('缺少工具名称 name');
        // Pueblo 会把工具名转成小写（如 webSearchStd → websearchstd），
        // 而智谱上游需要原始大小写，这里按不区分大小写还原为上游工具名。
        const toolDef = TOOLS.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
        const upstreamName = toolDef ? toolDef.name : name;
        const zhipuResult = await callZhipuRest(upstreamName, args || {});
        sendResult(id, {
          content: [{ type: 'text', text: extractText(zhipuResult) }],
          isError: false,
        });
        break;
      }
      default:
        sendResult(id, {});
    }
  } catch (e) {
    // 工具调用出错（如欠费）：以 isError 文本返回，便于上层展示
    sendResult(id, {
      content: [{ type: 'text', text: `[zhipu-search] ${e.message}` }],
      isError: true,
    });
  } finally {
    pending--;
    maybeExit();
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
