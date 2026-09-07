# 设计：DeepSeek 视觉接入方案 1 —— vision-exp 作为原生多模态模型

> 设计日期: 2026-09
> 状态: 设计待评审
> 关联模型: `deepseek-v4-flash-vision-exp`（实验性，2026-08-21 上线，OpenAI Chat Completions 兼容）
> 关联文档: 调研笔记见会话摘要；方案 2（MCP tool 中介）另行成文

---

## 1. 目标与范围

### 1.1 目标

把 `deepseek-v4-flash-vision-exp` 注册为 DeepSeek Provider 的新模型。用户面对多模态场景（截图、图片附件、渠道图片）时通过 `/model` 切换至该模型，图片以 **image content part 与文本同炉**进入模型上下文，支持图文联合推理与连续追问。

### 1.2 范围（本方案覆盖）

- Provider 消息模型的**最小多模态扩展**（不改全链路结构，采用可选 image part 字段）。
- DeepSeek adapter 的 OpenAI 风格 content-parts 序列化。
- 图片附件的**落地、schema、注入**链路（document/spreadsheet 之外的第三种 kind）。
- 512KB 本地请求体保护对 vision 请求的策略调整。
- 模型注册、能力标记与防呆（纯文本模型收到图片时显式报错）。
- 契约/单元测试更新。

### 1.3 范围外（明确不做，防止蔓延）

- **不自动路由**：用户手动 `/model` 切换（自动"有图即切"留作 M3+ 增强，本设计只留挂载点）。
- **不改造 openai-compatible / github-copilot adapter**：二者对含图消息显式报错（防静默丢图），不支持序列化。
- 渠道（Feishu 等）入站图片下载管线：只登记入口，另行任务。
- 消息存储结构（`SessionMessage.content` 仍为纯文本）：图片以 attachmentId 持久化，不做 content-parts 存储改造。

---

## 2. 现状链路（已核实，行号为当前仓库基线）

```
用户/桌面输入 ──uploadedAttachments: InputAttachmentManifest[]──▶ context-resolver.ts
   context-resolver.ts L219-220/L410    附件 → 纯文本摘要进 system 上下文
   task-context.ts L39/L101             taskContext.uploadedAttachments
   task-runner.ts L1419                 buildProviderMessages(taskContext, goal)
   task-message-builder.ts L64          ProviderMessage[]（全链 content: string）
   ──▶ deepseek-adapter.ts runTask ── buildDeepSeekRequestPayload L632
        toDeepSeekMessage L835          → POST {baseUrl}/chat/completions L170
        本地保护 DEEPSEEK_MAX_REQUEST_BODY_BYTES=512_000 L113
```

关键硬事实：

| 项 | 位置 | 现状 |
|---|---|---|
| ProviderMessage | `provider-adapter.ts` L361-369 | `role` + `content: string`，纯文本 |
| DeepSeek 请求 URL | `deepseek-adapter.ts` L170 | `${baseUrl}/chat/completions` |
| 请求体保护 | `deepseek-adapter.ts` L113、L330-427 | 512KB；超限文本压缩三档（preview/aggressive-preview/summary-only），仍超则抛错 |
| 模型清单 | `deepseek-profile.ts` L6-19 | `DEEPSEEK_MODELS` 仅 v4-flash / v4-pro |
| 模型 schema | `schema.ts` L12-17 | id/name/contextWindow/supportsTools |
| 附件 kind | `schema.ts` L563 | 仅 `document` \| `spreadsheet` |
| 附件摄取 | `desktop/main/attachment-ingestion.ts` L30-46 | 仅文本类文档解析，无图片分支 |
| 附件注入消息 | `task-message-builder.ts` L163-206 | 仅文本摘要（preview/inline JSON） |
| 上传入口 | `desktop/main/ipc.ts` L561（调 ingestInputFiles） | 文件对话框 |
| 模型切换 | `/model`（已有） | 会话级切换已可用 |

---

## 3. 核心设计决策

### D1：ProviderMessage 采用「可选 imageParts 字段」，不做 content 结构重构

```ts
// provider-adapter.ts
export interface ProviderImagePart {
  /** data:image/<mime>;base64,... 或 https:// 图片地址 */
  readonly url: string;
  /** 仅本地文件走 base64 时冗余登记 media type，便于校验与日志 */
  readonly mediaType?: string;
}

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;              // 保持纯文本，向后兼容
  readonly imageParts?: readonly ProviderImagePart[];  // 新增，仅 user 消息有意义
  // ...其余字段不变
}
```

理由：
- `content: string` 被 task-runner / context-resolver / 会话持久化 / 三个 adapter 依赖，**重构为 parts 数组将引爆全仓回归**（上一轮评估为"横向大改"）。
- 可选字段使 openai-compatible / github-copilot adapter 编译不受影响（TS 结构类型），运行时由各自防呆兜底。
- DeepSeek API 本身就是 OpenAI 风格：`content` 可传 `[text, image_url]` 数组；**本地组装成 parts、对外保持 ProviderMessage 仍是字符串 + imageParts**，序列化边界收窄到 `toDeepSeekMessage` 一处。

