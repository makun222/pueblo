# 修复方案：Feishu 通道 session 冲突导致资源竞争

## 1. 问题概述

### 1.1 现象

Feishu 与 Pueblo CLI 在同一进程运行时，同时发送指令造成冲突。两个请求共用同一个 workspace 目录（`agent-{agentInstanceId}`），出现文件锁、状态不一致。

### 1.2 根因

**问题链路已通过代码审查和日志确认：**

```
Feishu onMessage
  → channel-service.ts handleInbound()   ← 正确创建 sessionId
    → runtime.submitInput(envelope)       ← 携带 sessionId
      → submitInputHandler                ← 有 sessionId
        → inputRouter.route(envelope)     ← 有 sessionId，仅用于日志
          → runTaskFromText(text, attachements, skillId)  ← sessionId 丢失！
            → runTask()
              → contextResolver.resolve({ activeSessionId: selectionState.sessionId })
                                            ← 错误使用 CLI 全局 session
```

**缺失环节**：`input-router.ts:34-36` 调用 `runTaskFromText` 时，`envelope.sessionId` 可用但被丢弃。`runTaskFromText` 的接口定义中也没有 `sessionId` 参数。

**后果**：Feishu 消息实际被路由到 CLI 当前选择的 session，而非 Feishu 新建的 session。两个任务共用同一 `agentInstanceId` → 同一 workspace 目录 → 资源竞争。

---

## 2. 修复方案

### 2.1 Bug 1（核心）：sessionId 传播中断

| 环节 | 当前代码 | 修改方案 |
|------|----------|----------|
| **A.** `InputRouterDependencies.runTaskFromText` 签名 | `(text, attachments?, skillId?)` | **增加可选参数** `sessionId?: string \| null` |
| **B.** `InputRouter.route()` 调用处 | 仅用 `envelope.sessionId` 写日志，调用时不传 | **传递** `envelope.sessionId` |
| **C.** CLI `runTaskFromText` 回调 | 不接收/传递 sessionId，调用 `runTask` 时未传 | **接收并向下传递** `sessionId` |
| **D.** CLI `runTask` 函数 | 始终使用 `selectionState.sessionId` | **优先使用传入的 sessionId**，fallback 到 `selectionState.sessionId` |

#### 修改详情

##### A. `src/commands/input-router.ts` — InputRouterDependencies 接口

**当前（第8行）：**
```typescript
readonly runTaskFromText: (
  text: string,
  attachments?: InputAttachmentManifest[],
  skillId?: string | null,
) => Promise<CommandResult<unknown>>;
```

**改为：**
```typescript
readonly runTaskFromText: (
  text: string,
  attachments?: InputAttachmentManifest[],
  skillId?: string | null,
  sessionId?: string | null,
) => Promise<CommandResult<unknown>>;
```

##### B. `src/commands/input-router.ts` — route() 方法调用处

**当前（第34-36行）：**
```typescript
return envelope.attachments.length > 0
  ? this.dependencies.runTaskFromText(trimmed, envelope.attachments, envelope.skillId ?? undefined)
  : this.dependencies.runTaskFromText(trimmed, undefined, envelope.skillId ?? undefined);
```

**改为：**
```typescript
return envelope.attachments.length > 0
  ? this.dependencies.runTaskFromText(trimmed, envelope.attachments, envelope.skillId ?? undefined, envelope.sessionId ?? undefined)
  : this.dependencies.runTaskFromText(trimmed, undefined, envelope.skillId ?? undefined, envelope.sessionId ?? undefined);
```

##### C. `src/cli/index.ts` — runTaskFromText 回调

**当前（约第1223行）：**
```typescript
const runTaskFromText = async (
  text: string,
  attachments?: InputAttachmentManifest[],
  skillId?: string | null,
): Promise<CommandResult<unknown>> => {
  return runTask(text, 'Plain-text task execution', undefined, attachments ?? [], skillId);
};
```

**改为：**
```typescript
const runTaskFromText = async (
  text: string,
  attachments?: InputAttachmentManifest[],
  skillId?: string | null,
  sessionId?: string | null,
): Promise<CommandResult<unknown>> => {
  return runTask(text, 'Plain-text task execution', undefined, attachments ?? [], skillId, sessionId);
};
```

##### D. `src/cli/index.ts` — runTask 函数

**当前签名（约第533行）：**
```typescript
const runTask = async (
  rawText: string,
  trigger: string,
  userInput: string | undefined,
  attachments: InputAttachmentManifest[],
  skillId?: string | null,
): Promise<CommandResult<unknown>> => {
```

**改为：**
```typescript
const runTask = async (
  rawText: string,
  trigger: string,
  userInput: string | undefined,
  attachments: InputAttachmentManifest[],
  skillId?: string | null,
  sessionId?: string | null,
): Promise<CommandResult<unknown>> => {
```

**当前 session 解析（约第554行）：**
```typescript
const resolvedContext = await contextResolver.resolve({
  activeSessionId: selectionState.sessionId ?? currentConfig.defaultSessionId,
```

**改为：**
```typescript
const resolvedSessionId = sessionId ?? selectionState.sessionId ?? currentConfig.defaultSessionId;
const resolvedContext = await contextResolver.resolve({
  activeSessionId: resolvedSessionId,
```

---

### 2.2 Bug 2（次优）：`createSessionForChannel` 传参类型错误

