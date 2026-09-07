# 设计：DeepSeek 视觉接入方案 2 —— vision-exp 作为 MCP tool 中介

> 设计日期: 2026-09
> 状态: 设计待评审
> 关联模型: `deepseek-v4-flash-vision-exp`（实验性，2026-08-21 上线，OpenAI Chat Completions 兼容）
> 关联文档: 方案 1（原生多模态）见 `deepseek-vision-model-design.md`；两者二选一或分阶段叠加
> 代码核实: 本文所有行号基于当前仓库（2026-09 快照），非历史快照

---

## 1. 目标与范围

### 1.1 目标

把 `deepseek-v4-flash-vision-exp` 封装为一个**本地 MCP server**（stdio bridge，下称 `deepseek-vision`），向当前纯文本主模型暴露 `describe_image` 工具。用户面对多模态场景时**无需切换模型**：主模型自主决定调用该工具，图片在 bridge 进程内被读取、编码并直传 DeepSeek 视觉 API，返回的**文字结论**作为 tool result 进入上下文。

### 1.2 核心范式（一句话）

**图片永不进入 provider 消息链**（不扩展 `ProviderMessage`、不改 adapter 序列化、不碰 512KB 请求体保护）；图片只在「本地 bridge 进程 → DeepSeek API」这段独立 HTTP 链路上出现。

### 1.3 范围（本方案覆盖）

- 新增独立 MCP bridge 服务器实现（外置 `mcp/deepseek-vision-bridge.mjs`，纯 ESM stdio 桥、零编译）与 MCP 注册方式。
- 图片的**到达路径**（MVP 为文件路径入参；增强档为桌面选择器图片摄取 + 上下文提示）。
- bridge 的协议契约、错误语义、超时/安全约束。
- 契约与单元测试。

### 1.4 范围外（明确不做）

- Provider 消息结构/attachment kind 枚举扩展（那是方案 1 的 M1/M2/M3 主战场，方案 2 不需要）。
- 会话历史里存图（tool result 已是文本，天然可持久化、可跨轮回放）。
- 渠道图片（微信/网页等）直传入口 —— 后续需求，不在本设计落地范围。
- 多图一次调用增强、图片预压缩管线 —— 列为后续可选项，不进 MVP。

---

## 2. 现状链路核实（方案 2 的零改动基础）

仓库已具备**完整可用的 MCP 工具闭环**，这是本方案改动小的根本原因：

| 环节 | 事实 | 证据 |
|---|---|---|
| 工具命名 | `mcp__<serverId>__<toolName>`，前缀 `MCP_TOOL_PREFIX = 'mcp__'` | `src/mcp/mcp-client.ts:14`，`src/mcp/mcp-context.ts:52` |
| 工具并入 provider 列表 | ToolService 把 MCP 工具并入内置工具定义，执行委托 `mcpClientManager.executeTool` | `src/tools/tool-service.ts:228-238`；单测 `tests/unit/tool-service.test.ts:179-213` |
| 调用回环 | task-runner 对 `mcp__` 工具透传执行 | `src/agent/task-runner.ts:1337-1346` |
| adapter 还原 | deepseek adapter 识别 `mcp__` 前缀还原为服务端工具调用 | `src/providers/deepseek-adapter.ts:1018` |
| 配置持久化 | `<cwd>/.pueblo/mcp-servers.json` | `src/mcp/mcp-config.ts:18-38` |
| server 生命周期 | `McpClientManager.initialize()` 连接所有 enabled server | `src/mcp/mcp-client.ts:45-59` |
| 凭据注入 | server 配置 `apiKeyName` → 从凭据库取 key 注入子进程 env；否则继承父进程 env | `src/mcp/mcp-client.ts:76-81`；key 名 `DEEPSEEK_API_KEY`（`src/providers/deepseek-auth.ts:31`） |
| 传输/协议 | stdio 子进程 + JSON-RPC 2.0 逐行明文；**自研轻量协议**（非官方 SDK） | `src/mcp/mcp-connection.ts:60-135`，`src/mcp/mcp-protocol.ts` |
| 结果解析契约 | tools/list → `{tools:[{name,description,inputSchema}]}`；tools/call → `{content:[{type,text,...}],isError}` | `src/mcp/mcp-protocol.ts:138-163` |
| 内置模板 | 已有 well-known server 注册表（category/template），供"一键添加" | `src/mcp/mcp-registry.ts:21-102` |

**推论**：只要 `deepseek-vision` 能以 enabled server 身份被 spawn 并正确应答协议，它的工具**自动**出现在主模型 function-calling 列表且调用可回环 —— 主链路（provider/adapter/task-runner/tool-service）**零改动**。

