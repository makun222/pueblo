// verify-ark-bridge.mjs
// ---------------------------------------------------------------------------
// 以 MCP 方式验证 ark-media-bridge.mjs（与 Pueblo McpConnection 相同的 stdio 方式）：
//   1) 握手: initialize -> notifications/initialized -> ping -> tools/list
//   2) 结构性断言: 工具集精确等于 {generate_image, generate_video, query_video_task}，
//      required 参数与 schema 一致；未知工具/缺参调用返回 isError 且进程不退出
//   3) 无 ARK_API_KEY 时: 验证 generate_image 返回 §5.3 指定缺 key 提示（isError）
//   4) 有 ARK_API_KEY 时: 追加真实 E2E——
//      a. generate_image 同步真实出图（小图 1024x1024，需账户已开通 Seedream 模型）
//      b. query_video_task(不存在的 task_id) 探测 GET 路径与鉴权（预期 isError 含 "ARK HTTP"）
//      （不默认发起真实视频生成，避免计费长任务；可传 VIDEO_E2E=1 开启）
// 用法:
//   node mcp/verify-ark-bridge.mjs                  # 无 key：结构 + 缺 key 提示
//   $env:ARK_API_KEY="..."; node mcp/verify-ark-bridge.mjs   # 有 key：结构 + 真实 E2E
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, 'ark-media-bridge.mjs');
const API_KEY = process.env.ARK_API_KEY;
const VIDEO_E2E = process.env.VIDEO_E2E === '1';

// 每请求超时：图片同步 REST 内部 25s，留足余量
const REQUEST_TIMEOUT_MS = 45_000;
const EXPECTED_TOOLS = ['generate_image', 'generate_video', 'query_video_task'];

const report = {
  bridge: BRIDGE,
  keyConfigured: Boolean(API_KEY),
  videoE2E: VIDEO_E2E,
  handshake: {},
  tools: {},
  calls: {},
  stderr: '',
  failures: 0,
  overall: 'FAIL',
};

let failures = 0;
let seq = 0;

function fail(msg) {
  failures++;
  throw new Error(msg);
}

// ─── 启动 bridge 子进程（与 Pueblo McpConnection 相同的 stdio 方式）─────────
const child = spawn(process.execPath, [BRIDGE], {
  env: API_KEY ? { ...process.env, ARK_API_KEY: API_KEY } : { ...process.env, ARK_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const rl = createInterface({ input: child.stdout });
let stderrLog = '';
child.stderr.on('data', (d) => {
  stderrLog = (stderrLog + d.toString()).slice(-4000);
});

// 等待匹配 id 的响应（与 verify-zhipu-bridge 相同的已验证模式）
function waitResponse(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ error: { message: `request timeout after ${REQUEST_TIMEOUT_MS}ms (id=${id})` } }),
      REQUEST_TIMEOUT_MS
    );
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      resolve(msg.error ? { error: msg.error } : { result: msg.result });
    });
  });
}