**位置**：`src/cli/index.ts` 约第1278-1282行

**当前：**
```typescript
const createSessionForChannel = async (_channelId: string, message: InboundMessage): Promise<string> => {
  const title = message.text ? `Channel: ${message.text.slice(0, 40)}` : 'Channel session';
  const agentId = selectionState.modelId ?? ensureAgentInstance();
  //    ↑ 这是 model ID（如 "claude-3-sonnet"），不是 agentInstanceId
  return (await sessionService.createSession(title, undefined, agentId)).id;
  //                                                    ↑ 类型错误
};
```

**改为：**
```typescript
const createSessionForChannel = async (_channelId: string, message: InboundMessage): Promise<string> => {
  const title = message.text ? `Channel: ${message.text.slice(0, 40)}` : 'Channel session';
  const agentInstanceId = ensureAgentInstance();
  return (await sessionService.createSession(title, undefined, agentInstanceId)).id;
};
```

**说明**：`sessionService.createSession()` 的第三个参数是 `agentInstanceId`（形如 `agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），而当前传入的是 `modelId`（如 `claude-3-sonnet`）。修复后，Feishu 消息将使用正确的 agent 实例创建独立 session。

---

## 3. 影响范围分析

### 3.1 影响的文件

| 文件 | 修改类型 | 风险 |
|------|----------|------|
| `src/commands/input-router.ts` | 接口 + 调用处 | **低风险**：仅增加可选参数，不影响现有调用者 |
| `src/cli/index.ts` | 回调函数 + `runTask` 函数 | **中风险**：需要确保 `runTask` 所有调用路径都兼容新参数 |

### 3.2 需要检查的 runTask 调用点

`runTask` 函数在 CLI 中有多个调用者，需逐一检查兼容性：

| 调用位置 | 行号（约） | 是否需要传 sessionId |
|----------|------------|---------------------|
| `runTaskFromText` | 1223 | **是** — 这是主要修改路径 |
| 其他 `runTask` 调用 | 各位置 | **否** — 可保持原样，参数为可选 |

由于 `sessionId` 是可选参数（`string | null | undefined`），所有现有调用无需修改，语义保持不变。

### 3.3 风险矩阵

| 场景 | 当前行为 | 修复后行为 | 回归风险 |
|------|----------|------------|----------|
| CLI 直接输入 | 使用 `selectionState.sessionId` | 优先用传参，无传参则用 `selectionState.sessionId` | **无** — 行为等价 |
| Desktop IPC 发消息（有 sessionId） | sessionId 丢失，用 CLI 全局 session | sessionId 传至 `runTask`，正确路由 | **正向修复** |
| Feishu 消息 | sessionId 丢失，用 CLI 全局 session | sessionId 传至 `runTask`，正确路由到独立 session | **正向修复** |
| 空 sessionId (null) | 用 CLI 全局 session | fallback 到 CLI 全局 session | **无** — 行为等价 |
| `/` 命令 | 不经过 `runTaskFromText` | 不经过 `runTaskFromText` | **无** — 不受影响 |
| 已存在的 Feishu session | 因 `createSessionForChannel` 传参错误，session 的 agent 绑定不对 | 正确基于 `agentInstanceId` 创建 session | **正向修复** |

### 3.4 测试策略

| 测试类型 | 覆盖场景 | 方法 |
|----------|----------|------|
| 单元测试 | `input-router.ts` 中 `route()` 将 `sessionId` 传入 `runTaskFromText` | mock `runTaskFromText`，验证调用参数 |
| 集成测试 | Feishu 消息创建独立 session，不干扰 CLI session | 启动 CLI，Feishu 适配器发送消息，验证两个任务使用不同 workspace |
| 回归测试 | CLI 直接输入正常 | 验证 `selectionState.sessionId` 仍被使用 |

---

## 4. 实施步骤

### 步骤 1：修改 `input-router.ts`（接口 + 调用）

1a. `InputRouterDependencies.runTaskFromText` 增加 `sessionId?: string | null` 参数
1b. `route()` 方法在第34-36行传递 `envelope.sessionId`

### 步骤 2：修改 `src/cli/index.ts`（回调 + runTask）

2a. `runTaskFromText` 回调增加 `sessionId` 参数并透传给 `runTask`
2b. `runTask` 函数增加 `sessionId` 参数
2c. `runTask` 中 session 解析逻辑改为：优先使用传入的 `sessionId`，再 fallback 到 `selectionState.sessionId`

### 步骤 3：修 `createSessionForChannel` 传参

3a. 将 `selectionState.modelId` 改为 `ensureAgentInstance()`

### 步骤 4：验证

4a. 编译检查（`npm run build` 或 `tsc --noEmit`）
4b. 单元测试覆盖修改路径
4c. 手动测试：Feishu 发送消息 + CLI 同时输入，确认使用不同 workspace 目录

---

## 5. 验证标准

- [ ] Feishu 消息使用独立 session（与 CLI 当前 session 不同）
- [ ] 两个 Feishu 消息使用不同 agent workspace 目录（`agent-<uuid-A>` 与 `agent-<uuid-B>`）
- [ ] CLI `/session-list` 显示 Feishu 创建的 session
- [ ] CLI 直接输入仍使用 `selectionState.sessionId`
- [ ] Desktop IPC 携带 sessionId 时正确路由
- [ ] `createSessionForChannel` 使用 `agentInstanceId` 而非 `modelId`
