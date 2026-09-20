# 飞书频道 — 简明手册

> 依据代码核对：`src/channel/channel-config.ts`、`src/channel/channel-types.ts`、
> `src/channel/channel-service.ts`、`src/channel/channel-command-router.ts`、
> `src/channel/channels/feishu/feishu-adapter.ts`、`src/commands/channel-command.ts`。
> 注意：CLI 侧 `/channel` 命令与飞书侧 `/xxx` 命令是**两套不同命令**，勿混用。

---

## 0. 生效前提

- 配置文件路径：`<启动 cwd>/.pueblo/channels.json`（代码为 `join(process.cwd(), '.pueblo')`）。
  **必须从仓库根目录启动 Pueblo**，否则读不到本目录的配置。
- 会话持久化：`<cwd>/.pueblo/channel-sessions.json`（记录"哪个飞书会话绑定哪个 agent/session"）。
- 凭据：Windows 凭据管理器，target 形如 `pueblo:feishu:<channelId>`。
- 启动后 `ChannelService.start` 只为 `enabled === true` 的条目建立连接。

---

## 1. 配置文件：填写飞书 appId / appSecret

### 1.1 推荐写法（规范形状）

```json
{
  "channels": [
    {
      "id": "feishu-1",
      "kind": "feishu",
      "name": "我的飞书机器人",
      "enabled": true,
      "transport": "long-connection",
      "options": {
        "appId": "cli_xxxxxxxxxxxx",
        "appSecret": "yyyyyyyyyyyy"
      }
    }
  ]
}
```

不想把密钥落盘时：**省略 `options.appSecret`**，改用 §1.3 的凭据命令注入。

### 1.2 字段表

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 频道唯一 id（如 `feishu-1`）；缺失 → 该条被跳过 |
| `kind` | ✅ | 固定 `"feishu"`（旧名 `type` 亦被接受）；缺失 → 跳过 |
| `name` | — | 展示名，缺省取 `id` |
| `enabled` | — | 缺省 `true`；`false` → 不启动、不连接 |
| `transport` | — | `"long-connection"`（缺省）或 `"webhook"`；**其他值被静默回落为 `long-connection`** |
| `options.appId` | ✅ | 飞书应用 App ID |
| `options.appSecret` | 条件 | 不填则从凭据库回落（§1.3） |
| `options.encryptKey` | — | 事件加密 Key（开启加密时填） |
| `options.verificationToken` | — | 事件校验 Token |
| `options.endpointUrl` | — | 长连接发现地址覆盖（旧名 `options.endpoint` 亦可） |
| `credentialTarget` | — | 覆盖凭据库 target（旧名 `credential` 亦可） |

### 1.3 appSecret 的优先级与"不落盘"方式

`FeishuAdapter.resolveSecret` 的顺序：

1. `options.appSecret`（内联，最高优先级）；
2. 否则读凭据库：`credentialTarget ?? pueblo:feishu:<频道id>`。

写入凭据库（在 CLI 输入，替换为真实值）：

```
/channel secret feishu-1 <appSecret>
```

返回 `Stored secret for channel "feishu-1"` 即成功；此后 JSON 里可不写 `appSecret`。
注：**appId 仍必须写在配置里**（凭据命令只存 appSecret），且凭据只能通过 CLI 的
`/channel secret` 写入——飞书聊天窗口里的 `/xxx` 不支持写密钥。

### 1.4 兼容层能容忍的"脏"写法

`normalizeChannelEntry` 会把下列历史写法归一化，旧文件通常仍能跑起来：

- `type` → `kind`；
- 顶层 `appId` / `appSecret` / `encryptKey` / `verificationToken` / `endpoint(Url)` / `imApiBaseUrl`
  自动收进 `options`（**仅当 `options` 内同名键为空时才回填**，`options` 优先）；
- `endpoint` → `endpointUrl`（随后删除 `endpoint`）；
- `credential` → `credentialTarget`；
- `channels` 值被 `flat(Infinity)` 拍平 → **双层嵌套 `[[{...}]]` 不会致命**；
- 顶层直接是数组 `[{...}]` 也被接受；
- 缺 `name`/`enabled`/`transport` → 取缺省值；无法解析出 `id`/`kind` 的条目被跳过并记日志。

**不被容忍**：把参数包在 `config: {...}` 里（旧文档写法的坑：`config` 不是兼容键 → appId 丢失
→ 连接失败）；非法 `transport` 值（如 `"websocket"`）。

### 1.5 当前仓库配置的状态（代码检查结论）

`.pueblo/channels.json` 目前仍是 legacy 形状：双层嵌套、`type`、顶层 `appId/appSecret`、
`transport:"websocket"`、第二条 `enabled:false` 且无子配置。

