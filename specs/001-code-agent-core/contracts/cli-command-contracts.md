# CLI And Desktop Contracts: Pueblo Code Agent Core

## Overview

本合同定义 Pueblo 首版对外暴露的必要 command 指令、桌面窗口输入/输出协议，以及 GitHub Copilot 工作流中的工具调用行为。目标是保证命令语义一致、窗口输入可被可靠读取、状态变化清晰、失败反馈可恢复，并为后续扩展更多 provider 与界面入口预留空间。所有关键结构化状态变化 MUST 持久化到 SQLite，本地数据库查询 MUST 能支撑 session、memory、prompt 等高频读取场景。

## Desktop Window Contracts

### Window Launch

- **Purpose**: 程序启动后自动弹出单窗口对话界面
- **Success Output**:
  - 窗口已显示
  - 输入框已可编辑
  - 输出框已可展示系统反馈
- **Failure Output**:
  - 窗口启动失败原因
  - 下一步建议

### `submitInput`

- **Purpose**: 将输入框文本提交给主进程处理
- **Input**:
  - `requestId`
  - `windowId`
  - `sessionId`（可选）
  - `inputText`
- **Behavior Contract**:
  - 当 `inputText` 以 `/` 开头时，按 command 语义处理
  - 当 `inputText` 不以 `/` 开头时，按普通任务文本语义处理
- **Success Output**:
  - 返回一个或多个结构化输出块
  - 如触发任务执行，允许继续返回后续事件或摘要
- **Failure Output**:
  - 明确错误原因
  - 至少一个下一步建议

### Output Block

- **Purpose**: 定义输出框展示的最小结构单元
- **Fields**:
  - `id`
  - `type`: `command-result`、`task-result`、`tool-result`、`error`、`system`
  - `title`
  - `content`
  - `sourceRefs`
- **Behavior Contract**:
  - 同一次输入可生成多个输出块
  - 输出块必须保持生成顺序
  - 输出块必须能明确区分模型结果、记忆来源、prompt 来源与工具调用结果

### `subscribeSession`

- **Purpose**: 让 renderer 订阅当前会话状态与任务输出变化
- **Output**:
  - 当前会话摘要
  - 当前任务状态变化
  - 新增输出块

## Session Commands

### `/new`

- **Purpose**: 创建并切换到新 session
- **Input**: 可选标题或上下文初始化信息
- **Success Output**:
  - 新 session 已创建
  - 当前活动 session 已切换
- **Failure Output**:
  - 创建失败原因
  - 下一步建议

### `/session-list`

- **Purpose**: 查看已生成 session
- **Success Output**:
  - session 列表
  - 每项至少包含标识、标题、状态、最近更新时间
- **Persistence Contract**:
  - 结果来自 SQLite 中的 session 查询结果

### `/session-sel`

- **Purpose**: 选择指定 session
- **Input**: session 标识或可选序号
- **Success Output**:
  - 当前活动 session 已切换

### `/session-archive`

- **Purpose**: 归档指定 session

### `/session-restore`

- **Purpose**: 恢复已归档 session

### `/session-del`

- **Purpose**: 删除指定 session
- **Constraint**: 删除后必须明确反馈状态变化

### `/session-import-memories`

- **Purpose**: 将指定 source session 的 session-scoped memories 导入当前活动 session
- **Input**: source session id
- **Success Output**:
  - 当前 session 的 memory 选择集已更新
  - 返回导入后的 session 状态

## Model Command

### `/model`

- **Purpose**: 切换当前任务模型
- **Input**: provider/model 选择信息
- **Success Output**:
  - 当前生效模型
  - 切换后的适用上下文
- **Provider Constraint**:
  - 首个版本必须支持 GitHub Copilot

## Prompt Commands

### `/prompt-list`

- **Purpose**: 查看已生成 prompt

### `/prompt-sel`

- **Purpose**: 选择指定 prompt 注入当前任务

### `/prompt-del`

- **Purpose**: 删除指定 prompt

## Memory Commands

### `/memory-list`

- **Purpose**: 查看已生成 memory

### `/memory-sel`

- **Purpose**: 选择指定 memory 注入当前任务

### `/memory-search`

- **Purpose**: 手动检索并选择需要注入的记忆
- **Success Output**:
  - 匹配到的记忆列表
  - 选择结果
- **Persistence Contract**:
  - 检索结果来自 SQLite 中的 memory 查询结果

## GitHub Copilot Provider Contract

### Provider Access

- **Purpose**: 建立 GitHub Copilot 的任务请求与结果接收能力
- **Input Contract**:
  - 用户可用的 GitHub Copilot 配置或凭据来源
  - 当前 session、prompt、memory、task 上下文
- **Output Contract**:
  - 模型结果
  - 错误反馈
  - 结果来源说明
- **Failure Contract**:
  - 当凭据缺失、失效、过期或授权不足时，必须返回明确原因和恢复建议

## Tool Invocation Contracts

### `grep`

- **Purpose**: 在指定范围内搜索内容
- **Input Contract**:
  - 搜索目标
  - 搜索范围
- **Output Contract**:
  - 匹配结果列表或空结果说明

### `glob`

- **Purpose**: 在指定范围内匹配文件路径
- **Input Contract**:
  - 匹配模式
  - 搜索范围
- **Output Contract**:
  - 命中文件列表或空结果说明

### `exec`

- **Purpose**: 执行受支持命令操作
- **Input Contract**:
  - 命令内容
  - 作用上下文
- **Output Contract**:
  - 执行结果摘要
  - 成功/失败状态
  - 若失败，附带下一步建议

## Common Error Contract

- 对未知 command、参数不完整、状态不允许的 command、工具失败、工具无结果、GitHub Copilot 不可用、窗口输入无法读取等情况，系统 MUST 返回：
  - 明确错误原因
  - 当前上下文信息
  - 至少一个可执行的下一步建议

## Persistence Contract

- CLI 问答过程、窗口交互过程中的关键结构化状态 MUST 持久化到 SQLite
- session、memory、prompt 的读取接口 MUST 面向高频查询场景设计
- GitHub Copilot 任务记录、工具调用记录和命令调用记录 MUST 可追溯
- 写入失败时 MUST 返回明确错误，并不得伪造成功状态
