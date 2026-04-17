# Data Model: Pueblo Code Agent Core

## Provider Profile

- **Purpose**: 描述一个可接入的模型服务来源及其可选模型集合。
- **Fields**:
  - `id`: provider 唯一标识
  - `name`: 展示名称
  - `status`: 可用状态（active, unavailable, disabled）
  - `models`: 可用模型列表
  - `defaultModelId`: 默认模型标识
  - `capabilities`: 支持能力摘要
  - `authState`: configured, missing, invalid
- **Validation Rules**:
  - `id` 必须唯一
  - GitHub Copilot 在首个版本中必须存在于 provider 集合中
  - 不可用 provider 不得作为默认当前 provider
- **Relationships**:
  - 一个 Provider Profile 包含多个模型定义
- **Persistence Notes**:
  - 存储在 SQLite 的 provider 配置表中，支持按可用状态和默认模型快速读取

## GitHub Copilot Credential Reference

- **Purpose**: 表示 GitHub Copilot 接入所需的本地凭据引用状态。
- **Fields**:
  - `providerId`
  - `credentialSource`: env, config-file, external-login
  - `status`: ready, missing, expired, invalid
  - `lastValidatedAt`
- **Validation Rules**:
  - 首个版本中 GitHub Copilot 的凭据状态必须可检测
  - invalid 或 expired 状态必须阻止任务正常发起，并返回可恢复反馈
- **Relationships**:
  - 与 `Provider Profile` 一对一关联
- **Persistence Notes**:
  - 不在业务表中保存密钥明文；只保存凭据状态和来源引用

## Model Session

- **Purpose**: 表示一次持续的 agent 协作会话。
- **Fields**:
  - `id`: session 唯一标识
  - `title`: 可读标题
  - `status`: active, archived, deleted
  - `currentModelId`: 当前生效模型
  - `messageHistory`: 历史交互列表
  - `selectedPromptIds`: 当前选中的 prompt 集合
  - `selectedMemoryIds`: 当前选中的记忆集合
  - `createdAt`, `updatedAt`, `archivedAt`
- **Validation Rules**:
  - active session 仅能有一个当前上下文焦点
  - deleted session 不得被恢复为当前活动会话，除非系统定义软删除恢复机制
- **State Transitions**:
  - active -> archived
  - archived -> active
  - active/archived -> deleted
- **Persistence Notes**:
  - 使用 SQLite 主表存储，并为 `status`、`updatedAt`、`currentModelId` 建立查询优化策略，以支持 session-list 与 session-sel 的高频读取

## Memory Record

- **Purpose**: 表示可复用的短期或长期记忆。
- **Fields**:
  - `id`
  - `type`: short-term, long-term
  - `title`
  - `content`
  - `scope`: session, project, global
  - `status`: active, expired, deleted
  - `tags`
  - `sourceSessionId`
  - `createdAt`, `updatedAt`
- **Validation Rules**:
  - `scope` 必须与可复用范围一致
  - expired 或 deleted 记忆默认不可注入任务
- **Relationships**:
  - 可与多个 session 关联使用
- **Persistence Notes**:
  - 使用 SQLite 存储，需支持按 `scope`、`status`、`tags` 和关键词的快速检索，以满足 memory-list 与 memory-search 场景

## Prompt Asset

- **Purpose**: 表示用户维护的 prompt 模板或片段。
- **Fields**:
  - `id`
  - `title`
  - `category`
  - `content`
  - `status`: active, deleted
  - `tags`
  - `createdAt`, `updatedAt`
- **Validation Rules**:
  - deleted prompt 不得被继续注入新任务
- **Persistence Notes**:
  - 使用 SQLite 存储，支持按分类、状态和最近使用时间快速读取

## Agent Task

- **Purpose**: 表示一次具体的代码工作请求。
- **Fields**:
  - `id`
  - `goal`
  - `status`: pending, running, completed, failed
  - `sessionId`
  - `modelId`
  - `providerId`
  - `inputContextSummary`
  - `outputSummary`
  - `toolInvocationIds`
  - `createdAt`, `completedAt`
