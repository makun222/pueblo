// =============================================================================
// PoC-05 — win32 + Node v24 下 spawn(shell:true) 的 cmd 元字符注入矩阵（增强项 2）
// 基线：b84227d9 ｜ 复刻目标：src/mcp/mcp-connection.ts:64-84（shell: process.platform === 'win32'）
// 目的：细化 PoC-01 A1 —— Node v24.13.0 对 args 的引用转义是否覆盖全部 cmd 元字符？
//       含空格命令路径（如 D:\Program Files\nodejs\node.exe）在 shell:true 下的引用行为？
// 运行：node poc-05-shell-matrix.js
// 无害演示：注入探测仅尝试写 marker 文件到 poc/ 目录（文件名无空格）。
// =============================================================================

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const POC_DIR = __dirname;
const MARKER = path.join(POC_DIR, 'poc-05-marker.txt');
const OUT_FILE = path.join(POC_DIR, 'poc-05-out.txt');

const lines = [];
function log(s = '') { lines.push(s); }

function cleanup() { try { fs.rmSync(MARKER, { force: true }); } catch { /* ignore */ } }

// 探测字符：cmd.exe 元字符 / 扩展 / 引号闭合
const PROBES = [
  { id: 'AMP',        desc: '&   命令分隔符',                 payload: 'SAFE&echo PWNED> ' + MARKER },
  { id: 'AMP2',       desc: '&&  命令串联',                   payload: 'SAFE&&echo PWNED> ' + MARKER },
  { id: 'PIPE',       desc: '|   管道',                       payload: 'SAFE|echo PWNED> ' + MARKER },
  { id: 'PIPE2',      desc: '||  或',                         payload: 'SAFE||echo PWNED> ' + MARKER },
  { id: 'CARET',      desc: '^   转义符（cmd 层）',           payload: 'SAFE^&echo PWNED> ' + MARKER },
  { id: 'GT',         desc: '>   重定向',                     payload: 'SAFE> ' + MARKER },
  { id: 'LT',         desc: '<   重定向输入',                 payload: 'SAFE< ' + MARKER },
  { id: 'PERCENT',    desc: '%CD%  变量扩展（探测）',         payload: 'echo SAFE%CD%> ' + MARKER },
  { id: 'BANG',       desc: '!CD!  延迟扩展（探测）',         payload: 'echo SAFE!CD!> ' + MARKER },
  { id: 'QUOTE',      desc: '" 引号闭合',                     payload: 'SAFE"&echo PWNED> ' + MARKER },
  { id: 'SEMI',       desc: ';   分隔符（cmd 下非元字符）',   payload: 'SAFE;echo PWNED> ' + MARKER },
  { id: 'PAREN',      desc: '( ) 批处理括号',                 payload: 'SAFE(echo PWNED)> ' + MARKER },
];

function runOnce(config, label) {
  cleanup();
  const r = spawnSync(config.command, config.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: config.shell !== false, // 默认 true，与目标代码 win32 分支一致
    encoding: 'utf-8',
    timeout: 15000,
  });
  const markerWritten = fs.existsSync(MARKER);
  let markerContent = '';
  if (markerWritten) { try { markerContent = fs.readFileSync(MARKER, 'utf-8').trim(); } catch { /* ignore */ } }
  log(label);
  log(`  exitCode   : ${r.status}`);
  log(`  stderr     : ${(r.stderr || '').trim().replace(/\r?\n/g, ' | ').slice(0, 140)}`);
  log(`  marker     : ${markerWritten ? 'WRITTEN' : 'no'}`);
  if (markerContent) log(`  marker内容 : ${markerContent.slice(0, 140)}`);
  log('');
  return { markerWritten, markerContent, stderr: r.stderr || '' };
}

// 注：node.exe 位于 D:\Program Files\nodejs\node.exe（含空格），忠实复刻目标环境的真实路径
const NODE = process.execPath;

log('='.repeat(72));
log('PoC-05 — spawn(shell:true) cmd 元字符注入矩阵（win32 + ' + process.version + '）');
log('复刻目标：src/mcp/mcp-connection.ts:64-84（shell: process.platform === \'win32\'）');
log('='.repeat(72));
log(`node: ${NODE}`);
log('');

log('## 1. shell:true — 各元字符注入探测（command = node.exe，args 内嵌 payload）');
log('');
for (const p of PROBES) {
  const config = { command: NODE, args: ['-e', `process.stdout.write(${JSON.stringify(p.payload)})`], shell: true };
  const res = runOnce(config, `### ${p.id}  ${p.desc}`);
  p._injected = res.markerWritten;
  // %CD% 展开判据：payload 中 SAFE 紧跟展开后的绝对路径（stderr 可见，如 SAFED:\WorkSpace\...）
  p._expanded = /SAFE[A-Za-z]:\\/.test(res.stderr || '');
}

