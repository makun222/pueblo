# Pueblo 源码安全分析方案（Security Analysis Plan）

- 文档版本：v1.0
- 适用对象：pueblo（Electron + Node.js/TypeScript 的 AI Agent 桌面应用）
- 分析目标仓库根：`src/`
- 分析方式：静态分析（SAST）+ 人工代码审计 + 动态测试（PoC 验证）
- 编制日期：以仓库 commit 冻结为准（见 Phase 0）

---

## 1. 目标（Goals）

1. **发现并定性安全隐患**：通过静态与动态手段识别 pueblo 中可被攻击者利用的安全缺陷（漏洞、弱配置、设计缺陷），并输出可复现的证据。
2. **建立安全基线**：以 OWASP（Web / LLM / MASVS）、Electron 官方安全清单为基线，明确"安全/不安全"的判定标准，避免主观化。
3. **输出可执行的修复清单**：每个发现包含 CWE 映射、风险定级（CVSS 3.1）、影响面、复现步骤、修复建议与优先级，可直接进入开发排期。
4. **验证关键信任边界**：重点验证 5 条信任边界——
   - 不可信内容 → Agent 上下文（提示词注入/工具注入）；
   - Renderer（可能被 XSS） → Main 进程（IPC 提权）；
   - 外部 MCP 服务器 / 外部命令 → 本机执行；
   - Agent 工具调用 → 文件系统 / 进程 / 网络；
   - 持久化数据 → 敏感信息（API Key、会话、记忆）。
5. **沉淀可复用资产**：将扫描规则集、检查清单、PoC 脚本沉淀到仓库 `docs/security/`，供后续版本回归复测。

---

## 2. 安全标准（Security Baseline）

| 领域 | 采用标准 | 说明 |
| --- | --- | --- |
| Web/通用 | OWASP Top 10 (2021) | 覆盖注入、失效访问控制、XSS、SSRF 等 |
| AI 应用 | OWASP LLM Top 10 (2025) | 提示词注入、不安全的输出处理、过度代理、敏感信息泄露等 |
| 桌面/移动 | OWASP MASVS-L1 + Electron Security Checklist | 渲染层隔离、IPC 面、本地存储 |
| 编码缺陷 | CWE Top 25 | 用于给发现编号映射 |
| 定级 | CVSS 3.1 | Critical ≥9.0 / High 7.0–8.9 / Medium 4.0–6.9 / Low <4.0 |

**判定原则**：不满足下列任一"硬性安全要求"即记为缺陷，按 CVSS 定级：

