# Phase 3 人工审计记录 — 第一批（命令执行 / 渲染层 / 凭据 / 文件护栏）

- 日期：2026-08-29 ｜ 基线：`b84227d9971dfd77c57551590d651439408afe43`
- 审计范围：`desktop/main/window.ts`、`tools/exec-tool.ts`、`tools/shell-exec-tool.ts`、`mcp/mcp-connection.ts`、`providers/credential-store.ts`、`tools/file-guard.ts`
- 方法：逐文件通读 + 交叉验证 semgrep 命中（F-02/F-03）+ IPC 链路追查（mcp-ipc → mcp-client → mcp-connection）

## 发现清单（新增/升级）

### F-06（High，CWE-78/CWE-88）MCP 服务器 spawn 在 Windows 开启 shell 且命令/参数完全来自配置
- 位置：`mcp/mcp-connection.ts:80-84`
- 证据：`spawn(config.command, config.args, { env, stdio: [...], shell: process.platform === 'win32' })`
- 分析：
  1. **Windows 平台 `shell: true`** → `config.args` 含 `& | > ; \n` 等特殊字符时可注入额外命令；semgrep 字面量规则未命中（条件表达式），人工审计发现。
  2. `config.command` 为任意可执行文件路径（来自 MCP 配置）。
  3. 与 F-01 叠加形成完整利用链：**Renderer XSS/沦陷 → `mcp:add-server`（无校验）→ spawn 任意命令 → RCE**。
- 修复建议：Windows 下改为 `shell: false` + 参数数组直传（stdio 协议无需 shell）；对 `config.command` 做白名单（npm/npx/可执行目录）；对 config 做 schema 校验与来源限制。

### F-07（Medium，CWE-522）MCP 子进程继承父进程全部环境变量
- 位置：`mcp/mcp-connection.ts:64-72`
- 证据：`env = {...config.env}` 后 `for (key of Object.keys(parentEnv)) env[key] = parentEnv[key]`（除非 key 已被 config.env 覆盖）
- 分析：MCP 服务器子进程可见父进程 env 中所有变量；若运行环境把 API Key/令牌放进 env（而非 Credential Manager），则被恶意/被攻破的 MCP 服务器读取。注释自述该 env 用于 "API key injections"（bydesign 注入），但未做最小化。
- 修复建议：env 白名单注入（仅允许 `config.env` + 少量固定变量）；密钥优先走凭据存储而非 env。

### F-03（Medium，CWE-78）命令执行工具审计结论（exec-tool / shell-exec-tool）
- `tools/exec-tool.ts:39` `execFile(command, args, { shell: false })` ✅ 基础姿势正确；但：
  - `splitCommand`（line 21-24）自研解析器正则 `/(?:[^\s"']+|"[^"]*"|'[^']*')+/g`：不支持转义引号（`"a\"b"` 错拆）、`""` 空参数丢失、Windows 路径含空格必须引号 → 边界用例需 Phase 4 fuzz。
  - `cwd: request.cwd` 无白名单；env 无白名单（继承父进程）。
- `tools/shell-exec-tool.ts:53` `execFile('cmd.exe'|'powershell.exe', ['/c'|'-Command', request.command])`：整串命令交给 shell 解释（管道/重定向/`&&` 生效）——**语义即任意命令**，by-design；因此审批门（respond-tool-approval）不可绕过是硬要求。
- 结论：两工具安全边界**完全依赖 Agent 层审批门**；审批门若有缺口（见 F-01 待验证项）即 RCE。

### F-08（High，待 Phase 4 实证，CWE-22）写路径无护栏
- 位置：`tools/file-guard.ts`（全文件）+ `tools/write-tool.ts` / `tools/edit-tool.ts`
- 证据：`file-guard.ts` 仅提供 `checkFileReadable`（扩展名黑名单/大小/二进制探测），**无任何路径解析与允许根校验**；`write-tool.ts` 全文 grep `resolve|normalize|startsWith|realpath|allowedRoot|checkFileReadable` 为**空** → 写路径校验缺失或极弱。
- 影响：LLM 可控 cwd/路径时可写任意文件（含覆盖配置/凭据文件）；与 F-03 叠加可落地持久化后门。
- 下一步：Phase 3 第二批通读 write-tool/edit-tool 全文确认；Phase 4 以路径穿越 PoC 实证。

### F-02（Medium，Electron Checklist）5 个 BrowserWindow 缺 `sandbox: true`
- 位置：`window.ts:11`、`instant-notes-window.ts:72`、`clock-window.ts:21`、`monitor-window.ts:35`、`mcp-manager-window.ts:18`
- 证据：semgrep×5；`window.ts` 通读确认 `nodeIntegration:false` ✅、`contextIsolation:true` ✅，但无 sandbox → preload 拥有完整 Node 权限。
- 附带：`window.ts:20` dev 模式 `loadURL('http://localhost:5173')` → 本机端口劫持面（生产为 `loadFile` ✅）。
- 修复建议：全部窗口加 `sandbox: true`；dev 模式校验 origin（`win.webContents.on('did-navigate', ...)` 校验 URL 白名单）。

## 正向结论（安全姿势良好）

### credential-store.ts ✅
- Windows：PowerShell `Add-Type` 调用 Win32 `CredWriteW/CredReadW` → **Credential Manager 加密存储**，符合硬性要求 §凭据。
- 非 Windows：`UnsupportedCredentialStore` **不落盘明文**（readSecret 返回 null）——方案初步观察点 #5 验证通过。
- 凭据经 **env 传递 + `-EncodedCommand`**，不进命令行参数 → 进程列表无泄露 ✅；`spawnSync` 无 shell ✅。
- 残余低风险：IPC `mcp:save-credential` 可写任意 key（无校验）→ CredMan 命名污染（与 F-01 同源）。

## 状态与移交
- 新增发现：F-06、F-07、F-08；升级确认：F-02、F-03。
- 待验证：write-tool/edit-tool 全文、`respond-tool-approval` 审批令牌、`provider-config:save-generic` 加密落盘。
- Phase 4 PoC 候选：MCP 恶意服务器（F-06/F-07）、写路径穿越（F-08）、命令拆分器 fuzz（F-03）、IPC fuzz（F-01）。
