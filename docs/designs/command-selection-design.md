# Commands: Model / Provider / Agent Profile Selection

> 设计日期: 2025-07  
> 状态: 已实现

---

## 1. 目标

开发三个 CLI 斜杠指令，让用户能在运行时选择/切换：

| 指令 | 用途 | 类型 |
|---|---|---|
| `/model` | 查看和选择当前使用的模型 | 增强现有（已有 skeleton） |
| `/provider` | 查看和选择当前使用的 Provider | 新建 |
| `/agent` | 查看和切换 Agent Profile 模板 | 新建 |

以及一个已存在的 `/provider-config`（配置凭据，不变）。

---

## 2. 现有代码分析汇总

### 2.1 会话与服务层

- **SessionService**: `createSession(title, modelId?, agentInstanceId?) → Session`  
  创建新 session 时绑定 agentInstanceId。当前 session 通过 `getCurrentSession()` 获取。

- **AgentInstanceService**: `getOrCreateDefaultAgentInstance(profileId, workspace) → AgentInstance`  
  根据 profileId 创建/获取 agent 实例。  
  `markActive(agentInstanceId)` 将实例标记为活跃。

- **ModelService**: `listModels(providerId?) → ModelInfo[]`  
  按 provider 列出可用模型。

- **ProviderRegistry**: `getProviders() → ProviderInfo[]`，`getProvider(id) → Provider | undefined`  
  管理所有已注册的 Provider 实例。

### 2.2 CLI 运行态状态

CLI 主循环维护以下状态变量：

```
activeAgentProfileId: string | null    // 当前选中的 agent profile
activeAgentInstanceId: string | null   // 当前活跃的 agent 实例 ID
selectionState: CommandSelectionState   // 包含 providerId, modelId
```

### 2.3 选择生效时机

| 状态变量 | 何时生效 |
|---|---|
| `selectionState.providerId` | 下次发送 goal 时用于选择 provider |
| `selectionState.modelId` | 下次创建 session / 发送 goal 时用于选择模型 |
| `activeAgentProfileId` | 下次 `ensureAgentInstance()` 时创建对应 agent，用于新 session |

### 2.4 现有命令文件

| 文件 | 现状 |
|---|---|
| `src/commands/model-command.ts` | 已有骨架，**未注册到 dispatcher** |
| `src/commands/provider-config-command.ts` | 已有完整实现，**未注册到 dispatcher** |
| `src/commands/prompt-command.ts` | 已有完整实现，**未注册到 dispatcher** |

---

## 3. 关键设计决策

### 决策 1: `/agent` 选择后的 Session 行为——恢复 vs 新创建

**结论：调用 `cli.startAgentSession(profileId)`，它会自动恢复已有 session 或创建新 session。**

现有代码分析表明，`cli.startAgentSession(profileId)` 的实际行为是：

```
startAgentSession(profileId):
  1. agentInstanceService.getOrCreateDefaultAgentInstance(profileId)
     → 返回 profile 的默认 AgentInstance（同名 profile 共享同一个默认实例）
  2. sessionService.getMostRecentSessionForAgentInstance(agentInstance.id)
     → 查询该 AgentInstance 下是否有历史 session
  3. 如果存在 → 恢复该 session（resume），设置为当前 session
  4. 如果不存在 → 等待用户输入 goal 时创建新 session
```

这一机制已经完整支持用户故事中的「切换回 code-master 继续未完成任务」场景：
- Session 通过 `agentInstanceId` 关联到 AgentInstance
- AgentInstance 通过 `getOrCreateDefaultAgentInstance(profileId)` 关联到 Profile
- 同一 profile 切换回来时，`getMostRecentSessionForAgentInstance` 返回上次的 session，自动恢复上下文

**行为**：`/agent writer` → `startAgentSession('writer')` → 自动恢复 writer 的最近 session（或等待新 goal）。

**不需要额外实现 agent-session 映射表**，现有的 `agentInstanceId` → session 关系已经满足需求。

### 决策 2: Provider 选择后如何自动选择模型？

**策略：**

```
/provider set <id>:
  1. 获取 Provider 的 defaultModelId（如果 provider 有默认模型配置）
  2. 若 defaultModelId 存在且模型列表中有对应模型
     → selectionState.modelId = defaultModelId
  3. 若没有默认模型
     → 调用 modelService.listModels(providerId) 取第一个可用模型
     → selectionState.modelId = firstModel.id
  4. 更新 selectionState.providerId = providerId
```

**交互式选择（无参数）**：
用 `@inquirer/select` 列出所有 provider，选中后自动按上述策略选择模型。

### 决策 3: 复用现有代码

