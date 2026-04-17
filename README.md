# Pueblo

Pueblo 是一个基于 TypeScript + Node.js 的 CLI 代码 agent，当前版本已经实现：

- 默认从 CLI 启动并 handoff 到桌面对话框
- GitHub Copilot provider / model 选择
- session 生命周期管理
- prompt 与 memory 管理
- `grep`、`glob`、`exec` 三类必要工具调用
- SQLite 本地持久化

## 运行环境

- Node.js 22 LTS
- npm 10+
- Windows、macOS、Linux

## 安装依赖

```bash
npm install
```

## 必要配置

Pueblo 默认从 `.pueblo/config.json` 读取本地配置。如果该文件不存在，程序会使用内置默认值，并在首次运行时自动创建 SQLite 数据库文件目录。

当前版本建议直接使用 GitHub Copilot 作为默认 provider。推荐先手动创建 `.pueblo/config.json`：

<!-- markdownlint-disable MD034 -->
```json
{
  "databasePath": ".pueblo/pueblo.db",
  "defaultProviderId": "github-copilot",
  "defaultSessionId": null,
  "desktopWindow": {
    "enabled": true,
    "title": "Pueblo",
    "width": 1200,
    "height": 820
  },
  "providers": [
    {
      "providerId": "github-copilot",
      "defaultModelId": "copilot-chat",
      "enabled": true,
      "credentialSource": "config-file"
    }
  ],
  "githubCopilot": {
    "oauthClientId": "YOUR_GITHUB_OAUTH_APP_CLIENT_ID",
    "tokenType": "github-auth-token",
    "apiUrl": "https://api.githubcopilot.com/chat/completions",
    "exchangeUrl": "https://api.github.com/copilot_internal/v2/token",
    "deviceCodeUrl": "https://github.com/login/device/code",
    "oauthAccessTokenUrl": "https://github.com/login/oauth/access_token",
    "scopes": [],
    "userAgent": "Pueblo/0.1.0",
    "editorVersion": "vscode/1.99.0",
    "editorPluginVersion": "copilot-chat/0.43.0",
    "integrationId": "vscode-chat"
  }
}
```
<!-- markdownlint-enable MD034 -->

当前实现说明：

- `databasePath`：SQLite 文件路径
- `defaultProviderId`：默认 provider 标识
- `defaultSessionId`：默认 session，可为 `null`
- `desktopWindow.enabled`：无参数启动时是否默认移交到桌面对话框
- `providers`：当前启用的 provider 列表；本轮 operator 文档以 `github-copilot` 为基线
- `githubCopilot.oauthClientId`：GitHub OAuth App 的 device flow client id
- `githubCopilot.token` / `tokenType`：登录后持久化保存的凭据；`/auth-login` 成功后会自动写回配置文件

GitHub Copilot 启动引导说明：

- 当 CLI 中执行 `/auth-login`，且默认 provider 为 `github-copilot` 但 token 缺失或当前 token 被识别为无效 PAT 时，Pueblo 会进入 device flow 引导。
- CLI 会输出 GitHub 登录地址和 device code，用户在浏览器中完成登录与授权。
- 授权完成后，CLI 会轮询 GitHub OAuth device flow 接口拿到 `github-auth-token`，并自动写回 `.pueblo/config.json`。
- 当前实现会优先直接使用 `github-auth-token` 调用 Copilot chat API；只有直接调用返回鉴权失败时，才会回退到 `exchangeUrl` 做 token exchange。
- 设备登录要求你先准备一个开启了 device flow 的 GitHub OAuth App `client_id`，并填写到 `githubCopilot.oauthClientId`。

## 构建项目

```bash
npm run build
```

构建产物输出到 `dist/`。

## 运行测试

```bash
npm test
```

## 启动方式

默认桌面对话框启动：

```bash
node dist/cli/index.js
```