附件/图片现状（决定增强档改动点）：
- 附件 kind 枚举仅 `'document' | 'spreadsheet'`：`src/shared/schema.ts:563`。
- 摄取入口 `ingestInputFiles`（`src/desktop/main/attachment-ingestion.ts:30`），由 IPC `select-input-files` 触发（`src/desktop/main/ipc.ts:550-566`）；文件对话框过滤器 `ATTACHMENT_FILE_DIALOG_FILTERS` 目前不支持图片。
- 附件根目录 `.pueblo-ws`：`src/desktop/main/attachment-ingestion.ts:306-308`。
- 附件以**文本摘要**注入 system 上下文：`summarizeAttachmentForContext`（`src/agent/context-resolver.ts:883-899`）→ `...attachmentContextTexts`（`src/agent/context-resolver.ts:219-220, 251`）。

---

## 3. 目标架构

```
┌───────────────────────────── pueblo 主进程 ─────────────────────────────┐
│  CLI / desktop main                                                     │
│    │ 纯文本主模型(v4-flash) function-calling 列表含                       │
│    │   mcp__deepseek-vision__describe_image（自动，见 §2）                │
│    │ 主模型决定调用 → task-runner 透传 → ToolService.execute             │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ spawn: node mcp/deepseek-vision-bridge.mjs（外置，无编译产物）
               │ stdio JSON-RPC 2.0（tools/call: {filePath, prompt?}）
┌──────────────▼──────────────────────────────────────────────────────────┐
│  deepseek-vision bridge（独立子进程，新增）                              │
│  1. 校验 filePath（仅允许 workspace / .pueblo-ws / 显式白名单内）         │
│  2. 读文件 → 校验类型 JPEG/PNG/GIF/WebP 且 ≤32MiB（上游约束）             │
│  3. 转 base64 dataURL                                                    │
│  4. POST https://api.deepseek.com/chat/completions（OpenAI 兼容）        │
│     model=deepseek-v4-flash-vision-exp；messages=[{role:user,content:[   │
│       {type:'text',text:prompt}, {type:'image_url',image_url:{url:dataURL}}]}]  │
│  5. 提取 content 文本 → {content:[{type:'text',text:…}], isError} 回主进程 │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ HTTPS（key 来自 env DEEPSEEK_API_KEY）
┌──────────────▼──────────────────────────────────────────────────────────┐
│  api.deepseek.com（vision-exp）                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

图片生命周期：本地文件 → bridge 进程内 base64 → dataURL 直传 DeepSeek（不落第三方持久化，与方案 1 D4 合规立场一致）；视觉结论以纯文本回到主链路，此后与普通文本无差别（可持久化、跨轮回放）。

---

## 4. 设计决策

### D1：bridge 暴露的工具契约（单一工具，参数走文件路径）

| 项 | 值 |
|---|---|
| server id | `deepseek-vision` |
| 工具名 | `describe_image` |
| 参数 | `filePath: string`（必填）；`prompt?: string`（选填，默认 `Describe this image, including any visible text.`）；`maxTokens?: number`（选填，默认 4096） |
| 返回 | 纯文本结论；错误时 `isError:true` + 可读错误 |

- 参数用**文件路径而非 base64/URL**：JSON-RPC 参数体保持小体积，且不把图片塞进主链会话文本（规避 512KB 保护与 token 放大）。
- 多图场景：主模型可多次调用；一次多图（`images: string[]`）列为后续可选增强，不进 MVP。

### D2：协议与运行时契约（bridge 必须与自研 client 对齐）

- 传输：stdio，逐行 JSON（`\n` 分隔），仅应答/通知，不自行输出任何日志到 stdout（日志走 stderr）。
- 必须处理的方法：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。
- 返回结构严格按 client 解析器：`src/mcp/mcp-protocol.ts:138-163`。
- 超时现实约束：client 请求超时 `DEFAULT_TIMEOUT_MS = 30_000`（`src/mcp/mcp-connection.ts:20`）。vision 单图（调研结论 token 封顶 384、low 档预缩 512×512）实测通常秒级；bridge 用**非流式**一次应答。若未来复杂图实测超时，再评估把请求超时参数化（见 M4 可选项）。
- HTTP 客户端：bridge 内用全局 `fetch`（Node ≥18；仓库 @types/node ^24）或 `node:https`，不依赖新增 npm 包。
- 可测性：bridge 主体导出 `createVisionBridgeServer({ apiBaseUrl, fetchImpl, apiKeyProvider, readFileImpl, logger })` 的工厂，单测注入 mock，CLI 入口 `main()` 仅负责组装真实依赖并启动 stdio 循环。

### D3：模型与 API 调用策略

- 只调 `deepseek-v4-flash-vision-exp`（不注册为主链路可选模型，避免 `/model` 列表出现 exp 项；纯文本主干保持 v4-flash 正式版不变）。
- 请求体**不经过** `deepseek-adapter`，因此不受其 512KB 本地保护（`src/providers/deepseek-adapter.ts:113`）影响——那是主链文本路径的护栏；bridge 侧自行做 ≤32MiB 单图校验。
- 不做流式：client 侧只消费最终文本。

### D4：图片到达路径分两档

**A 档（MVP，纯增量）——文件路径即入口**
- 不新增任何摄取/UI 改动。图片落在用户 workspace（任意目录，含 `.pueblo-ws`），用户在主输入里给路径，或主模型用现有 `glob`/`read` 工具自行发现图片文件后调用 `describe_image`。
- 与方案 1 复用点：无（方案 1 的摄取子设计属其 M3，此处不需要）。

**B 档（增强，需少量主链改动）——桌面选择器图片摄取 + 上下文提示**
- `attachment-ingestion.ts` 扩展：新增**独立** `ingestImages`（或 `ingestInputFiles` 内加图片分支），支持 `.png/.jpg/.jpeg/.gif/.webp`：
  - 原图**复制落盘** `<workspace>/.pueblo-ws/image/<attachmentId>/<原文件名>`（复用 `resolveWorkspaceAttachmentRoot`，`attachment-ingestion.ts:306-308`）——复用方案 1 D4 的"原图复制 + 边车 JSON"子设计；
  - 边车 JSON 记录 `{attachmentId, mimeType, sizeBytes, originalPath, createdAt}`，**不做内容解析/缩略**。
- **不扩展** `attachmentKindSchema`（`schema.ts:563` 保持 `document|spreadsheet`），另立轻量 `imageInputManifestSchema`，避免污染现有 document/spreadsheet 资产流。
- `TaskContext` 增可选 `imageInputs?: ImageInputManifest[]`（`src/agent/task-context.ts:17-24, 66` 同区），独立于 `uploadedAttachments`。
- `context-resolver` 在 system 组装处（`context-resolver.ts:251` 附件文本之后）追加提示行：
  ```
  Image inputs available this turn: 1) filePath=<abs> mime=image/png size=1.2MB
  You can inspect it by calling tool mcp__deepseek-vision__describe_image with that filePath.
  ```
- 会话持久化不新增字段：边车 JSON 已在磁盘，跨轮回放同现附件生命周期（清理附件目录会影响回放，与现状一致）。

### D5：安全与合规

- bridge 侧路径校验：`filePath` resolve 后必须位于 workspace 根、`.pueblo-ws`、或 `cwd` 三者白名单前缀内，越界返回 `isError`，防止模型诱导读取任意系统文件。
- 工具审批：`describe_image` 视为 read 类工具，受现有 tool execution policy / 审批体系管辖（与 `read` 同级），不额外放权。
- 图片只发往 DeepSeek 官方域名且以 dataURL 即发即弃，不落第三方持久化；与方案 1 D4 合规立场一致，无需新增合规评审面。
- 响应文本进入上下文后即普通文本，无新增注入面。

---

## 5. 改动点清单（按实施顺序分组）

### M1 — bridge 服务器实现（新增文件，纯增量）
- [ ] 新建外置 `mcp/deepseek-vision-bridge.mjs`（纯 ESM stdio 桥，1:1 迁移自已删除的 `src/mcp-servers/deepseek-vision-bridge.ts`）：
  - stdio 行式 JSON-RPC 循环（initialize/initialized/tools/list/tools/call/ping），结构对齐 `src/mcp/mcp-protocol.ts:138-163`
  - `tools/list` 返回 `describe_image`（name/description/inputSchema: `filePath` 必填、`prompt`/`maxTokens` 选填）
  - `tools/call` 执行：路径白名单校验 → 读文件 → 类型/≤32MiB 校验 → dataURL → POST vision-exp → 回文本或错误
  - 工厂注入 `fetchImpl/apiKeyProvider/readFileImpl` 便于单测
- [ ] 外置 `.mjs` 无需 tsc 编译/产物：Pueblo 直接以 `node <repo>/mcp/deepseek-vision-bridge.mjs` spawn（零编译参与，无 dist 产物路径）

### M2 — 注册与契约测试
- [ ] 契约/单元测试：`tests/unit/vision-bridge.test.ts`
  - mock `fetchImpl`：断言请求体（URL、model、message 含 `image_url` dataURL）、响应提取、≤32MiB/非白名单/非支持格式错误分支、tools/list 结构
  - 用注入的 stdio 双端（或直接调用工厂 handler）验证 JSON-RPC 应答形状符合 `mcp-protocol.ts` 解析器
- [ ] 注册示例（MVP 文档化）：`<cwd>/.pueblo/mcp-servers.json` 增条目：
  ```json
  { "id": "deepseek-vision", "name": "DeepSeek Vision (exp)",
    "command": "node", "args": ["<abs>/mcp/deepseek-vision-bridge.mjs"],
    "enabled": true, "apiKeyName": "DEEPSEEK_API_KEY" }
  ```
- [ ] 手工验收脚本/文档：启动后 server 状态 connected、`/tools` 或 UI 出现 `mcp__deepseek-vision__describe_image`

### M3 —（可选 P2）B 档图片摄取与上下文提示
- [ ] `src/desktop/main/attachment-ingestion.ts`：新增图片支持（扩展名 `.png/.jpg/.jpeg/.gif/.webp`，独立入口 `ingestImages`；原图复制 + 边车 JSON）
- [ ] `src/shared/schema.ts`：新增 `imageInputManifestSchema`（独立于 L563 枚举）
- [ ] `src/agent/task-context.ts` + `src/agent/context-resolver.ts`：`imageInputs` 透传 + 追加图片提示行（D4 模板）
- [ ] 单元测试：`tests/unit/image-ingestion.test.ts`、resolver 快照断言含提示行
- [ ] `src/desktop/main/ipc.ts:550-566`：文件对话框 filters 并入图片类型

### M4 —（后续可选）体验与稳健性增强
- [ ] `src/mcp/mcp-registry.ts` 增内置条目（category: vision），支持 UI 一键添加
- [ ] 若实测超 30s：`src/mcp/mcp-connection.ts:20` 请求超时参数化（per-server）
- [ ] `describe_image` 支持多图数组与 low 档预缩（省 token）

---

## 6. 验收标准

1. **连通性**：注册条目后启动应用，`deepseek-vision` 连接状态 `connected`，工具出现在 provider 工具列表。
2. **端到端（A 档）**：纯文本主模型（v4-flash），用户将含文字截图放入 workspace 并提问"图里写了什么"→ 模型调用 `mcp__deepseek-vision__describe_image` → tool result 文本正确回到对话。
3. **B 档（若实施）**：桌面选择图片附件 → 本轮 system 出现图片提示行 → 模型在无用户给出路径的情况下自主调用工具。
4. **防呆**：传不存在路径/越界路径/非支持格式 → `isError` 可读错误，不崩溃；bridge 进程异常退出时 client 侧报连接错误而非挂死。
5. **回归**：主链全部现有单测通过；无 provider/adapter/schema（L563 枚举）/会话存储改动。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| exp 模型无稳定性承诺 | 仅作为工具后端；文本主干不动；工具调用失败时错误可读、可重试 |
| 30s 请求超时（`mcp-connection.ts:20`） | 单图 + 默认 prompt 实测通常秒级；超时走 M4 参数化；多图明确不进 MVP |
| 图片体积（≤32MiB 上游） | bridge 显式校验并返回错误；B 档边车记录 sizeBytes 便于模型判断 |
| 路径安全 | D5 白名单 + 现有审批体系双重防护 |
| 工具被模型误用/循环调用 | describe_image 属 read 类，走 execution policy；错误信息含可操作提示 |
| 与方案 1 并存 | 两方案不冲突：方案 2 的 bridge 就是"方案 1 的 vision 能力"的另一种出口；若日后方案 1 实施，bridge 仍可保留用于工具化场景 |

---

## 8. 推荐分阶段落地

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | M1+M2（bridge + 注册 + 契约测试 + 验收脚本） | 1 个 PR，纯增量、主链零改动 |
| P2 | M3（B 档摄取 + 上下文提示） | 1-2 个 PR |
| P3 | M4（registry 内置、timeout 参数化、多图/预缩） | 按实测需要 |

**推荐先合 P1**：改动完全隔离（新增文件 + 测试），即可手工走通"文本主模型看图"主路径；P2 的 UI 摄取是体验增强，不阻塞 P1 价值验证。

---

## 9. 与方案 1 的取舍结论（供评审参考）

| 维度 | 方案 1（原生多模态模型） | 方案 2（MCP tool 中介） |
|---|---|---|
| 视觉质量 | 高：图文同炉联合推理、连续追问 | 中：看图/OCR/截图转述为主，二次文字转述有损 |
| 改动面 | 全链：消息结构 + adapter 序列化 + 摄取 + 会话 | P1 纯增量；P2 少量 context 注入 |
| 512KB/请求体风险 | 需重构阈值策略 | 天然规避（bridge 独立 HTTP） |
| 用户路径 | `/model` 切到 vision 模型 | 无切换，模型自主调用工具 |
| 上滚速度 | P1 模型注册可用但"切过去看不见图"（M3 未合前） | P1 即闭环可用 |
| 风险 | exp 作正式模型入口需谨慎 | exp 被隔离在工具后端，风险更低 |