| 命令 | 文件 | 复用策略 |
|---|---|---|
| `/model` | `src/commands/model-command.ts` | **增强** — 增加 `modelService` 依赖，支持 `list`/`set`/`current` 子命令 |
| `/provider` | **新建** `src/commands/provider-command.ts` | 新建文件，复用 `ProviderRegistry`、`ModelService` 和选择模式 |
| `/agent` | **新建** `src/commands/agent-command.ts` | 新建文件，复用 `AgentInstanceService` 和 profile 模板列表 |
| `/provider-config` | `src/commands/provider-config-command.ts` | **不变**，仅注册到 dispatcher |

---

## 4. 详细命令设计

### 4.1 `/model` 命令

```
/model            → 交互式选择（@inquirer/select）
/model list       → 列出所有可用模型
/model set <id>   → 直接设置模型
/model current    → 显示当前模型
```

**接口**：
```typescript
export function createModelCommand(deps: {
  modelService: ModelService;
  getCurrentSessionId: () => string | null;
  setCurrentSessionModel: (sessionId: string, modelId: string) => void;
  setSelection: (providerId: string, modelId: string) => void;
}): CommandGroup;
```

**关键逻辑**：
- `modelService.listModels()` 返回当前 provider 的可用模型列表
- 无参数时用 `@inquirer/select` 展示交互选择
- 调用 `setSelection` 更新 provider 和 model 选择
- 调用 `setCurrentSessionModel` 持久化到会话

### 4.2 `/provider` 命令（新建）

```
/provider            → 交互式选择 provider
/provider list       → 列出所有已注册 provider
/provider set <id>   → 设置 provider（自动选择默认/首个模型）
/provider current    → 显示当前 provider
```

**接口**：
```typescript
export function createProviderCommand(deps: {
  listProviderProfiles: () => ProviderProfile[];
  setSelection: (providerId: string, modelId?: string) => void;
  getSelection: () => { providerId: string | null; modelId: string | null };
}): CommandGroup;
```

**关键逻辑**：
- `listProviderProfiles()` → 列表
- 选择后执行 **决策 2** 的模型自动选择逻辑
- 通过 `setSelection` 和 `getSelection` 访问选择状态

### 4.3 `/agent` 命令（新建）

```
/agent             → 交互式选择 agent profile
/agent list        → 列出所有 profile 模板
/agent set <id>    → 直接切换 profile
/agent current     → 显示当前 profile
```

**接口**：
```typescript
export function createAgentCommand(deps: {
  listAgentProfiles: () => AgentProfileDescriptor[];
  startAgentSession: (profileId: string) => Promise<SwitchAgentResult>;
}): CommandGroup;
```

**关键逻辑**：
1. `listAgentProfiles()` → `AgentProfileDescriptor[]`
2. 选择/指定目标 profile ID
3. **如果当前有活跃 session，先检查是否需要提示用户**（见下方 UX 流程）
4. 调用 `startAgentSession(profileId)`，由 CLI 层实现完整的切换流程：
   ```
   startAgentSession(profileId):
     ① agentInstanceService.getOrCreateDefaultAgentInstance(profileId)
     ② 更新 activeAgentProfileId / activeAgentInstanceId
     ③ sessionService.getMostRecentSessionForAgentInstance(agentInstanceId)
     ④ 如果返回 session → 恢复为当前 session（resume）
     ⑤ 如果无 session → 等待用户输入 goal 后创建
   ```
5. 根据结果提示用户：
   - **有历史 session 可恢复**：*"Switched to agent '{name}'. Restored previous session ({rounds} rounds)."*
   - **全新会话**：*"Switched to agent '{name}'. Enter a goal to start a new session."*

### 4.3.1 Agent 切换的 UX 流程

当用户通过 `/agent` 切换时，需考虑当前 session 状态：

```
用户输入 /agent writer
    │
    ├─ 当前是否有活跃 session？
    │   ├─ 否 → 直接执行 startAgentSession('writer')
    │   └─ 是 → 判断当前 session 状态
    │
    ├─ 当前 session 已完成（任务结束）？
    │   └─ 是 → 直接切换，无需提示
    │
    └─ 当前 session 活跃中（有多轮对话）？
        └─ 提示用户：
           "Current session ({agentName}, {rounds} rounds) will be suspended.
            Continue switching? [Y/n]"
           → Y → 执行切换（当前 session 保持 active 状态，不修改）
           → n → 取消操作
```

**重要设计决策**：切换时**不修改原 session 状态**（不设为 archived），仅切换当前指针。因为：
- Session 的 `status` 字段（active/archived/deleted）是对应**任务完成状态**的
- Agent 切换只是临时性的「暂停焦点」，不是任务完成
- 切换回来后 `startAgentSession` 自动恢复最近 session

