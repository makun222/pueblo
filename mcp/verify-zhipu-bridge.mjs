// verify-zhipu-bridge.mjs
// ---------------------------------------------------------------------------
// 以 MCP 方式验证 zhipu-search-bridge.mjs：
//   1) 以 stdio 子进程方式启动桥接器（与 Pueblo McpConnection 相同的方式）
//   2) 完成 MCP 握手：initialize -> notifications/initialized -> tools/list
//   3) 依次调用四个工具（sogou/quark/pro/std），验证四种搜索引擎
//   4) 输出结构化报告，退出码非 0 表示存在失败项
// 用法: node verify-zhipu-bridge.mjs [query]
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'zhipu-search-bridge.mjs');
const QUERY = process.argv[2] || '人工智能最新进展';
const COUNT = 3;

if (!process.env.ZHIPU_API_KEY) {
  console.error('[verify] 错误：缺少环境变量 ZHIPU_API_KEY');
  process.exit(2);
}

// ─── 启动桥接器（stdio MCP server）────────────────────────────────────
const child = spawn(process.execPath, [BRIDGE], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const rl = createInterface({ input: child.stdout });
const stderrLog = [];
child.stderr.on('data', (d) => stderrLog.push(d.toString().trim()));

// 等待匹配 id 的响应；超时保护
function waitResponse(id, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待响应超时 (id=${id})`)), timeoutMs);
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) reject(new Error(`MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
  });
}

let seq = 0;
function request(method, params) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return waitResponse(id);
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const report = { handshake: {}, tools: {}, engines: {} };
let failures = 0;

try {
  // ─── 1. initialize ──────────────────────────────────────────────────
  const t0 = Date.now();
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pueblo-verify-client', version: '1.0.0' },
  });
  report.handshake.initialize = {
    ok: true,
    server: `${init.serverInfo?.name}@${init.serverInfo?.version}`,
    protocolVersion: init.protocolVersion,
    ms: Date.now() - t0,
  };
  notify('notifications/initialized', {});
  report.handshake.initialized = { ok: true };

  // ─── 2. tools/list ─────────────────────────────────────────────────
  const tools = await request('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  report.tools = { count: names.length, names };
  const EXPECTED = ['webSearchSogou', 'webSearchQuark', 'webSearchPro', 'webSearchStd'];
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) {
    failures++;
    report.tools.missing = missing;
  }

  // ─── 3. 四种引擎依次调用 ───────────────────────────────────────────
  for (const name of EXPECTED) {
    const engine = {
      webSearchSogou: 'search_sogou',
      webSearchQuark: 'search_quark',
      webSearchPro: 'search_pro',
      webSearchStd: 'search_std',
    }[name];
    const t1 = Date.now();
    try {
      const res = await request('tools/call', {
        name,
        arguments: { search_query: QUERY, count: COUNT },
      });
      const text = (res.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const lines = text.split('\n').filter(Boolean);
      const titleCount = lines.filter((l) => /^\d+\.\s/.test(l)).length;
      const firstTitle = lines.find((l) => /^\d+\.\s/.test(l)) || '(空)';
      const isError = res.isError === true || /错误|失败|exception/i.test(text.slice(0, 200));
      report.engines[engine] = {
        tool: name,
        ok: titleCount > 0 && !isError,
        resultCount: titleCount,
        firstResult: firstTitle.slice(0, 80),
        ms: Date.now() - t1,
        rawPreview: text.slice(0, 200).replace(/\n/g, ' | '),
      };
      if (report.engines[engine].ok === false) failures++;
    } catch (e) {
      failures++;
      report.engines[engine] = { tool: name, ok: false, error: e.message };
    }
  }
} catch (e) {
  failures++;
  report.handshake.error = e.message;
} finally {
  try { child.stdin.end(); } catch {}
}

const exit = await new Promise((resolve) => {
  const t = setTimeout(() => { try { child.kill(); } catch {} resolve('timeout'); }, 5000);
  child.on('exit', (code) => { clearTimeout(t); resolve(code); });
});
report.exit = { code: exit };
report.stderr = stderrLog;
report.failures = failures;
report.overall = failures === 0 ? 'PASS' : 'FAIL';

console.log(JSON.stringify(report, null, 2));
process.exit(failures === 0 ? 0 : 1);
