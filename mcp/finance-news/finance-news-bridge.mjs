#!/usr/bin/env node
/**
 * finance-news MCP Bridge (stdio)
 * ---------------------------------------------
 * 将 finance_news.py（国外 Finnhub 个股新闻 + 国内新浪/东财快讯）
 * 包装为 MCP 工具，供任意指向本仓库的 Pueblo/Claude 终端调用。
 *
 * 启动方式（由 .pueblo/mcp-servers.json 配置加载）:
 *   node <本文件路径>
 *
 * 手动冒烟测试:
 *   node smoke-test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(__dirname, "finance_news.py");

const SERVER_INFO = { name: "finance-news", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOL = {
  name: "fetch_finance_news",
  description:
    "通用金融资讯检索：国外源用 Finnhub 免费接口查美股个股新闻，" +
    "国内源用新浪财经/东方财富滚动快讯（均免费、无需 Key）。" +
    "返回带时间、来源、摘要与原文链接的资讯列表。",
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "美股代码（仅国外源生效），如 AAPL / MSFT / TSLA，默认 AAPL",
      },
      region: {
        type: "string",
        enum: ["us", "cn", "all"],
        description: "us=国外 Finnhub；cn=国内新浪+东财；all=国内外一起",
      },
      query: {
        type: "string",
        description: "关键词过滤（仅国内源生效），如：银行 / 央行 / 新能源",
      },
      num: {
        type: "integer",
        description: "每个源输出条数，默认 10",
      },
      days: {
        type: "integer",
        description: "国外源回溯天数，默认 7",
      },
    },
  },
};

/** 在当前环境里找到一个可用的 python 解释器 */
function findPython() {
  for (const cmd of ["python", "py", "python3"]) {
    try {
      const r = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 8000 });
      if (r.status === 0) return cmd;
    } catch {
      /* try next */
    }
  }
  return "python";
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** 运行 python 脚本并收集输出 */
function runScript(args) {
  return new Promise((resolve) => {
    const py = findPython();
    const child = spawn(py, [PY_SCRIPT, ...args], {
      cwd: __dirname, // 保证脚本能读到同目录 .env
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      resolve({ ok: false, text: `无法启动 Python: ${e.message}\n请确认已安装 Python 并在 PATH 中。` })
    );
    child.on("close", (code) => {
      const ok = code === 0;
      resolve({
        ok,
        text: ok ? out.trim() : `脚本退出码 ${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`.trim(),
      });
    });
  });
}

async function handleCall(params) {
  const args = [];
  const region = params.region ?? "us";
  const num = params.num ?? 10;
  const days = params.days ?? 7;
  const query = params.query ?? "";

  if (region === "cn") {
    args.push("--region", "cn");
    if (query) args.push("--query", query);
  } else if (region === "all") {
    args.push("--region", "all");
    if (query) args.push("--query", query);
  } else {
    // us：国外源，必须给 ticker
    args.push(params.ticker || "AAPL");
    args.push("--num", String(num));
    args.push("--days", String(days));
  }
  if (region !== "us") {
    args.push("--num", String(num));
    args.push("--days", String(days));
  }
  return runScript(args);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
    return;
  }

  const { id, method, params } = msg;

  // 通知类消息不回复
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;

  const respond = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "ping":
      respond({});
      break;
    case "tools/list":
      respond({ tools: [TOOL] });
      break;
    case "tools/call":
      try {
        const r = await handleCall(params?.arguments ?? {});
        respond({
          content: [{ type: "text", text: r.text }],
          ...(r.ok ? {} : { isError: true }),
        });
      } catch (e) {
        fail(-32603, `执行失败: ${e.message}`);
      }
      break;
    default:
      fail(-32601, `Method not found: ${method}`);
  }
});

rl.on("close", () => process.exit(0));
