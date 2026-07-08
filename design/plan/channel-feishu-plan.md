# Channel（外部渠道对接）特性方案 · 飞书长连接

> ✅ 已迁移 — 目标位置: `design/plan/channel-feishu-plan.md`

## 一、设计目标与定位

- **channel** = 外部渠道双向机器人：外部平台用户发消息 → pueblo agent 处理 → 回复到外部平台。
- **首个实现**：飞书，采用「长连接（WebSocket）」方案接收事件，HTTP API 回复消息。
- **运行形态**：CLI + Desktop 主进程均支持常驻 channel。
- **架构对齐**：对齐现有 `src/mcp/` 模块结构（types / config / connection / registry / adapter / service），复用 `ws`、`CredentialStore`、`RuntimeCoordinator`、`IpcInputEnvelope`、`CommandResult` 等既有抽象。

## 二、消息流向

```
飞书用户 ──(WS事件)──▶ FeishuChannelAdapter ──▶ ChannelService
   ──(构造 IpcInputEnvelope)──▶ RuntimeCoordinator.submitInput / runTaskFromText
   ──▶ agent(provider)执行 ──▶ outputSummary ──▶ ChannelService
   ──▶ FeishuChannelAdapter.send ──(HTTP IM API)──▶ 飞书会话
```

## 三、模块布局（全部新建，零侵入既有 schema/config）

```
src/channel/
  channel-types.txt            # 通用类型：ChannelConfig/Kind, InboundMessage, OutboundMessage, ChannelConnectionState, ChannelCapabilities, ChannelEventHandler, ChannelSendResult, ChannelTestResult, ChannelIpc*
  channel-errors.ts           # ChannelError / ChannelNotFoundError / ChannelAuthError / ChannelUnavailableError
  channel-config.ts           # 持久化 .pueblo/channels.json（load/save/get/upsert/delete，仿 mcp-config.ts）
  channel-connection.ts       # LongConnectionBase 抽象基类（ws 握手/心跳/指数退避重连/pending map/dispose）
  channel-adapter.ts          # ChannelAdapter 接口 + InMemoryChannelAdapter（测试用）
  channel-registry.ts         # ChannelRegistry：注册/查找 adapter（仿 ProviderRegistry / mcp-registry）
  channel-registry-factory.ts  # 由 ChannelConfig → 实例化 adapter（仿 provider-registry-factory）
  channel-service.ts          # ChannelService：多 channel 生命周期编排 + 入站→submitInput + 出站→send
  channels/
    feishu/
      feishu-types.ts          # 飞书事件 schema、token、endpoint、IM 消息类型
      feishu-config.ts         # 飞书配置 zod schema（appId/appSecret/verificationToken/encryptKey 可选）
      feishu-client.ts         # HTTP：tenant_access_token 刷新缓存、发消息、卡片
      feishu-connection.ts     # FeishuLongConnection extends LongConnectionBase
      feishu-adapter.ts        # FeishuChannelAdapter implements ChannelAdapter
  channel-command.ts          # （放在 src/commands/） /channel 子命令，注册到 dispatcher
```

## 四、通用基础类设计

### 4.1 ChannelConfig（持久化到 `.pueblo/channels.json`）
```ts
interface ChannelConfig {
  id: string;                      // 唯一 id，如 'feishu-default'
  kind: ChannelKind;               // 'feishu' | (后续 'wecom'|'dingtalk')
  name: string;
  enabled: boolean;
  transport: 'long-connection' | 'webhook';
  options: Record<string, unknown>;// 各渠道特定配置（飞书：appId/verificationToken 等）
  credentialTarget?: string;       // 凭据查找 key，如 'pueblo:feishu:<id>'
  source?: 'manual' | 'builtin';
}
interface ChannelsConfig { channels: ChannelConfig[]; }
```

### 4.2 统一消息模型
```ts
interface InboundMessage {
  channelId: string;
  externalConversationId: string; // 飞书 chat_id
  externalMessageId: string;
  senderId: string; senderName?: string;
  text: string; raw: unknown; receivedAt: number;
}
interface OutboundMessage {
  externalConversationId: string;
  text?: string; card?: unknown; replyToMessageId?: string;
}
interface ChannelSendResult { ok: boolean; externalMessageId?: string; error?: string; }
```