- 渲染层：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`，不加载远程不可信内容；生产构建不暴露 DevTools/remote debugging。
- IPC：所有 `ipcMain.handle/on` 必须校验 `event.senderFrame` 来源与入参 schema；通道名必须白名单化；preload 只暴露最小 API。
- 命令执行：禁止字符串拼接进 `shell` 执行；参数数组化；cwd 白名单/受控；默认不继承额外环境变量（密钥类变量需显式注入白名单）。
- 文件访问：所有路径必须先解析并校验位于允许根内（防 `..`、符号链接、UNC/特殊设备路径穿越）；工具输出对 LLM 可见前有敏感数据过滤。
- 凭据：API Key/Token 必须落盘加密（如 Windows Credential Manager / keytar），禁止明文落盘、禁止写入日志、禁止回显到工具输出。
- 网络：出站请求默认禁止跟随重定向到非预期协议；SSRF 防护（禁止访问内网/回环地址的默认策略需评审）；TLS 校验不关闭。
- 依赖：生产依赖无已知高危漏洞（npm audit / OSV 全绿或已登记风险接受）。
- AI 特有：Agent 调用危险工具（exec/shell/write/网络）前必须有审批/授权门；外部内容进入上下文时必须标记来源并抑制指令性内容；子代理必须继承受限权限模型而非放大权限。

---

## 3. 规则（Rules of Engagement）

1. **可复现优先**：每个发现必须附最小复现（PoC 脚本、输入样例、调用序列），静态扫描结果需人工确认以消除误报后才计入报告。
2. **不越界**：所有动态测试仅在本机隔离环境（测试专用目录/临时 MCP 服务器/模拟 Provider）进行；不对公网、未授权第三方系统发起任何主动测试。
3. **不破坏**：禁止删除/篡改用户数据与生产配置；测试用数据必须隔离（独立 SQLite 文件、独立用户数据目录）。
4. **密钥保护**：测试过程中不使用真实 API Key；仓库中发现的密钥一律脱敏后上报，不进入任何报告正文（报告用 `<REDACTED>`）。
5. **修复优先级**：P0（可导致未授权远程代码执行/敏感数据泄露，CVSS≥9）→ P1（提权/大规模数据泄露）→ P2（中等风险）→ P3（加固建议），P0/P1 应在本轮安全迭代内闭环。
6. **文档留痕**：每次扫描记录工具版本、规则集版本、扫描时间、仓库 commit，保证结果可追溯、可复测。
7. **不修改业务代码**：分析阶段只读；修复建议输出为清单，由开发在后续迭代实施并复测。

---

## 4. 威胁模型与重点模块（基于代码预研）

以下为初探 `src/` 后的重点风险面与对应文件，分析时按此优先级展开（也是审计顺序）：

| # | 信任边界/风险面 | 重点文件 | 关注点 |
| --- | --- | --- | --- |
| 1 | 工具系统 → 本机执行 | `tools/exec-tool.ts`、`tools/shell-exec-tool.ts`、`tools/tool-service.ts` | 命令解析（自研 `splitCommand` 的正确性）、shell 标志、cwd 校验、超时/取消、工具审批门是否可绕过、输出是否泄露敏感信息 |
| 2 | 工具系统 → 文件系统 | `tools/read-tool.ts`、`tools/write-tool.ts`、`tools/edit-tool.ts`、`tools/undo-edit-tool.ts`、`tools/glob-tool.ts`、`tools/grep-tool.ts`、`tools/file-guard.ts` | 路径根限制与穿越（`..`、符号链接、UNC）、写操作的越权路径、grep 对任意目录的读取、file-guard 仅保护读取 |
| 3 | Renderer → Main（IPC） | `desktop/preload/index.ts`、`desktop/main/ipc.ts`、`desktop/main/window.ts`、`desktop/shared/ipc-contract.ts` | 通道白名单、sender 校验、入参 schema 校验；preload 暴露面（`mcp:save-credential`、`provider-config:save` 等高风险通道）；**已发现：`webPreferences` 未设置 `sandbox:true`**；dev 模式 `loadURL('http://localhost:5173')` 端口劫持面 |
| 4 | MCP 外部服务器 | `mcp/mcp-connection.ts`、`mcp/mcp-client.ts`、`mcp/mcp-credentials.ts`、`mcp/mcp-ipc.ts` | `spawn` 的 `shell` 标志与参数传递、env 注入（API Key 泄漏给子进程）、不可信工具定义/描述 → 提示词注入、`tools/call` 返回内容注入、服务器启动路径（`command` 可执行任意程序） |
| 5 | 凭据与密钥 | `providers/credential-store.ts`、`providers/deepseek-*.ts`、`providers/github-copilot-*.ts`、`mcp/mcp-credentials.ts`、`shared/config.ts` | Windows Credential Manager 使用是否兜底、`UnsupportedCredentialStore` 是否明文降级、密钥在 env/日志/工具输出中的暴露 |
| 6 | AI 上下文注入 | `agent/**`、`prompts/**`、`sessions/**`、`memory/**` | 外部内容（文件/网页/MCP 返回/记忆）进入上下文时的来源标记与指令抑制；工具审批策略；上下文长度截断后是否丢失安全标记 |
| 7 | 子代理隔离 | `agent/subagent/**` | 子代理是否继承主代理全部工具权限、审批是否可被绕过、跨代理数据隔离 |
| 8 | 持久化 | `persistence/sqlite.ts`、`persistence/repository-base.ts`、`persistence/migrate.ts`、`memory/**` | SQL 注入面、SQLite 明文敏感数据、迁移脚本注入、文件权限 |
| 9 | 供应链 | `package.json`、lockfile、`mcp/**` 依赖 | 生产依赖高危漏洞、已知 CVE、可疑维护者/恶意包 |
| 10 | 会话与导出 | `sessions/**`、`tools/attachment-asset-export.ts`、`workflow/**` | 会话数据泄露、导出文件路径穿越、workflow 计划持久化的注入 |

**初步观察点（供 Phase 2/3 直接验证，非结论）**：
1. `desktop/main/window.ts`：`webPreferences` 缺 `sandbox:true`（Electron 官方清单要求）；preload 在非 sandbox 下拥有完整 Node 权限。
2. dev 模式加载 `http://localhost:5173`：若本机 5173 端口被恶意进程占用，可加载恶意页面 → 需验证 production 构建路径与端口占用防护。
3. `tools/exec-tool.ts` / `shell-exec-tool.ts` 使用 `execFile`（较好），但命令拆分依赖自研解析器，需覆盖引号/转义/管道等边界用例；同时确认 `shell` 参数未被开启。
4. `mcp/mcp-connection.ts` 通过 `spawn` 拉起外部服务器：需审计 `shell` 标志、参数透传与 env（尤其凭据注入）。
5. `providers/credential-store.ts` 在非 Windows 平台可能降级为 `UnsupportedCredentialStore`，需确认降级行为不产生明文持久化。
6. `tools/file-guard.ts` 只做"读取"三道闸门，不覆盖 write/edit 的路径范围校验。

---

## 5. 分析手段（Methods）

### 5.1 静态分析（SAST + SCA + 密钥扫描）

| 手段 | 工具/方式 | 覆盖 |
| --- | --- | --- |
| 语义扫描 | Semgrep（自定义规则 + `p/owasp-top-ten`、`p/typescript`、`p/electron`） | 注入、命令执行、路径穿越、不安全 IPC、XSS、SSRF 等 |
| 依赖漏洞 | `npm audit` / OSV-Scanner / `socket.dev` 或 `npm ls` 对比 NVD | 供应链 CVE、恶意包 |
| 密钥泄露 | Gitleaks + 自定义正则 | 硬编码 API Key、Token、私钥 |
| 类型/语言级 | `tsc --noEmit`（严格模式）、`eslint-plugin-security`、`no-secrets` | 潜在内存泄漏、危险 API 使用 |
| 配置检查 | 人工 + 脚本扫描 `webPreferences`、`ipcMain` 注册表、`spawn/exec` 调用点 | Electron/Node 弱配置 |

**Semgrep 自定义规则模板**（落盘到 `docs/security/rules/`）：
- `spawn-shell-true`：`spawn(..., {shell: true})` 标记为 High。
- `ipc-handler-no-schema`：`ipcMain.handle` 未调用入参校验函数时标记。
- `exec-shell-flag` / `child-process-command-interpolation`：命令字符串拼接进 exec 系调用。
- `path-join-with-user-input`：工具入参直接拼入 `path.join`/`resolve` 且无 guard。
- `http-insecure`：`http://` 出站、`rejectUnauthorized:false`、`NODE_TLS_REJECT_UNAUTHORIZED=0`。

### 5.2 人工代码审计（重点模块顺序）

按第 4 节表格顺序 1→10 逐模块审计，每个模块产出：审计结论、发现列表、误报说明。审计关注数据流：**不可信输入 → 处理 → 敏感操作（执行/写文件/网络/凭据）**。

### 5.3 动态测试（PoC 验证）

| 测试项 | 方法 |
| --- | --- |
| IPC 面测试 | 在 Renderer 注入 `window.electronAPI` 白名单外调用尝试；对每个通道构造畸形/超长/类型错误入参，观察 Main 是否抛错/越权；用 Playwright 对 Renderer 做 XSS 注入后尝试调用 `mcp:save-credential` 等敏感通道 |
| 命令执行 | 构造 `cmd /c`、`powershell` 转义、`&`/`|`/反引号、Unicode 混淆输入到 exec/shell_exec，验证解析器与 shell 标志 |
| 路径穿越 | 对 read/write/edit/glob/grep 传入 `../../`、绝对路径、UNC（`\\server\share`）、`C:\`、符号链接目录，验证根限制 |
| MCP 恶意服务器 | 自建"恶意 MCP 服务器"（stdio/SSE 均可），返回恶意工具定义与注入内容，验证：工具注入、提示词注入、API Key 是否被发送给服务器、`tools/call` 参数透传 |
| 凭据面 | 检查 Credential Manager 条目、进程 env、日志文件、SQLite 文件中是否出现明文密钥；验证删除/轮换流程 |
| 子代理隔离 | 从子代理尝试调用父代理才有的工具/审批绕过 |
| SQL 注入 | 对 repository 层输入构造 `' OR 1=1--` 等负载（使用隔离数据库） |
| 供应链 | 对 lockfile 运行已知漏洞库比对，抽查高危依赖版本 |

动态测试全部在隔离环境执行：独立用户数据目录（`--user-data-dir`）、独立工作目录、模拟 Provider 端点、本地恶意 MCP 服务器（不触网）。

---

## 6. 实施步骤（Phases）

| 阶段 | 内容 | 产出 | 建议工时 |
| --- | --- | --- | --- |
| **Phase 0 准备** | 冻结 commit；搭隔离测试环境；安装/固定扫描工具版本；确认 `docs/security/` 落盘结构 | 环境清单、版本基线 | 0.5d |
| **Phase 1 资产与数据流盘点** | 梳理模块依赖、trust boundary、数据流图（不可信输入 → 敏感操作）；确认工具审批链路与 IPC 通道清单 | 架构图、信任边界清单、IPC 通道清单 | 1d |
| **Phase 2 自动化扫描** | Semgrep（含自定义规则）、npm audit/OSV、Gitleaks、tsc 严格模式、eslint-security | 机器扫描报告（含原始命中） | 1d |
| **Phase 3 人工审计** | 按 5.2 顺序逐模块审计，验证 Phase 2 命中并排查逻辑缺陷 | 模块审计记录 | 3–5d |
| **Phase 4 动态验证** | 按 5.3 逐项 PoC；对 Phase 3 疑点做运行时验证 | PoC 脚本、复现记录 | 2–3d |
| **Phase 5 汇总定级** | 合并去重、CVSS 定级、CWE 映射、风险热图、修复建议与排期 | 正式安全分析报告 | 1d |
| **Phase 6 修复复测** | 开发按 P0/P1→P2→P3 修复；对修复后 commit 重跑 Phase 2/4 关键项回归 | 复测报告、规则集沉淀 | 1–2d |

**每阶段退出条件**：前一阶段产出经评审通过后方可进入下一阶段；Phase 2/4 结果必须留档（工具版本+commit）。

---

## 7. 产出物与目录结构

```
docs/security/
├── security-analysis-plan.md      # 本方案
├── rules/                         # Semgrep 自定义规则集
│   ├── spawn-shell-true.yml
│   ├── ipc-handler-no-schema.yml
│   └── ...
├── poc/                           # 动态验证 PoC 脚本（隔离环境用）
│   ├── malicious-mcp-server/
│   ├── path-traversal/
│   └── ipc-fuzz/
├── report/
│   ├── findings-<commit>.md        # 发现清单（ID/模块/CWE/CVSS/证据/修复建议）
│   ├── risk-matrix-<commit>.md     # 风险热图与优先级
│   └── scan-logs/                 # 各工具原始输出
└── checklist.md                   # 人工审计检查清单（可复用）
```

**发现清单字段**：`ID | 模块/文件:行号 | 类型 | CWE | CVSS | 严重度 | 证据(复现) | 影响 | 修复建议 | 状态`。

---

## 8. 风险接受与例外

- 明确不修复项（如第三方库固有行为）须登记 `risk-accepted`，附理由与缓解措施。
- 扫描器误报须在报告中标记 `false-positive` 并说明原因。
- 本方案不包含渗透测试/红队对抗测试；如后续需要，另立专项。

---

## 附：快速开始（Phase 0 命令草案）

```bash
# 1) 冻结基线
git -C <repo> rev-parse HEAD > docs/security/report/baseline-commit.txt

# 2) 依赖漏洞扫描
npm audit --omit=dev > docs/security/report/scan-logs/npm-audit-$(date +%F).txt

# 3) 密钥扫描
gitleaks detect --source <repo> --report-path docs/security/report/scan-logs/gitleaks.json

# 4) Semgrep（示例，规则集见 docs/security/rules/）
semgrep --config p/owasp-top-ten --config docs/security/rules --json \
  --output docs/security/report/scan-logs/semgrep.json <repo>/src
```
