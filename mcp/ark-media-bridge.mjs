// ark-media-bridge.mjs
// ---------------------------------------------------------------------------
// 火山方舟（Volcengine ARK）媒体生成 MCP 的本地 stdio 桥接器（路径 B 原型）
// Pueblo 只支持 stdio 型 MCP server（spawn command + args），不支持远程 SSE/HTTP。
// 本脚本以 stdio 方式向 Pueblo 提供 MCP 服务，内部通过 REST (fetch, node>=18 内置)
// 转发到火山方舟两条媒体生成接口：
//   - 图片生成（同步）      POST /api/v3/images/generations
//   - 视频生成（异步任务）  POST   /api/v3/contents/generations/tasks
//                           GET    /api/v3/contents/generations/tasks/{id}
//
// 用法: node mcp/ark-media-bridge.mjs
// 环境变量: ARK_API_KEY（可选；缺失时不退出，tools/call 时返回 isError 提示，
//           与 zhipu-search-bridge「启动即退出」策略不同，见调研报告 §5.3）
// 规格依据: agent-*/ark-media-generation-mcp-research.md §5（实现细节/工具集/超时/错误处理）
// ---------------------------------------------------------------------------
import { createInterface } from 'node:readline';

const API_KEY = process.env.ARK_API_KEY;
if (!API_KEY) {
  console.error('[ark-media-bridge] 警告：缺少环境变量 ARK_API_KEY，工具可列出但调用将失败。');
  console.error('[ark-media-bridge] 请设置环境变量后重启，或在 pueblo MCP 设置中保存凭据：');
  console.error('[ark-media-bridge]   Windows PowerShell: $env:ARK_API_KEY="your-api-key"');
  console.error('[ark-media-bridge]   Linux/macOS:        export ARK_API_KEY=your-api-key');
}
// 上游：火山方舟 REST API（主报告《ark-media-generation-research.md》§4 实现依据）
const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const SERVER_INFO = {
  name: 'ark-media-bridge',
  version: '0.1.0',
};

// 默认模型（火山方舟 REST 只识别带日期版本号的全 ID；
// 2026-09-01 实测：别名 doubao-seedream-5-0-pro 返回 404 "model does not exist"，
// 而 doubao-seedream-5-0-pro-260628 返回 404 "account has not activated the model"——
// 即 model id 格式无误，报错根因是账号未在方舟控制台开通该模型服务）
const DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';
const DEFAULT_VIDEO_MODEL = 'doubao-seedance-2-5-260628';

// 视频任务生命周期（内存态，单会话内有效；§5.3：taskId 跨会话不可恢复，如需可落盘 .pueblo/）
const videoTasks = new Map(); // taskId -> { model, createdAt, status }

// 内部超时（§5.3）：generate_image 同步 REST 逼近 pueblo 30s 硬上限，设 25s 兜底；
// 视频提交/查询均秒级，设 15s 即可。
const IMAGE_TIMEOUT_MS = 25_000;
const TASK_TIMEOUT_MS = 15_000;

// ─── 工具集（全部 snake_case，规避 pueblo 工具名小写化问题；§5.3）──────────
const TOOLS = [
  {
    name: 'generate_image',
    description:
      '调用火山方舟 Seedream 文生图/图生图/组图（同步 REST）。返回图片公网 URL（image_url / image_urls）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词（≤300 汉字）' },
        model: { type: 'string', description: `模型 ID，默认 ${DEFAULT_IMAGE_MODEL}` },
        size: { type: 'string', description: '图片尺寸，如 1024x1024 / 2048x2048' },
        n: { type: 'integer', description: '生成数量（>1 时走组图 sequential_image_generation）' },
        image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图公网 URL 列表（图生图；需公网可访问）',
        },
        watermark: { type: 'boolean', description: '是否带水印' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_video',
    description:
      '提交火山方舟 Seedance 视频生成任务（异步，返回 task_id）。完成后用 query_video_task 轮询（建议间隔 10s）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词' },
        model: { type: 'string', description: `模型 ID，默认 ${DEFAULT_VIDEO_MODEL}` },
        resolution: {
          type: 'string',
          enum: ['480p', '720p', '1080p'],
          description: '分辨率（规格兼容字段；实际分辨率以任务结果为准）',
        },
        duration: { type: 'number', description: '视频时长（秒），如 5 / 10，范围 4~30' },
        ratio: { type: 'string', description: '画幅比例，如 16:9 / 9:16 / 1:1' },
        seed: { type: 'integer', description: '随机种子（规格兼容字段；结果种子以任务结果为准）' },
        image_url: { type: 'string', description: '参考图公网 URL（图生视频）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_video_task',
    description:
      '查询视频生成任务状态（queued/running/succeeded/failed）。succeeded 时返回 video_url，failed 时返回 error。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'generate_video 返回的任务 ID（cgt-...）' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
];

// ─── ARK REST 调用层（fetch，零第三方依赖）────────────────────────────────

function requireKey() {
  if (!API_KEY) {
    throw new Error(
      '未配置 ARK_API_KEY：请在 pueblo MCP 设置中保存凭据（serverId=ark_media）或设置环境变量后重启'
    );
  }
}