function request(method, params) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
  return waitResponse(id);
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// 工具调用断言封装：expectError=true 时校验 isError 及错误文本片段；否则校验成功
async function callTool(name, args, { expectError = false, expectTextIncludes = [] } = {}) {
  const res = await request('tools/call', { name, arguments: args });
  const entry = { arguments: args, expectError };
  if (res.error) {
    entry.result = 'jsonrpc-error';
    entry.message = res.error.message;
    if (!expectError) fail(`tools/call ${name} 返回 jsonrpc error: ${res.error.message}`);
    return entry;
  }
  const content = res.result?.content ?? [];
  const text = content.map((c) => c.text ?? '').join('\n');
  entry.isError = Boolean(res.result?.isError);
  entry.text = text.length > 600 ? `${text.slice(0, 600)}…(截断)` : text;
  if (expectError) {
    if (!entry.isError) fail(`tools/call ${name} 应返回 isError，实际成功`);
    for (const snippet of expectTextIncludes) {
      if (!text.includes(snippet)) fail(`tools/call ${name} 错误文本应包含「${snippet}」`);
    }
  } else if (entry.isError) {
    fail(`tools/call ${name} 应成功，实际 isError: ${text}`);
  }
  report.calls[name] = entry;
  return entry;
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    // 1) 握手 + ping
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'pueblo-verify', version: '1.0.0' },
    });
    report.handshake.initialize = {
      protocolVersion: init.result?.protocolVersion,
      serverInfo: init.result?.serverInfo,
    };
    if (init.error) fail(`initialize 失败: ${init.error.message}`);
    if (init.result?.protocolVersion !== '2024-11-05') fail('initialize 协议版本应答异常');

    notify('notifications/initialized', {}); // fire-and-forget
    const pong = await request('ping', {});
    if (pong.error) fail(`ping 失败: ${pong.error.message}`);

    // 2) tools/list：工具集精确匹配
    const list = await request('tools/list', {});
    const tools = list.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    report.tools.names = names;
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      fail(`工具集不匹配，期望 ${expected.join(',')}，实际 ${names.join(',')}`);
    }
    const requiredOf = Object.fromEntries(
      tools.map((t) => [t.name, t.inputSchema?.required ?? []])
    );
    report.tools.required = requiredOf;
    if (JSON.stringify(requiredOf.generate_image?.sort()) !== JSON.stringify(['prompt']))
      fail('generate_image 的 required 应为 ["prompt"]');
    if (JSON.stringify(requiredOf.generate_video?.sort()) !== JSON.stringify(['prompt']))
      fail('generate_video 的 required 应为 ["prompt"]');
    if (JSON.stringify(requiredOf.query_video_task?.sort()) !== JSON.stringify(['task_id']))
      fail('query_video_task 的 required 应为 ["task_id"]');

    // 3) 结构性错误处理（无需 key，也不触发上游调用）
    await callTool('query_video_task', {}, { expectError: true, expectTextIncludes: ['缺少必填参数 task_id'] });
    await callTool('no_such_tool', { prompt: 'x' }, { expectError: true, expectTextIncludes: ['未知工具'] });

    // 4) key 行为分支
    if (!API_KEY) {
      const missing = await callTool('generate_image', { prompt: 'x' }, {
        expectError: true,
        expectTextIncludes: ['未配置 ARK_API_KEY'],
      });
      report.calls.generate_image_no_key = missing;
    } else {
      // E2E-a：真实同步出图（小图）
      const img = await callTool('generate_image', {
        prompt: '一只橘猫坐在窗台上看夕阳，照片风格',
        size: '1024x1024',
      });
      try {
        const parsed = JSON.parse(img.text ?? '');
        const url = parsed.image_url ?? parsed.image_urls?.[0];
        report.calls.generate_image.url = typeof url === 'string' ? url.slice(0, 120) : url;
        if (!url) fail('generate_image 返回中未找到 image_url');
      } catch (e) {
        fail(`generate_image 返回不是可解析 JSON: ${e.message}`);
      }

      // E2E-b：GET 路径 + 鉴权探测（不存在的任务 → 预期 404/401 类 isError，不产生计费）
      const probe = await callTool('query_video_task', { task_id: 'cgt-no-such-task-0000' }, {
        expectError: true,
        expectTextIncludes: ['ARK HTTP'],
      });
      report.calls.query_video_task_probe = probe;

      // E2E-c（可选）：真实视频任务提交+轮询（计费，默认关闭）
      if (VIDEO_E2E) {
        const sub = await callTool('generate_video', {
          prompt: '一只橘猫从窗台跳下，慢动作',
        });
        const taskId = sub.text ? JSON.parse(sub.text).task_id : null;
        if (!taskId) fail('generate_video 未返回 task_id');
        await new Promise((r) => setTimeout(r, 3000));
        const q = await callTool('query_video_task', { task_id: taskId });
        report.calls.generate_video = { submitted: true, taskId, poll: q.text?.slice(0, 300) };
      }
    }
  } catch (e) {
    failures++;
    report.error = e.message;
  } finally {
    // 关闭通道并等待子进程自然退出（bridge 在 stdin 结束后 maybeExit）
    try { rl.close(); child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }
  report.stderr = stderrLog.trim();
  report.failures = failures;
  report.overall = failures === 0 ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(report, null, 2));
  process.exit(failures === 0 ? 0 : 1);
})();