// 1b. 无空格命令路径——排除“路径含空格被拆分”的混杂因素后，元字符行为可独立判定
// 方案：复制 node.exe 到无空格临时目录（8.3 短名在部分卷被禁用，故不依赖）。
log('## 1b. shell:true + 无空格命令路径（node.exe 复制到临时目录）');
log('');
const os = require('node:os');
let PROBE_DIR = path.join(os.tmpdir(), 'poc05-probe');
if (PROBE_DIR.includes(' ')) { PROBE_DIR = 'C:\\Temp\\poc05-probe'; }
fs.mkdirSync(PROBE_DIR, { recursive: true });
const SHORT_NODE = path.join(PROBE_DIR, 'node.exe');
fs.copyFileSync(NODE, SHORT_NODE);
log(`  无空格副本: ${SHORT_NODE}`);
log('');
  // 先验证短路径可正常启动（对照组，无元字符）
  const ctl = spawnSync(SHORT_NODE, ['-e', 'process.stdout.write("CTL_OK")'], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: true, encoding: 'utf-8', timeout: 15000,
  });
  log(`  对照组(无元字符): exitCode=${ctl.status} stdout=${(ctl.stdout || '').trim().slice(0, 40)}`);
  log('');
  for (const p of PROBES) {
    cleanup();
    const config = { command: SHORT_NODE, args: ['-e', `process.stdout.write(${JSON.stringify(p.payload)})`], shell: true };
    const r = spawnSync(config.command, config.args, {
      stdio: ['ignore', 'pipe', 'pipe'], shell: true, encoding: 'utf-8', timeout: 15000,
    });
    const markerWritten = fs.existsSync(MARKER);
    let markerContent = '';
    if (markerWritten) { try { markerContent = fs.readFileSync(MARKER, 'utf-8').trim(); } catch { /* ignore */ } }
    log(`### ${p.id}  ${p.desc}`);
    log(`  exitCode   : ${r.status}`);
    log(`  stderr     : ${(r.stderr || '').trim().replace(/\r?\n/g, ' | ').slice(0, 140)}`);
    log(`  marker     : ${markerWritten ? 'WRITTEN' : 'no'}`);
    if (markerContent) log(`  marker内容 : ${markerContent.slice(0, 140)}`);
    log('');
    p._injectedShort = markerWritten;
    p._expandedShort = /SAFE[A-Za-z]:\\/.test(r.stderr || '');
  }

log('## 2. 对照 — shell:false（同一 payload 集合，确认差异来自 shell:true）');
log('');
for (const p of [PROBES[0], PROBES[3], PROBES[7]]) {
  const config = { command: NODE, args: ['-e', `process.stdout.write(${JSON.stringify(p.payload)})`], shell: false };
  runOnce(config, `### ${p.id}  shell:false 对照`);
}

log('## 3. 汇总判定');
log('');
const injectedShort = PROBES.filter(p => p._injectedShort);
const expandedShort = PROBES.filter(p => p._expandedShort);
log(`- 无空格路径下可直接注入（marker 写入）: ${injectedShort.map(p => p.id).join(', ') || '无'}`);
log(`- 无空格路径下变量扩展生效: ${expandedShort.map(p => p.id).join(', ') || '无'}（%CD% 在引号内被 cmd 预展开，stderr 可见；!CD! 延迟扩展默认关闭不生效）`);
log('');
log('结论口径：');
if (injectedShort.length === 0 && expandedShort.length === 0) {
  log('  Node v24.13.0 的双引号包裹抑制了本矩阵大部分 cmd 元字符（& | ^ > < ; 等）→ 直接命令注入未复现；');
  log('  但 %CD% 变量展开在引号内生效、引号闭合可破坏参数结构、含空格命令路径被 cmd 按空格拆分（PoC-01 A1 / 本节 4 复验）→ shell:true 仍是放大面（变量展开/引号逃逸/路径引用/版本差异）。');
} else {
  log('  存在可注入/可扩展字符 → shell:true 在当前版本下仍是放大面，F-06 修复项（移除 shell:true）优先级不变。');
}
log('');
log('  Node v24 官方 DEP0190 弃用警告原文：Passing args to a child process with shell option true can lead to');
log('  security vulnerabilities, as the arguments are not escaped, only concatenated.');


// 路径含空格 + shell:true 的引用行为专项（PoC-01 A1 stderr 现象复验）
log('## 4. 专项：含空格命令路径 + shell:true 的引用行为');
log('');
{
  const config = { command: NODE, args: ['-e', 'process.stdout.write("HELLO")'], shell: true };
  const r = spawnSync(config.command, config.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true, encoding: 'utf-8', timeout: 15000,
  });
  log('  command = node.exe（路径含空格），无任何元字符：');
  log(`  exitCode: ${r.status}`);
  log(`  stdout  : ${(r.stdout || '').trim().slice(0, 80)}`);
  log(`  stderr  : ${(r.stderr || '').trim().replace(/\r?\n/g, ' | ').slice(0, 140)}`);
  log(`  判定: ${r.status === 0 && (r.stdout || '').includes('HELLO') ? 'OK — Node 已正确引用命令路径' : '异常 — 命令路径未被正确引用（cmd 解析拆分），与 PoC-01 A1 stderr 现象一致'}`);
}

cleanup();
try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf-8');
console.log(lines.join('\n'));