### D2：图片注入路径以「模型无关构造 + adapter 兜底」为主

- task-message-builder 不感知模型能力：只要 `taskContext.uploadedAttachments` 含 image kind，就在该轮首条 user 消息挂 `imageParts`。
- **硬约束（上游 400 约束）**：image part 只能进 **user** 消息；system/assistant 放图 → DeepSeek 400。跨轮回放/重注入也必须走 user 消息，system 摘要只含固定文本占位（不含 base64）。
- 若最终请求模型不支持图片，deepseek-adapter 抛 `ProviderError`，文案引导 `/model` 切换；openai-compatible / github-copilot adapter 同理显式报错（禁止静默丢弃）。
- UX 增强（CLI 在 attach 图时若当前模型非 vision 给提示）作为 M3，不阻塞主链路。

### D3：512KB 本地保护按「模型能力」分档

- 图片以 base64 dataURL 注入时体积大（单张 32MiB 原图 → base64 ×4/3 ≈ 44.7MB），512KB 必然拦截，且**文本压缩对 base64 无效**。
- **官方请求体上限 48MiB**（≈ 50.3MB），单张 32MiB 图 base64 后已逼近上限；本地阈值若按 60MB 设置会放行后触发上游 400。故本地阈值必须**按 base64 后字节计**，设 `DEEPSEEK_VISION_MAX_REQUEST_BODY_BYTES = 44 * 1024 * 1024`（≈ 46.1MB，低于 48MiB 官方上限）。
- 文本压缩档位对 vision 模型**保留**（只压缩 tool 结果文本，绝不触碰 image user 消息）。
- 若压缩后仍超 vision 阈值，抛错并提示**走 Files API 或降采样**（`detail: low` 缩至 512×512）。

### D4：图片附件是「第三种 kind」，文件本体落盘，asset 用边车 JSON

沿用现有 "asset 清单 JSON 落 workspace 附件目录" 模式：

- schema：`attachmentKindSchema` 增加 `'image'`；新增 `imageAttachmentAssetSchema`（kind/image/source/asset/summary，无文本 content 块）。
- `asset` 扩展一个可选字段 `filePath`（相对 workspace 的相对路径，指向**原始图片文件副本**），document/spreadsheet 不填，兼容旧记录。
- `ingestSingleInputFile` 增加 image 分支：扩展名仅作摄取门禁；**格式按文件 magic bytes 判定**（JPEG/PNG/GIF/WebP，上游按文件内容识别格式、不按扩展名/MIME），`dataURL` 的 MIME 必须与 magic bytes 一致。将文件**二进制复制**到附件根目录，`sizeBytes`/`mimeType` 由源文件取；不执行文本解析。
- `summarizeAttachmentForContext` 对 image 输出固定摘要（文件名/尺寸说明性文字占位），正文不携带 base64 进 system。

### D5：模型注册与能力标记

- `providerModelSchema` 增加 `supportsVision: z.boolean().default(false)`（`schema.ts` L12-17）。
- `DEEPSEEK_MODELS` 增加：
  ```ts
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (exp)',
    supportsTools: true, contextWindow: DEEPSEEK_CONTEXT_WINDOW, supportsVision: true }
  ```
- 纯文本模型 `supportsVision: false` 显式标出。`/model` 列表自动出现该项，无需 CLI 改造。

---

## 4. 数据流（图片一轮走完）

```
1. 桌面/CLI 入口收图 → ingestInputFiles 新增 image 分支：
   原图复制到 <workspace>/.pueblo/...（附件根），生成 imageAsset 边车 JSON（含 filePath）
2. turn 启动 → context-resolver：image manifest 走固定文本摘要进 system；
   taskContext.uploadedAttachments 保留完整 manifest（含 image）
3. task-runner L1419 → buildProviderMessages：
   遍历 uploadedAttachments，image kind → 读 filePath → base64(dataURL)
   → 挂到当前轮 user 消息 imageParts
4. deepseek-adapter runTask → buildDeepSeekRequestPayload →
   toDeepSeekMessage(user 消息带 imageParts) 产出
   { role:'user', content:[{type:'text',text},{type:'image_url',image_url:{url:dataURL}}] }
5. vision 模型返回图文联合推理结果（流式/非流式路径均已支持 content 数组文本提取，
   见 L911-915）
6. 会话持久化：消息仍存纯文本（含图由 attachmentId 指向 asset），跨轮可重注入
```

要点：
- 每轮只把「当轮附件」的图注入首个 user 消息（与现有附件注入同生命周期），不污染历史。
- base64 转换点收在 task-message-builder 一处；`imageParts` 是纯数据，adapter 不读文件。

## 5. 改动点清单（按实施顺序分组）

### M1 — 模型注册与能力标记（独立、低风险）
- [ ] `src/shared/schema.ts` L12-17：`providerModelSchema` 增 `supportsVision: z.boolean().default(false)`
- [ ] `src/providers/deepseek-profile.ts` L6-19：`DEEPSEEK_MODELS` 增 vision-exp 项；flash/pro 显式 `supportsVision:false`
- [ ] `src/shared/schema.ts` L698 附近：确认 `ProviderModel` 类型导出自动带上新字段

