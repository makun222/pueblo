# Implementation Plan: Pueblo Code Agent Core

**Branch**: `master` | **Date**: 2026-04-15 | **Spec**: `D:\workspace\trends\pueblo\specs\001-code-agent-core\spec.md`
**Input**: Feature specification from `D:\workspace\trends\pueblo\specs\001-code-agent-core\spec.md`

**Note**: 本计划基于更新后的规格重新生成，首个版本现在明确包含 GitHub Copilot 接入、单窗口弹出式对话壳层、prompt/memory 管理，以及 `grep`、`glob`、`exec` 工具调用闭环。

## Summary

构建一个以 CLI 核心能力为基础、同时提供简洁桌面弹窗窗口的代码 agent。首个版本必须支持 GitHub Copilot 接入，并通过统一任务入口完成会话管理、prompt 管理、长短期记忆管理和必要工具调用。桌面窗口只承担输入框与输出框的交互职责，命令解析、任务执行、SQLite 持久化、GitHub Copilot 调用和工具编排继续由共享核心模块负责。这样既满足“启动即弹出窗口、输入可被读取和处理”的体验要求，又保持 CLI-first、模块化和必要功能优先的架构原则。

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS  
**Primary Dependencies**: `electron`, `react`, `react-dom`, `vite`, `commander`, `zod`, `better-sqlite3`, `node:readline`, fetch-based GitHub Copilot integration layer, Electron IPC  
**Storage**: SQLite 本地数据库（session、memory、prompt、agent task、tool invocation、command action），文件系统用于本地配置、桌面壳资源和非结构化附件；敏感凭据默认来自本地配置或环境变量，不直接明文落入业务表  
**Testing**: `vitest`, React component tests, IPC contract tests, SQLite integration tests, minimal Electron desktop smoke tests  
**Target Platform**: Windows、macOS、Linux 桌面环境；保留命令行入口兼容  
**Project Type**: 单仓 CLI + desktop shell 混合应用  
**Performance Goals**: 程序启动后 2 秒内弹出可输入窗口；输入提交后 500ms 内出现首个可见反馈；常见 command 在 1 秒内返回基础反馈；常见 session / memory 查询在 200ms 内返回；常见搜索/会话切换操作在 3 秒内完成可见结果  
**Constraints**: 保持 CLI-first；窗口必须简洁且聚焦任务；输入区与输出区支持动态增减和尺寸调整；首个版本必须支持 GitHub Copilot；首个版本仅支持单窗口桌面壳层；工具范围仍限定为 `grep`/`glob`/`exec`；不得在渲染层复制第二套任务执行逻辑；数据库继续以 SQLite 为主  
**Scale/Scope**: 面向个人开发者与小团队的首个可用版本，覆盖 GitHub Copilot 接入、单窗口输入/输出、多轮输入、统一命令/任务路由、session/prompt/memory 管理、必要工具调用与 SQLite 持久化

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] 已定义模块边界，并说明模块内高内聚、模块间低耦合如何达成
- [x] 已记录本迭代涉及的功能清单、接口设计与依赖关系
- [x] 方案保持 CLI 优先；虽新增桌面窗口，但界面保持简洁，输入区与输出区支持动态增减和尺寸调整
- [x] 重点需求已补充时序图与用例图，或明确说明本功能不属于重点需求
- [x] 迭代范围可独立评审、独立验收，且覆盖一个完整模块闭环：GitHub Copilot + 窗口交互壳 + 上下文/工具工作流
- [x] 已识别可并行执行的任务边界、依赖关系及多 agent 协作方式
- [x] 已证明当前迭代仅包含必要功能，并明确延后项或可选增强不进入本次交付范围
- [x] 已规划测试驱动开发路径，并为本迭代安排必要的集成测试
- [x] 已说明当日提交策略，确保活跃开发工作至少每日提交一次

说明：本次计划没有将产品改造成复杂前端应用，而是在 CLI 核心之上增加一个单窗口桌面交互壳层。React 仅负责输入框和输出框展示，Electron 主进程与既有核心模块继续负责 GitHub Copilot 调用、命令路由、任务编排与 SQLite 持久化，因此满足宪章关于 CLI 优先、简洁前端、必要功能优先和模块化架构的要求。

## Project Structure

### Documentation (this feature)

```text
specs/001-code-agent-core/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── cli-command-contracts.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── app/
├── cli/
├── commands/
├── desktop/
│   ├── main/
│   ├── preload/
│   └── renderer/
├── providers/
├── sessions/
├── memory/
├── prompts/
├── tools/
├── agent/
├── persistence/
└── shared/

tests/
├── contract/
├── integration/
├── desktop/
└── unit/
```

**Structure Decision**: 保留现有单仓结构，并新增 `src/desktop/` 作为桌面壳层。`src/desktop/main` 负责 Electron 窗口生命周期和 IPC 路由，`src/desktop/preload` 负责安全桥接，`src/desktop/renderer` 负责 React 输入/输出界面。`src/commands`、`src/agent`、`src/providers`、`src/sessions`、`src/memory`、`src/prompts`、`src/tools` 与 `src/persistence` 继续作为共享核心，由 CLI 与桌面壳共同复用，从而保持高内聚和低耦合。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 增加桌面壳层 | 用户明确要求启动后弹出窗口并提供输入框/输出框 | 仅增强终端交互循环无法满足弹窗式对话入口需求 |
| 引入 Electron + React | 需要最小成本构建跨平台单窗口 UI，并直接复用现有 Node 核心 | 纯 Web 界面需要额外服务；Tauri 引入 Rust，超出当前必要范围 |
| 增加 GitHub Copilot 专用接入层 | 首个版本明确要求 GitHub Copilot 为必选 provider | 仅保留抽象 provider 而不实现 GitHub Copilot，无法满足规格要求 |
