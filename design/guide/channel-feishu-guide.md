# 飞书频道集成 — 使用说明

> 🔄 迁移中 — 源位置: `docs/channel-feishu-usage-guide.md`

## 概述

Pueblo 的**频道（Channel）** 机制支持接入第三方 IM 平台。当前已实现的**飞书频道**允许用户通过飞书与 Pueblo AI Agent 对话。

架构概览：

```
飞书客户端 <--WebSocket--> 飞书开放平台 <--HTTP API--> Pueblo FeishuAdapter
                                                        │
                                                  ChannelService
                                                        │
                                                  RuntimeCoordinator
                                                        │
                                                  AI Engine (LLM)
```

---

## 一、前置准备：飞书开放平台

### 1.1 创建飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建应用」→「企业自建应用」
3. 填写应用名称（如 "Pueblo Bot"）和描述
4. 创建完成后，进入**凭证与基础信息**页面，记录以下信息：
   - **App ID**（格式：`cli_xxxxxxxxxxxxx`）
   - **App Secret**（用于 API 鉴权）

### 1.2 配置权限

在「权限管理」页面添加以下权限（需企业管理员审批）：

| 权限 | 用途 |
|---|---|
| `im:message` | 读取和发送消息 |
| `im:resource` | 获取消息中的图片/文件等资源 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |

### 1.3 配置事件订阅

1. 进入「事件与回调」→「事件配置」
2. 添加事件：`im.message.receive_v1`（接收用户消息）

> **注意**：当前实现使用**WebSocket 长连接**方式接收消息，无需配置回调 URL。

### 1.4 发布应用

1. 进入「版本管理与发布」
2. 创建版本、填写版本说明
3. 提交审核 → 审核通过后需要**点击「发布」**才会生效

### 1.5 添加机器人为好友

发布后，在飞书搜索机器人名称，将其添加至联系人，即可开始对话。

---

## 二、配置文件

频道配置保存在 `channels.json` 文件中，路径为运行目录下的 `.pueblo/channels.json`。

### 2.1 文件结构

```json
{
  "channels": [
    {
      "id": "feishu-default",
      "kind": "feishu",
      "config": {
        "appId": "cli_xxxxxxxxxxxxx",
        "appSecret": "your-app-secret-here",
        "imApiBaseUrl": "https://open.feishu.cn/open-apis"
      }
    }
  ]
}
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 频道唯一标识，用于 `/channel` 命令引用 |
| `kind` | string | 是 | 频道类型，飞书固定为 `"feishu"` |
| `config.appId` | string | 是 | 飞书开放平台应用 ID |
| `config.appSecret` | string | 是 | 飞书开放平台应用 Secret |
| `config.imApiBaseUrl` | string | 否 | 飞书 API 地址，默认 `https://open.feishu.cn/open-apis` |

### 2.3 使用凭证管理器（推荐）

`appSecret` 可存储在系统凭证管理器中，而非明文写入 `channels.json`。凭证目标名格式为：

```
channel:feishu:{channelId}
```

示例：

| 目标 | 凭据 |
|---|---|
| `channel:feishu:feishu-default` | `your-app-secret-here` |

配置文件中只需填写 `appId`，省略 `appSecret` 即可：

```json
{
  "channels": [
    {
      "id": "feishu-default",
      "kind": "feishu",
      "config": {
        "appId": "cli_xxxxxxxxxxxxx"
      }
    }
  ]
}
```

系统会优先读取配置文件中的 `appSecret`，若不存在则从凭证管理器读取。

### 2.4 多飞书频道

可配置多个飞书 Bot（不同 App ID），只需在 `channels` 数组中添加多个条目。

---

## 三、启动

### 3.1 确保配置文件就绪

确认 `./.pueblo/channels.json` 已正确配置（包含至少一个飞书频道条目）。

### 3.2 启动 CLI

```bash
npx tsx src/cli/index.ts
```

### 3.3 自动行为

启动时，Pueblo CLI 会自动：

1. 读取 `.pueblo/channels.json`
2. 创建 `ChannelService` 实例，注册 `/channel` 命令组
3. **自动连接所有已配置的频道**（尝试建立 WebSocket 连接）
4. 频道状态可通过 `/channel status <id>` 查看

连接成功后，飞书用户向机器人发送消息，消息会自动流转至 Pueblo 引擎处理并回复。

---

## 四、运行时命令

在 Pueblo CLI 中可使用以下 `/channel` 命令管理频道：

| 命令 | 说明 |
|---|---|
| `/channel list` | 列出所有已注册的频道及其状态 |
| `/channel connect <id>` | 手动连接指定频道 |
| `/channel disconnect <id>` | 断开指定频道 |
| `/channel status <id>` | 查看指定频道的连接状态 |

---

## 五、飞书端对话体验

1. 在飞书中打开与机器人的对话
2. 发送任意文本消息
3. Pueblo 收到消息后交由 AI 引擎处理
4. 回复会异步发送回飞书对话

## 六、故障排除

### 连接失败

1. 检查 `.pueblo/channels.json` 中的 App ID 和 App Secret 是否正确
2. 确认飞书应用已发布并处于启用状态
3. 使用 `/channel status <id>` 查看详细错误信息
4. 检查网络连接能否访问飞书开放平台 API

### 消息收发异常

1. 确认飞书应用的权限已完整配置（`im:message` 等）
2. 确认机器人已被添加为好友或被拉入群聊
3. 查看 CLI 日志中的详细错误信息