### M2 — ProviderMessage 扩展 + DeepSeek 序列化（核心）
- [ ] `src/providers/provider-adapter.ts` L361-369：新增 `ProviderImagePart` 接口与 `ProviderMessage.imageParts?`
- [ ] `src/providers/deepseek-adapter.ts` L835 `toDeepSeekMessage`：user 消息带 `imageParts` 时 content 输出 parts 数组（text + image_url）
- [ ] `src/providers/deepseek-adapter.ts` L113 附近：新增 `DEEPSEEK_VISION_MAX_REQUEST_BODY_BYTES = 44 * 1024 * 1024`（按 base64 后字节计，低于 48MiB 官方上限）；`prepareRequestLogContext` L322-427 按模型能力选阈值
- [ ] `src/providers/deepseek-adapter.ts`：压缩逻辑确认**不裁剪含 imageParts 的 user 消息**（compact 只作用于 tool 消息文本）
- [ ] 防呆：deepseek-adapter / openai-compatible-adapter / github-copilot-adapter 收到 imageParts 而模型 `supportsVision!==true` → `ProviderError` 引导 `/model` 切换

### M3 — 图片附件摄取与注入
- [ ] `src/shared/schema.ts` L563：kind 枚举增 `'image'`；新增 `imageAttachmentAssetSchema`；`attachmentAssetSchema` 增可选 `filePath`
- [ ] `src/desktop/main/attachment-ingestion.ts` L30-110：`ingestSingleInputFile` 增 image 分支（扩展名门禁 + magic bytes 判定格式、二进制复制、边车 JSON、无文本解析）
- [ ] `src/desktop/main/ipc.ts` L23/L561：文件对话框过滤器允许图片扩展名（ATTACHMENT_FILE_DIALOG_FILTERS）
- [ ] `src/agent/context-resolver.ts` L219-220/L880-920：`summarizeAttachmentForContext` 对 image kind 输出固定摘要（避免 base64 泄漏进 system 预算）
- [ ] `src/agent/task-message-builder.ts` L163-206 区域：image manifest → 读 `filePath` → base64 dataURL → 挂首批 user 消息 `imageParts`
- [ ] 入口登记（后续任务）：Feishu 等渠道入站图片下载后走同一 manifest 注入

### M4 — 测试
- [ ] `tests/contract/deepseek-provider-contract.test.ts`：新增用例——含 imageParts 的 user 消息请求体断言（content 为数组、image_url url=dataURL 前缀、model id 透传）
- [ ] `tests/unit/task-message-builder.test.ts`：image manifest 注入 imageParts 且不破坏既有文本断言
- [ ] `tests/unit/attachment-ingestion.test.ts`：png fixture 摄取 → image asset + 文件落盘断言
- [ ] `tests/contract/provider-contract.test.ts`：确认非 vision adapter 对 imageParts 的显式报错路径

## 6. 测试与验收

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run tests/contract/deepseek-provider-contract.test.ts tests/unit/task-message-builder.test.ts tests/unit/attachment-ingestion.test.ts` 全绿
- [ ] 手动：`/model` 列表出现 `deepseek-v4-flash-vision-exp`；attach 图片 + 该模型 → 请求体含 image_url parts；纯文本模型 attach 图 → 显式报错
- [ ] 回归：不 attach 图片时，请求体与旧版逐字节一致（vision 开关不影响纯文本路径）
- [ ] 512KB 文本压缩路径在纯文本模型下行为不变

## 7. 风险与注意

- **exp 模型无稳定性承诺**：仅作视觉分支使用；纯文本主干保持 v4-flash 正式版（默认模型不变）。
- **base64 体积**：官方请求体上限 48MiB，单图 ≤32MiB（base64 ×4/3 ≈ 44.7MB 已逼近上限）；本地阈值 44MiB 按 base64 后字节计。多图场景需在上游约束内按张数控制（建议 M3 加每轮 ≤4 张提示，避免单请求超限）；超限提示走 Files API 或降采样。
- **图片合规**：本地图以 dataURL 直传 DeepSeek，不落第三方持久化；若未来有 URL 通道（渠道图），需合规评审。
- **会话存储不变**：跨轮图片重注入依赖 asset 文件仍在；清理附件目录会影响后续轮次回放（与现文档附件生命周期一致）。
- **不影响 MCP 方案**：方案 2 可独立并行（bridge 调用同模型），两者不冲突。

## 8. 推荐分阶段落地

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | M1+M2（模型注册、消息扩展、序列化、阈值、防呆、契约测试） | 1 个 PR，可单测全绿 |
| P2 | M3 图片摄取与注入（schema/ingestion/resolver/message-builder/unit 测试） | 1-2 个 PR |
| P3 | UX 增强（attach 图时提示切换、每轮图片数提示、渠道图片入口）；**Files API 跨轮复用同一张图**（避免每轮重传 base64，file_id 上限 64MiB）；`detail` 策略（low/original） | 后续 |

**推荐先合 P1**：模型注册即让 `/model` 可用、序列化与防呆闭环；P2 未合前手动验证可用 curl/测试夹具模拟 imageParts 直连 adapter。

