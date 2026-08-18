#!/usr/bin/env node
/**
 * finance-news MCP Bridge 冒烟测试
 * 依次执行: initialize -> initialized -> tools/list -> tools/call(us) -> tools/call(cn)
 * 用法: node smoke-test.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(__dirname, "finance-news-bridge.mjs");

const child = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buf = "";
let nextId = 0;

function call(method, params) {
  const id = ++nextId;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return p;
}

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  console.log(`[1/4] initialize  -> ${init.serverInfo.name} v${init.serverInfo.version} (${init.protocolVersion})`);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await call("tools/list", {});
  console.log(`[2/4] tools/list  -> ${list.tools.length} tool(s): ${list.tools.map((t) => t.name).join(", ")}`);

  console.log("[3/4] tools/call  (us, ticker=AAPL, num=3) ...");
  const us = await call("tools/call", {
    arguments: { ticker: "AAPL", region: "us", num: 3 },
  });
  const usText = us.content[0].text;
  console.log(`      -> isError=${!!us.isError}, ${usText.split("\n").length} 行输出`);
  console.log(usText.slice(0, 400) + (usText.length > 400 ? "\n      ..." : ""));

  console.log("[4/4] tools/call  (cn, query=汽车, num=3) ...");
  const cn = await call("tools/call", {
    arguments: { region: "cn", query: "汽车", num: 3 },
  });
  const cnText = cn.content[0].text;
  console.log(`      -> isError=${!!cn.isError}, ${cnText.split("\n").length} 行输出`);
  console.log(cnText.slice(0, 400) + (cnText.length > 400 ? "\n      ..." : ""));

  if (us.isError || cn.isError) {
    console.log("\n❌ 冒烟测试存在失败项");
    process.exit(1);
  }
  console.log("\n✅ 冒烟测试全部通过");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 冒烟测试失败:", e.message);
  process.exit(1);
});
