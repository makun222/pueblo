# Research: Pueblo Code Agent Core

## 决策 1：首个版本必须内建 GitHub Copilot 接入

- **Decision**: 将 GitHub Copilot 作为首个版本的必备 provider，而不是可选扩展。
- **Rationale**: 更新后的规格已明确要求 GitHub Copilot 不是延期项。若不在首版中纳入该 provider，模型能力、prompt/memory 管理和工具调用在目标工作流中都无法满足验收要求。
- **Alternatives considered**:
  - 只保留通用 provider 抽象：无法满足首版必选接入要求。
  - 延后到第二阶段：与更新后的 spec 冲突。

## 决策 2：使用 Electron 作为桌面交互壳

- **Decision**: 使用 Electron 提供单窗口桌面壳，并在 renderer 中使用 React 构建输入框与输出框。
- **Rationale**: 现有核心逻辑已经建立在 Node/TypeScript 上，包括命令分发、SQLite 持久化、任务编排与工具调用。Electron 可以直接复用这些能力，并以最小改动提供弹窗式窗口体验。
- **Alternatives considered**:
  - 仅增强终端交互循环：不满足“弹出窗口”要求。
  - Tauri：包体更轻，但需要 Rust 运行时和额外桥接，不符合当前必要功能优先原则。
  - 自建 Web 界面：需要本地服务层与更多部署约束，超出首版必要范围。

## 决策 3：React 仅作为视图层，业务逻辑继续留在共享核心

- **Decision**: React renderer 只负责输入展示、输出渲染和状态订阅；命令处理、任务执行、GitHub Copilot 调用、SQLite 访问和工具调用继续保留在主进程与共享核心模块。
- **Rationale**: 这样可以保持 CLI 与桌面壳共用同一条业务链路，避免产生第二套执行逻辑与状态分叉。
- **Alternatives considered**:
  - 在 renderer 中直接处理业务逻辑：会打破模块边界，并将敏感能力暴露到 UI 层。
  - 完全新建桌面专用后端：与现有 CLI 核心重复，范围过大。

## 决策 4：窗口输入统一走单一提交合同

- **Decision**: 窗口输入框通过统一 `submitInput` 合同把文本发送到主进程；主进程根据文本是否为 slash command 决定走 command 路由还是任务执行语义。
- **Rationale**: 单一入口可以保证输入框中的普通文本和 slash command 都复用同一套上下文、会话与任务处理逻辑，降低前端复杂度。
- **Alternatives considered**:
  - slash command 与普通文本分成两套 IPC：会增加界面判断复杂度和维护成本。
  - 让 renderer 自行决定业务路径：会使视图层承担不必要的业务职责。

## 决策 5：GitHub Copilot 的 prompt、memory 与工具调用由共享任务编排统一注入

- **Decision**: prompt、memory 和 `grep`/`glob`/`exec` 工具调用不为 GitHub Copilot 单独建立特殊前端路径，而是在任务编排层统一注入，再由 GitHub Copilot 调用链消费。
- **Rationale**: 规格要求 GitHub Copilot 必须具备 prompt、memory 和工具使用能力。将这些上下文注入放在共享编排层可以减少 provider 特化逻辑，并保证未来扩展 provider 时可复用。
- **Alternatives considered**:
  - 将 prompt/memory/tool 逻辑散落在 provider 适配器中：会导致耦合加重、测试复杂。
  - 仅让 GitHub Copilot 处理自然语言，不接工具：不满足规格。

## 决策 6：IPC 合同保持最小化且结构化

- **Decision**: 采用最小 IPC 合同：renderer -> main 包含 `submitInput`、`cancelTask`、`getSessionSnapshot`、`subscribeSession`；main -> renderer 返回 `sessionUpdated`、`taskEvent`、`commandCompleted`、`commandFailed` 与输出块。
- **Rationale**: 只传递输入文本、任务标识、会话快照和输出块，可以避免数据库、文件系统和执行细节外泄，并使 contract tests 更稳定。
- **Alternatives considered**:
  - 暴露任意调用 IPC：接口过宽，不利于安全收敛。
  - 只做同步请求/响应：不利于任务流式反馈和多轮交互。

## 决策 7：测试采用“共享核心 + IPC 边界 + 少量桌面烟测”分层策略

- **Decision**: 保持现有核心单元/集成测试，新增桌面窗口启动测试、输入输出 contract tests、GitHub Copilot 接入集成测试与少量 Electron 烟测。
- **Rationale**: 大多数逻辑仍在共享核心中，可继续通过既有测试模式覆盖；桌面层重点验证窗口是否弹出、输入是否被读取、输出是否持续展示，以及 GitHub Copilot 工作流是否闭环。
- **Alternatives considered**:
  - 只做桌面端到端测试：反馈慢且脆弱。
  - 不做桌面层测试：无法证明“窗口 + 输入框 + 输出框”需求成立。

## 决策 8：首版桌面交互仅支持单窗口简洁壳层

- **Decision**: 首个版本仅支持单窗口弹出式对话壳层，不支持复杂多窗口管理、多页面导航或控制台式前端系统。
- **Rationale**: 用户当前需要的是“弹出窗口、包含输入框和输出框，并能读取处理输入”的必要能力。进一步扩展多窗口和多页面会超出当前必要范围。
- **Alternatives considered**:
  - 一次性设计完整桌面工作台：范围过大，违背 only necessary。
  - 只做最简单文本框不保留会话上下文：无法满足已有 session/memory/prompt 工作流。