启动后当前终端流程会移交给新的桌面对话框窗口。新窗口包含独立输出区和输入区，输入区沿用 `pueblo>` 标签，输出区用于展示 `outputSummary`、工具调用结果以及折叠后的 `Model Output` 元数据。

如果你需要执行一次性命令：

```bash
node dist/cli/index.js "/help"
```

桌面对话框中可直接输入：

- `/new my-session`
- `/auth-login`
- `/help`
- `/model github-copilot copilot-chat`
- `/task-run inspect workflow`
- 普通文本任务，例如 `inspect workflow`

或者先构建后通过 bin 入口运行：

```bash
npm run build
node dist/src/cli/index.js "/ping"
```

说明：`package.json` 中的 `dev` 脚本当前实际运行的是构建产物；最稳妥的方式仍然是先执行 `npm run build`，再运行 `dist/cli/index.js`。

说明：稳定 CLI 入口是 `dist/cli/index.js`。它会转发到实际实现 `dist/src/cli/index.js`，因此两者现在都可运行，但优先使用前者。

说明：如果 `desktopWindow.enabled` 设为 `false`，无参数启动会退回到终端交互模式。终端模式同样支持 `/help`、`/auth-login`、slash command 和普通文本任务，并可通过 `/exit` 或 `/quit` 退出。

## 常用命令示例

创建并切换 session：

```bash
node dist/cli/index.js "/new my-session"
```

查看 session 列表：

```bash
node dist/cli/index.js "/session-list"
```

选择模型：

```bash
node dist/cli/index.js "/model github-copilot copilot-chat"
```

创建并选择 prompt：

```bash
node dist/cli/index.js "/prompt-add bugfix code Analyze root cause first"
node dist/cli/index.js "/prompt-list"
node dist/cli/index.js "/prompt-sel <prompt-id>"
```

创建并选择 memory：

```bash
node dist/cli/index.js "/memory-add session repo-use SQLite session persistence"
node dist/cli/index.js "/memory-list"
node dist/cli/index.js "/memory-sel <memory-id>"
```

执行任务：

```bash
node dist/cli/index.js "/task-run inspect workflow"
```

如果已经在桌面对话框中启动，也可以直接输入普通文本，例如：

```text
inspect workflow
```

文本会通过统一输入路由进入 task workflow，而不是被当作非法命令拒绝。

任务执行时会自动串联最小工具工作流：

- `glob`：匹配 `src/**/*.ts`
- `grep`：搜索代码内容
- `exec`：执行 `node -v`

## 当前支持的命令

- `/ping`
- `/help`
- `/new`
- `/session-list`
- `/session-sel`
- `/session-archive`
- `/session-restore`
- `/session-del`
- `/auth-login`
- `/model`
- `/prompt-list`
- `/prompt-add`
- `/prompt-sel`
- `/prompt-del`
- `/memory-list`
- `/memory-add`
- `/memory-sel`
- `/memory-search`
- `/task-run`

## SQLite 数据文件

程序启动时会自动：

- 创建 `.pueblo/` 目录
- 创建 SQLite 数据库文件
- 执行 migration
- 执行 `quick_check`

如果需要重置本地状态：

1. 退出 CLI
2. 删除 `.pueblo/pueblo.db` 或整个 `.pueblo/` 目录
3. 重新执行 `npm run build`
4. 再次运行 CLI，让系统自动重建数据库

## 已知限制

- 当前 operator 文档只覆盖 GitHub Copilot 首要路径，额外 provider 不属于本轮已验证范围
- `exec` 当前使用 `shell: true`，测试可以通过，但 Node 会提示安全相关弃用警告；后续应继续收敛
- 当前 README 记录的是“跑通当前版本”的必要步骤，不等于生产级部署文档

## 参考文档

- 功能规格：`specs/001-code-agent-core/spec.md`
- 任务清单：`specs/001-code-agent-core/tasks.md`
- 快速验证：`specs/001-code-agent-core/quickstart.md`