// 通用 POST（JSON）→ 解析 JSON；非 2xx 归一化为可读错误
async function postJson(path, payload, timeoutMs) {
  requireKey();
  let resp;
  try {
    resp = await fetch(`${ARK_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error('上游请求超时');
    }
    throw new Error(`无法连接火山方舟 API: ${e.message}`);
  }
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const upstreamMsg = data?.error?.message || data?.message || data?.raw || JSON.stringify(data);
    throw new Error(`ARK HTTP ${resp.status}: ${upstreamMsg}`);
  }
  return data;
}

// 通用 GET → 解析 JSON；非 2xx 归一化为可读错误
async function getJson(path, timeoutMs) {
  requireKey();
  let resp;
  try {
    resp = await fetch(`${ARK_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error('上游请求超时');
    }
    throw new Error(`无法连接火山方舟 API: ${e.message}`);
  }
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const upstreamMsg = data?.error?.message || data?.message || data?.raw || JSON.stringify(data);
    throw new Error(`ARK HTTP ${resp.status}: ${upstreamMsg}`);
  }
  return data;
}

// generate_image: POST /images/generations（同步；25s 内部超时）
async function callGenerateImage(args) {
  const { prompt, model, size, n, image_urls, watermark } = args;
  const payload = {
    model: model || DEFAULT_IMAGE_MODEL,
    prompt,
    response_format: 'url', // 强制返回 URL，bridge 保持无状态（§5.3 产物处理）
  };
  if (size) payload.size = size;
  if (watermark !== undefined) payload.watermark = watermark;
  if (image_urls && image_urls.length > 0) {
    // ARK 的 image 字段接受单个 URL 或 URL 数组（多图参考）
    payload.image = image_urls.length === 1 ? image_urls[0] : image_urls;
  }
  const count = n ?? 1;
  if (count > 1) {
    // 组图：模型自动编排多图（官方 sequential_image_generation + max_images）
    payload.sequential_image_generation = 'auto';
    payload.sequential_image_generation_options = { max_images: count };
  }

  const data = await postJson('/images/generations', payload, IMAGE_TIMEOUT_MS);
  const images = data?.data?.images || [];
  const urls = images.map((img) => img.url).filter(Boolean);
  if (urls.length === 0) {
    throw new Error('ARK 返回成功但无图片 URL（可能需要开启 response_format=url）');
  }
  return { image_url: urls[0], image_urls: urls };
}

// generate_video: POST /contents/generations/tasks（异步提交，秒级响应）
async function callGenerateVideo(args) {
  const { prompt, model, duration, ratio, image_url, watermark } = args;
  const content = [{ type: 'text', text: prompt }];
  if (image_url) {
    content.push({ type: 'image_url', image_url: { url: image_url } });
  }
  const payload = {
    model: model || DEFAULT_VIDEO_MODEL,
    content,
    generate_audio: false,
  };
  if (duration !== undefined) payload.duration = duration;
  if (ratio) payload.ratio = ratio;
  if (watermark !== undefined) payload.watermark = watermark;
  // 注：resolution / seed 为规格兼容入参，ARK 创建接口未官方文档化这两个字段
  //（查询接口会返回实际 resolution / seed），故不入请求体。

  const data = await postJson('/contents/generations/tasks', payload, TASK_TIMEOUT_MS);
  const taskId = data?.id;
  if (!taskId) {
    throw new Error(`ARK 未返回任务 ID: ${JSON.stringify(data)}`);
  }
  videoTasks.set(taskId, { model: payload.model, createdAt: Date.now(), status: 'queued' });
  return { task_id: taskId, status: 'queued' };
}

// query_video_task: GET /contents/generations/tasks/{id}
async function callQueryVideoTask(taskId) {
  const data = await getJson(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, TASK_TIMEOUT_MS);
  const status = data?.status || 'unknown';
  const rec = videoTasks.get(taskId);
  if (rec) rec.status = status;

  const result = { task_id: taskId, status };
  const videoUrl = data?.content?.video_url;
  if (status === 'succeeded' && videoUrl) {
    result.video_url = videoUrl;
  }
  if (status === 'failed') {
    result.error = data?.error?.message || data?.error || '视频生成失败';
  }
  // 透传查询返回的有用元数据（非破坏性扩展）
  for (const key of ['resolution', 'ratio', 'duration', 'framespersecond', 'seed']) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  return result;
}

// 工具分发（不区分大小写还原工具名，规避 pueblo 小写化；同 zhipu 模板 242 行注释）
async function callArkTool(name, args) {
  const toolDef = TOOLS.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  if (!toolDef) throw new Error(`未知工具: ${name}`);
  switch (toolDef.name) {
    case 'generate_image':
      return callGenerateImage(args || {});
    case 'generate_video':
      return callGenerateVideo(args || {});
    case 'query_video_task': {
      const taskId = args?.task_id;
      if (!taskId) throw new Error('缺少必填参数 task_id');
      return callQueryVideoTask(taskId);
    }
    default:
      throw new Error(`未实现的工具: ${toolDef.name}`);
  }
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
  const { id, method, params } = msg;
  if (id === undefined) {
    return; // 通知类消息（含 notifications/initialized）直接忽略
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
        const { name } = params || {};
        if (!name) throw new Error('缺少工具名称 name');
        const result = await callArkTool(name, params.arguments);
        sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        break;
      }
      default:
        // 未知方法：按协议返回空结果，避免 pueblo 等待超时
        sendResult(id, {});
    }
  } catch (e) {
    // 所有上游错误（401/429/模型未开通/参数校验/超时）统一 isError 文本返回，
    // bridge 进程永不 crash（§5.3 错误处理）
    console.error(`[ark-media-bridge] ${e.stack || e.message}`);
    sendResult(id, {
      content: [{ type: 'text', text: `[ark-media] ${e.message}` }],
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