- **Validation Rules**:
  - running 状态的任务必须绑定 session、provider 和 model
  - completed 或 failed 任务必须有结果摘要
  - GitHub Copilot 任务必须能追溯 prompt、memory 和 tool 上下文注入来源
- **Persistence Notes**:
  - 使用 SQLite 持久化 CLI/窗口问答与执行过程的结构化记录，支持按 session 和状态回溯执行历史

## Command Action

- **Purpose**: 表示一次 command 指令调用。
- **Fields**:
  - `id`
  - `name`
  - `targetType`: session, model, prompt, memory, system
  - `arguments`
  - `resultStatus`: succeeded, failed, no-op
  - `resultMessage`
  - `sessionId`
  - `createdAt`
- **Validation Rules**:
  - command 名称必须属于受支持指令集
  - 参数缺失时必须返回 failed 或 no-op 结果
- **Persistence Notes**:
  - 使用 SQLite 存储 command 执行日志，支持错误追踪与最近操作回放

## Tool Invocation

- **Purpose**: 表示一次工具调用行为。
- **Fields**:
  - `id`
  - `toolName`: grep, glob, exec
  - `taskId`
  - `inputSummary`
  - `resultStatus`: succeeded, failed, empty
  - `resultSummary`
  - `createdAt`
- **Validation Rules**:
  - `toolName` 仅允许 `grep`、`glob`、`exec`
  - 工具调用必须关联到一个 Agent Task
- **Persistence Notes**:
  - 使用 SQLite 存储工具调用结果摘要，支持按 task 和 toolName 查询

## Desktop Window Session

- **Purpose**: 表示一次弹窗式对话窗口交互。
- **Fields**:
  - `windowId`
  - `status`: starting, ready, busy, closing, closed
  - `activeSessionId`
  - `inputDraft`
  - `outputBlocks`
  - `createdAt`, `updatedAt`, `closedAt`
- **Validation Rules**:
  - ready 或 busy 状态必须绑定有效窗口实例
  - closed 状态不得再接收新输入
  - 输出框必须能保留同一窗口生命周期内的连续输出顺序
- **State Transitions**:
  - starting -> ready
  - ready -> busy
  - busy -> ready
  - ready/busy -> closing -> closed
- **Persistence Notes**:
  - 首版无需作为独立 SQLite 主实体持久化，可由内存态维护；仅与既有 session/task 状态联动

## Renderer Output Block

- **Purpose**: 表示窗口输出框中的一条结构化展示内容。
- **Fields**:
  - `id`
  - `type`: command-result, task-result, tool-result, error, system
  - `title`
  - `content`
  - `sourceRefs`
  - `createdAt`
- **Validation Rules**:
  - 每个输出块必须有明确类型
  - error 类型输出必须包含错误原因或下一步建议
- **Relationships**:
  - 可由 `Command Action`、`Agent Task` 或 `Tool Invocation` 派生生成
- **Persistence Notes**:
  - 首版可由主进程根据持久化实体实时生成，不要求独立落库

## IPC Input Envelope

- **Purpose**: 表示窗口输入框提交到主进程的一次载荷。
- **Fields**:
  - `requestId`
  - `windowId`
  - `sessionId`
  - `inputText`
  - `submittedAt`
- **Validation Rules**:
  - `inputText` 不得为空字符串
  - `requestId` 在同一窗口生命周期内必须唯一
- **Relationships**:
  - 可触发 `Command Action` 或 `Agent Task`
- **Persistence Notes**:
  - 首版不要求独立持久化为主实体，但其处理结果必须映射到 command/task 持久化记录

## Relationships Overview

- 一个 `Provider Profile` 可拥有一个 `GitHub Copilot Credential Reference`
- 一个 `Model Session` 可包含多个 `Agent Task`
- 一个 `Agent Task` 可关联多个 `Tool Invocation`
- 一个 `Model Session` 可选择多个 `Memory Record` 与 `Prompt Asset`
- 一个 `Command Action` 可影响 `Model Session`、`Prompt Asset` 或 `Memory Record` 的状态
- 一个 `Desktop Window Session` 可承载多个 `IPC Input Envelope` 和多个 `Renderer Output Block`
- 一个 `Desktop Window Session` 可绑定一个当前 `Model Session`