- 靠兼容层，第 1 条频道可连上（`transport` 回落为 `long-connection`）。
- 风险：`appSecret` 以**明文**存在 JSON 中；第二条缺 `appId/appSecret`，一旦 `enabled:true`，
  `connect` 会抛 `feishu options must include appId and appSecret`。
- 建议：按 §1.1 规范化，并把 appSecret 移入 §1.3 的凭据库；已明文写过的密钥建议在飞书后台轮换。

---

## 2. 交互命令（在飞书聊天窗口里发）

以 `/` 开头且属于下表白名单 → 由 `ChannelCommandRouter` 直接处理，**不进 LLM**；
未知 `/xxx` 与非 `/` 文本一样，会作为任务输入发给当前会话。
以 `//` 开头 = 转义，按字面文本发送。

| 命令 | 作用 |
|---|---|
| `/help` | 输出 Pueblo 飞书控制指令帮助 |
| `/agents` | 列出可选 Agent 实例（编号 · 名称 · profileId · 短 id · `✅当前`标记） |
| `/agent <编号\|实例id\|名称>` | **切换 Agent**；按 profile id/名称选择，实例不存在时创建默认实例 |
| `/sessions [Agent编号]` | 列出会话（不带参数=当前绑定 Agent 的会话；带编号=指定 Agent 的会话） |
| `/session <编号\|id>` | **切换会话**（在当前绑定的 Agent 范围内解析） |
| `/new [标题]` | 新建会话并选中，之后直接发消息即可开始 |
| `/status [会话id]` | 查看执行情况（只读：会话状态、任务状态、目标、最近输出） |
| `/current` | 查看当前绑定（Agent + 会话） |
| `/reset` | 清除本会话的 channel 绑定，下次对话回到默认 Agent |

补充规则（来自代码）：

- 只读命令 `help / agents / sessions / status / current` **在 CLI 正忙时也能执行**；
  其余命令（`agent / session / new / reset`）在忙碌时会被丢弃并回复提示。
- 普通文本：若 CLI 正在跑一个 turn，飞书消息会被**丢弃（不排队）**，并回复
  `⏸️ CLI 正在执行任务…可发 /status 查看进度。`；`/status` 是一直可用的进度查询入口。
- `/status` 的任务状态取值：`pending ⏳ / running 🏃 / completed ✅ / failed ❌`。
- 编号解析：`/agent 2`、`/session 3` 用最近一次列表的序号；也接受 id、名称
  （大小写/分隔符不敏感，如 `code-master` ≈ `Code Master`）。

典型流程：

```
/agents            → 选一个 Agent
/agent 2           → 切换到它（自动选中它最近的会话）
/sessions          → 看有哪些会话
/session 3         → 切到目标会话
/status            → 确认在执行/已完成
（直接发任务文本） → 进入该会话执行
/reset             → 不想再绑定时回到默认 Agent
```

---

## 3. CLI / 桌面端命令（管理频道本身，不是在飞书里发的）

```
/channel list                                   列出已配置频道
/channel add <id> <kind> <name> [optionsJson]   新增/更新频道
/channel remove <id>                            删除频道
/channel test <id>                              测试连接
/channel start <id>                             启动频道
/channel stop <id>                              停止频道
/channel status                                 查看运行中的频道
/channel secret <id> <appSecret>                写入凭据（target = pueblo:feishu:<id>）
```

---

## 4. 排障速查

| 现象 | 原因 / 处理 |
|---|---|
| `0/1 enabled channels` + `SKIP id=undefined (disabled)` | 条目没解析出 `id`/`kind`，或被误包进 `config:{...}` → 按 §1.1 改 |
| `Missing feishu options` | 该条没有 `options`，也没有可回填的顶层 `appId/appSecret` |
| `feishu options must include appId and appSecret` | `options.appId` 缺失，或凭据库里没有 `pueblo:feishu:<id>` → 跑 `/channel secret <id> <secret>` |
| 改了 JSON 不生效 | 配置在启动时读取 → 重启 Pueblo；改完可 `/channel list` 复核 |
| 发消息无反应 | 若 CLI 有 turn 在跑，消息按设计丢弃；先 `/status` |
| 命令被当成任务发给了 LLM | 命令拼写不在白名单；用 `/help` 核对，或加 `//` 强制字面 |

---

## 5. 已知不一致（代码层面，非故障）

- `src/channel/channels/feishu/feishu-config.ts` 另有 `feishuOptionsSchema`（zod，**不含 appSecret**），
  但 adapter 实际用的是 `feishu-adapter.ts` 自带的 `safeParseFeishuOptions`（校验 `appId` + `appSecret`）。
  改校验规则时注意两者可能不一致。
- `src/channel/channels/feishu/feishu-client.ts` 在本仓库**不存在**（旧文档引用过）。
- 旧凭据 target 名 `channel:feishu:{id}` 已过时，现行规则是 `pueblo:feishu:{id}`
  （或 `credentialTarget` 指定值）。