### 4.3 ChannelAdapter 接口（仿 ProviderAdapter）
```ts
interface ChannelCapabilities { inboundEvents: boolean; outboundReply: boolean; card: boolean; longConnection: boolean; }
interface ChannelEventHandler { onMessage(m: InboundMessage): void; onError(e: Error): void; onStatusChange(s: ChannelConnectionState): void; }
interface ChannelAdapter {
  readonly channelId: string; readonly kind: ChannelKind; readonly capabilities: ChannelCapabilities;
  readonly state: ChannelConnectionState;
  connect(config: ChannelConfig, handler: ChannelEventHandler): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<ChannelSendResult>;
  testConnection(config: ChannelConfig): Promise<ChannelTestResult>;
  dispose(): void;
}
```

### 4.4 LongConnectionBase（抽象长连接基类，复用 `ws`）
仿 `McpConnection` 的生命周期与 pending 管理，但底层为 WebSocket：
- 通用职责：open/close、指数退避重连、ping interval、pending request map + timeout、dispose、processExited/closed 状态、错误 reject pending。
- 抽象方法（子类实现）：`buildUrl()`、`buildHeaders()`、`startHandshake()`、`sendHeartbeat()`、`handleFrame(data: string)`、`shouldReconnect(code, reason)`。

### 4.5 ChannelRegistry / Factory
- `ChannelRegistry`：`register(kind, factory)`、`getAdapter(config)`、`listKinds()`。
- `channel-registry-factory.ts`：内置 `feishu` kind → `FeishuChannelAdapter`，未识别 kind 抛 `ChannelNotFoundError`。

## 五、飞书长连接实现（基于既有知识，可后续对照官方文档校验）

### 5.1 凭据与配置
- `feishu-config.ts` zod schema：`appId`、`verificationToken`（明文存 options）、`encryptKey?`、`endpointUrl?`（默认飞书开放平台）、`imApiBaseUrl`（默认 `https://open.feishu.cn/open-apis`）。
- `appSecret` 不落盘，存 Windows Credential Manager，`credentialTarget = pueblo:feishu:<id>`，复用 `createDefaultCredentialStore()`。

### 5.2 FeishuLongConnection（extends LongConnectionBase）
1. **获取连接地址**：HTTP `GET {imApiBaseUrl}/..` / 飞书长连接 endpoint 接口，得到 `wss://...` + connection_id（凭 app_id/secret 取 tenant token 后请求）。
2. **WebSocket 握手**：连接 wss；首个消息握手（endpoint ready）。
3. **心跳**：定时发 `PING` 帧；服务端回 `PONG`；超时视为断连并重连。
4. **事件分发**：`type=event` 帧解析 `header.event_type`：
   - `im.message.receive_v1` → 抽取 chat_id/message_id/sender/content.text → `handler.onMessage`。
   - `endpoint_change` → 触发重连切到新 endpoint。
5. **重连**：指数退避（初始 1s，上限 30s，抖动）；dispose 后不再重连。

### 5.3 FeishuClient（HTTP）
- `getTenantAccessToken()`：`POST {imApiBaseUrl}/auth/v3/tenant_access_token/internal`（body app_id/app_secret），结果缓存并在过期前 60s 刷新。
- `sendMessage(receiveId, receiveIdType, msgType, content)`：`POST {imApiBaseUrl}/im/v1/messages?receive_id_type=...`，Authorization: Bearer tenant_access_token。
- `replyMessage(messageId, msgType, content)`：`POST {imApiBaseUrl}/im/v1/messages/:message_id/reply`。
- 统一错误处理，映射到 `ChannelError`。

### 5.4 FeishuChannelAdapter（implements ChannelAdapter）
- `connect`：读 appSecret → 构造 FeishuLongConnection → 启动 → 状态回调 `onStatusChange`。
- `send`：根据 `OutboundMessage` 调 `FeishuClient.sendMessage` 或 `replyMessage`；card 走 `interactive` msgType。
- `testConnection`：仅做 token 获取 + endpoint 获取，不发真实消息。
- `disconnect/dispose`：委派 LongConnection。