### 4.4 `/provider-config`（不变）

现有 `provider-config-command.ts` 已经处理 API Key 等凭据配置，**只做注册接入**。

---

## 5. 注册到 Dispatcher

所有命令统一在 `createCliDependencies()` 中通过**闭包注入函数引用**注册，不再直传服务对象：

```typescript
// === 已存在的命令（增强/接入） ===
dispatcher.register(
  '/model',
  createModelCommand({
    modelService,
    getCurrentSessionId: () => selectionState.sessionId,
    setCurrentSessionModel: (sessionId: string, modelId: string): void => {
      sessionService.setCurrentModel(sessionId, modelId);
    },
    setSelection(providerId: string, modelId: string): void {
      selectionState.providerId = providerId;
      selectionState.modelId = modelId;
    },
  }),
);

// === 新建命令 ===
dispatcher.register('/provider', createProviderCommand({
  listProviderProfiles: () => providerRegistry.listProfiles(),
  setSelection: (providerId: string, modelId?: string) => {
    selectionState.providerId = providerId;
    if (modelId) selectionState.modelId = modelId;
  },
  getSelection: () => ({
    providerId: selectionState.providerId,
    modelId: selectionState.modelId,
  }),
}));

dispatcher.register('/agent', createAgentCommand({
  listAgentProfiles: () => agentInstanceService.listProfileTemplates(),
  startAgentSession: async (profileId: string) => {
    await syncSelectionFromSession();
    activeAgentProfileId = profileId;
    const instance = agentInstanceService.getOrCreateDefaultAgentInstance(
      profileId, currentWorkspace
    );
    activeAgentInstanceId = agentInstanceService.markActive(instance.id);
    const session = await sessionService.getMostRecentSession(instance.id)
      ?? await sessionService.createSession(instance.id);
    await sessionService.selectSession(session.id);
    await syncSelectionFromSession();
  },
}));

// === 已存在的命令（不变） ===
dispatcher.register('/provider-config', createProviderConfigCommand({
  sessionService,
  tuiService,
}));
```

### `/agent` 命令的特殊处理

`/agent` 不需要单独的 `onSwitchAgent` 回调或 `SwitchAgentResult` 接口；`startAgentSession` 闭包封装了所有 session 恢复/创建逻辑，命令仅依赖 `listAgentProfiles` 和 `startAgentSession` 两个函数引用。

---

## 6. 代码变更清单

| # | 文件 | 变更类型 | 状态 |
|---|---|---|---|
| 1 | `src/commands/model-command.ts` | 增强 | ✅ 已实现 |
| 2 | `src/commands/provider-command.ts` | 新建 | ✅ 已实现 |
| 3 | `src/commands/agent-command.ts` | 新建 | ✅ 已实现 |
| 4 | `src/cli/index.ts` | 修改 | ✅ 已实现 — 闭包注入注册三个命令 |
| 5 | `src/commands/dispatcher.ts` | 增强 | ✅ 已实现 — 支持 `listProfiles` 扩展 |

无需变动的文件：
- `src/commands/provider-config-command.ts` — 仅注册
- `src/commands/prompt-command.ts` — 与本目标无关
- `src/providers/provider-registry.ts` — 无需修改
- `src/providers/model-service.ts` — 无需修改
- `src/agent/agent-instance-service.ts` — 无需修改

---

## 7. 实施顺序

1. 增强 `src/commands/model-command.ts`（增加 modelService + selectionState 支持）
2. 新建 `src/commands/provider-command.ts`（provider 选择 + 自动模型选择）
3. 新建 `src/commands/agent-command.ts`（agent profile 选择）
4. 修改 `src/cli/index.ts`（注册三个命令，提供 `/agent` 回调）
5. 验证所有路径（有参数/无参数/交互模式）

---

## 8. 风险与注意事项

- **`/agent` 与 CLIPluginHost 接口**：`listAgentProfiles()` 和 `startAgentSession()` 已在 CLIPluginHost 接口中定义（`src/cli/index.ts:189-190`）。`/agent` 命令可以复用 `agentInstanceService.listProfileTemplates()` 和 `agentInstanceService.getOrCreateDefaultAgentInstance()`，与 CLIPluginHost 中的行为一致。
- **模型列表过滤**：`modelService.listModels()` 可能已按当前 provider 过滤，需确认是否需要在 `/model` 中额外处理。
- **用户确认（已在 4.3.1 中设计）**：切换 agent 时如果当前 session 有多轮对话（活跃中），应提示用户确认。使用 `@inquirer/confirm` 在前端实现。切换**不修改**原 session 状态（保持 active），仅切换当前指针。
