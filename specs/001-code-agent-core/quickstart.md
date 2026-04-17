# Quickstart: Pueblo Code Agent Core

## 目标

验证 Pueblo 首轮规划产物是否覆盖 GitHub Copilot 接入、弹窗式对话窗口、command 指令管理、记忆/prompt 管理和工具调用闭环。

## 前置条件

- 已完成本地桌面环境初始化
- 已配置 GitHub Copilot 可用访问条件
- 已完成 SQLite 数据库初始化与可写校验
- 已准备可测试的本地代码库目录
- 已执行 `npm install`
- 可通过 `npm run build` 与 `npm test` 完成本地验证
- 已具备桌面壳运行所需依赖

## 验证步骤

1. 执行 `npm run build`，确认 TypeScript、桌面壳和共享核心可以成功构建。
2. 执行 `npm test`，确认 contract、integration、desktop 与 unit tests 全部通过。
3. 执行 `node dist/cli/index.js`，确认当前终端仅输出桌面对话框启动提示，并自动弹出单窗口对话界面。
4. 确认窗口中包含独立输出区与输入区，输入区左侧固定显示 `pueblo>` 标签。
5. 在输入区提交 `/help`，确认输出区显示命令列表，且未知命令提示会引导用户使用 `/help`。
6. 如果 `.pueblo/config.json` 中尚无有效 GitHub Copilot token，在输入区提交 `/auth-login`，确认输出区展示 GitHub 登录地址与 device code；完成浏览器授权后，确认命令返回登录完成反馈，并将 token 写回配置文件。
7. 在输入区提交 `/new copilot-session`，确认输出区显示 session 创建成功反馈。
8. 在输入区提交 `/model github-copilot copilot-chat`，确认输出区显示当前模型已切换到 GitHub Copilot。
9. 通过 `/prompt-add` 创建一个 prompt，再执行 `/prompt-list` 与 `/prompt-sel` 选择该 prompt。
10. 通过 `/memory-add` 创建一个 memory，再执行 `/memory-list` 或 `/memory-search` 与 `/memory-sel` 选择该 memory。
11. 在输入区提交一个普通文本任务，例如 `reply with exactly ok`，确认系统读取该文本并将其作为任务请求处理，而不是报非法命令。
12. 确认该任务通过 GitHub Copilot 工作流执行，并在输出区主区域显示 `Output Summary`。
13. 确认同一任务的 `Model Output` 以折叠块形式存在，默认不展开。
14. 确认任务过程中调用了 `glob`、`grep`、`exec` 时，输出区仍能看到结构化工具结果摘要。
15. 通过 `/session-archive` 归档当前 session，再通过 `/session-restore` 恢复并继续任务。
16. 重启程序后重新执行 `/session-list`、`/memory-list` 与 `/prompt-list`，确认 SQLite 中的持久化数据被正确读取。
17. 若需要验证恢复流程，可删除 `.pueblo/` 目录后重新启动程序，让系统自动重新建库并执行 migration。

## 预期结果

- 启动后默认移交到桌面对话框，而不是停留在一次性终端提示或旧的无参终端循环
- 输入区中的文本能够被系统可靠读取并处理，且始终保留 `pueblo>` 标签
- 用户能够通过必要 command 完成 session、model、prompt、memory 的核心操作
- GitHub Copilot 能够作为首个版本的必备 provider 成功参与任务执行
- `/auth-login` 能够完成 GitHub device flow 登录并持久化认证结果
- prompt 与 memory 能够作用于 GitHub Copilot 的任务流程
- 输出区默认主显 `Output Summary`，同时保留工具调用结果与折叠的 `Model Output`
- 工具调用结果能够用于推进代码任务
- 会话恢复后上下文保持一致
- 重启程序后结构化状态仍可从 SQLite 中恢复
- 错误输入或 GitHub Copilot 不可用时系统返回可恢复反馈

## 集成验证重点

- CLI 无参启动到桌面对话框的 handoff
- 窗口输入被系统读取并进入统一处理流程
- `/auth-login` 的 GitHub device flow 登录路径
- GitHub Copilot 接入后的任务执行闭环
- command 驱动的模型切换
- command 驱动的 session 生命周期管理
- prompt 与 memory 注入后发起 GitHub Copilot 任务
- SQLite 持久化后的 session 与 memory 快速读取
- `grep`、`glob`、`exec` 调用结果被 agent 正确使用
- `outputSummary` 主显和 `Model Output` 折叠渲染

## SQLite 启动、迁移与恢复说明

- 程序启动时会自动创建 SQLite 文件、执行 migration，并运行 `quick_check`。
- 若数据库文件不存在，系统会按配置路径自动创建父目录与数据库文件。
- 若数据库损坏或 `quick_check` 失败，系统将返回启动失败错误，而不是伪造成功状态。
- 若需要恢复到干净状态，可在退出程序后删除数据库文件，再重新启动并让 migration 自动重建结构。

## 迭代记录

- 本轮规划已将 GitHub Copilot 和单窗口弹出式对话入口纳入首个版本必要范围。
- 默认无参数启动行为已收敛为桌面对话框 handoff；终端交互模式仅作为配置关闭桌面窗口后的备用路径。
- 当前工作流仍需继续通过显式 git commit 补齐每日提交留痕。