## 六、与 pueblo 集成

### 6.1 ChannelService（多 channel 编排）
- `start(configs)`：为每个 enabled config 创建 adapter，注册 handler 并 connect。
- **入站**：`onMessage` → 查 `externalConversationId → sessionId` 映射（无则新建会话）→ 构造 `IpcInputEnvelope`（`windowId='channel:<kind>:<id>'`、`sessionId`、`inputText=text`）→ `RuntimeCoordinator.submitInput`（Desktop）或 `runTaskFromText`（CLI）。
- **出站**：订阅 agent 完成（`RuntimeCoordinator.onMessage` 过滤 task-result，匹配 requestId/windowId）→ 取 `outputSummary` → `adapter.send` 回对应会话。
- `stop()/stopChannel(id)`、`getStatus()`、`dispose()`。

### 6.2 会话映射
- `externalConversationId → pueblo sessionId` 映射存 `.pueblo/channels.json` 旁的 `channel-sessions.json`（或并入 channels.json 的 `sessions` 字段）。避免侵入 session-repository schema。

### 6.3 运行形态
- **Desktop**：Electron 主进程启动时加载 configs → `ChannelService.start` 常驻；新增 IPC（`channel:list/save/delete/test/start/stop`，类型放 `channel-ipc.ts`）供渲染层管理。
- **CLI**：启动时加载并常驻 `ChannelService`；新增 `channel-command.ts` 注册 `/channel list|add|remove|test|start|stop` 到 `CommandDispatcher`（仿 `/undo`、`/auto-save` 注册风格）。

## 七、错误处理
- `channel-errors.ts`：`ChannelError`、`ChannelNotFoundError(kind)`、`ChannelAuthError(id)`、`ChannelUnavailableError(id)`、`ChannelConnectionError(id, detail)`。与 `provider-errors.ts` / mcp 错误风格一致。

## 八、测试（遵循 vitest，tests/unit/...）
- `LongConnectionBase`：mock `ws`，验证 open/握手/心跳/重连退避/pending timeout/dispose。
- `ChannelService`：mock adapter，验证入站→submitInput 调用、出站→send 调用、会话映射复用。
- `FeishuClient`：mock fetch/HTTP，验证 token 刷新缓存与发消息载荷。
- `FeishuChannelAdapter`：mock client + connection，验证 onMessage 解析、send 选择 send/reply、testConnection。
- `channel-config`：读写 upsert/delete 边界。
- 现有约定：`npm run lint`、`npm run build:main`、`npm test`。

## 九、分阶段实施
1. **阶段一（通用基础类）**：channel-types/errors/config/connection(基类)/adapter/registry/factory/service 骨架 + 单测。
2. **阶段二（飞书 channel）**：feishu-types/config/client/connection/adapter + 单测。
3. **阶段三（集成）**：channel-command + dispatcher 注册、Desktop 主进程启动 + IPC、CLI 常驻、会话映射持久化、集成测试。
4. **阶段四（收尾）**：lint/build/test 通过，README/agent 记忆补充（如有约定）。

## 十、文件改动汇总
- **新建**：`src/channel/**`（约 12 个文件）、`src/commands/channel-command.ts`、`tests/unit/channel/**`。
- **小改**：`src/commands/dispatcher.ts`（注册 `/channel`，仅 CLI 侧）、Desktop main 入口（启动 ChannelService + 注册 IPC）。
- **不改**：`src/shared/schema.ts`、`src/shared/config.ts`（channel 独立持久化文件，避免侵入主配置）。

## 十一、待确认/风险
- 飞书长连接握手帧/PING 格式/endpoint 获取接口的具体 schema 以飞书官方为准；当前以既有知识实现，预留 `TODO` 与可配置 endpoint，便于拿到官方文档后微调。
- 多会话并发回写：默认串行回复每条入站消息，长任务回复以最终 outputSummary 为准（暂不做流式分片）。
