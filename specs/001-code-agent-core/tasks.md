# Tasks: Pueblo Code Agent Core

**Input**: Design documents from `/specs/001-code-agent-core/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: 测试任务默认必需。对于任何影响行为、接口或模块协作的功能，任务列表 MUST 先包含失败测试，再包含实现任务，并在该迭代补齐集成测试。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. Task descriptions may be written in Chinese, but file paths and identifiers should remain in English where appropriate.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (e.g. [US0], [US1], [US2], [US3])
- Include exact file paths in descriptions
- Tasks prefixed with `[DEPRECATED]` are retired from execution. They remain for traceability because the original requirement or file path conflicts with the current accepted implementation direction.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 初始化桌面壳开发依赖、目录结构和基础构建配置。

- [x] T001 Create desktop shell directories in `src/desktop/main/`, `src/desktop/preload/`, `src/desktop/renderer/`, and `tests/desktop/`
- [x] T002 Update desktop runtime and build dependencies in `package.json`
- [x] T003 [P] Configure React renderer bundling in `vite.desktop.config.ts`, `tsconfig.json`, and `package.json`
- [x] T004 [P] Configure desktop and component test support in `vitest.config.ts` and `tests/desktop/`
- [x] T005 [P] Update Electron and Vite ignore patterns in `.gitignore`, `.npmignore`, and `eslint.config.js`
- [x] T006 Update module boundary notes for desktop shell and GitHub Copilot integration in `src/app/README.md`
- [x] T007 Record deferred multi-window and non-essential provider capabilities in `specs/001-code-agent-core/spec.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 建立 GitHub Copilot 与桌面窗口共同依赖的共享基础设施。

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T008 Extend shared schemas for GitHub Copilot auth state, desktop IPC envelopes, and renderer output blocks in `src/shared/schema.ts`
- [x] T009 [P] Extend application config for GitHub Copilot credentials and desktop shell settings in `src/shared/config.ts`
- [x] T010 [P] Update SQLite migrations for provider auth metadata and provider-aware task tracing in `src/persistence/migrate.ts`
- [x] T011 [P] Create shared runtime lifecycle coordinator in `src/app/runtime.ts`
- [x] T012 [P] Create desktop IPC contract types in `src/desktop/shared/ipc-contract.ts`
- [x] T013 [P] Implement shared input normalization and plain-text task routing helper in `src/commands/input-router.ts`
- [x] T014 [P] Extend startup health checks for desktop shell and GitHub Copilot readiness in `src/persistence/health-check.ts`
- [x] T015 [P] Add desktop-aware output block formatting helpers in `src/shared/result.ts`
- [ ] T016 [DEPRECATED] Update application bootstrap to select CLI mode or desktop shell mode in `src/cli/index.ts`.
  Reason: current accepted direction keeps `src/cli/index.ts` as the interactive CLI entry and uses separate desktop entrypoints under `src/desktop/main/` plus the compiled wrapper `cli/index.ts`.
- [x] T017 Identify tasks safe for multi-agent parallel execution and document dependencies in `specs/001-code-agent-core/tasks.md`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 0 - 弹窗式对话入口 (Priority: P1) 🎯 MVP

**Goal**: 启动后自动弹出单窗口对话界面，输入框内容可被读取处理，输出框持续显示结果。

**Independent Test**: 启动应用后看到窗口、输入框与输出框；连续提交普通文本与 slash command 均能得到响应；退出后资源被释放。

### Tests for User Story 0 ⚠️

- [x] T018 [P] [US0] Add desktop smoke test for window launch in `tests/desktop/window-launch.test.ts`
- [x] T019 [P] [US0] Add desktop integration test for input submission and output rendering in `tests/desktop/window-input-output.test.ts`
- [x] T020 [P] [US0] Add desktop integration test for plain-text routing and graceful exit in `tests/desktop/window-plain-text.test.ts`

### Implementation for User Story 0

- [x] T021 [P] [US0] Implement Electron main-process bootstrap in `src/desktop/main/main.ts`
- [x] T022 [P] [US0] Implement Electron window factory and lifecycle handling in `src/desktop/main/window.ts`
- [x] T023 [P] [US0] Implement secure preload bridge in `src/desktop/preload/index.ts`
- [x] T024 [P] [US0] Implement React renderer shell with input and output panes in `src/desktop/renderer/App.tsx`
- [x] T025 [P] [US0] Implement renderer entry, HTML shell, and base styles in `src/desktop/renderer/main.tsx`, `src/desktop/renderer/index.html`, and `src/desktop/renderer/styles.css`
- [x] T026 [US0] Implement desktop IPC handlers and output block streaming in `src/desktop/main/ipc.ts`
- [x] T027 [US0] Connect renderer submit flow to shared input routing in `src/desktop/main/ipc.ts` and `src/commands/input-router.ts`
- [ ] T028 [DEPRECATED] Wire desktop startup and graceful shutdown into bootstrap flow in `src/cli/index.ts` and `src/app/runtime.ts`.
  Reason: current accepted direction keeps desktop startup in `src/desktop/main/main.ts` instead of reusing the CLI bootstrap path.
- [x] T029 [US0] Verify desktop shell independent workflow in `tests/desktop/window-input-output.test.ts`

**Checkpoint**: User Story 0 provides a working popup window with continuous input/output flow.

---

## Phase 4: User Story 1 - 接入 GitHub Copilot 模型能力 (Priority: P1) 🎯 MVP

**Goal**: 首个版本必须接入 GitHub Copilot，并使其可作为统一模型入口发起任务。

**Independent Test**: 用户完成 GitHub Copilot 配置后，可在同一产品入口中选择 GitHub Copilot 并成功发起代码任务。

### Tests for User Story 1 ⚠️

- [x] T030 [P] [US1] Add provider contract test for GitHub Copilot in `tests/contract/github-copilot-provider-contract.test.ts`
- [x] T031 [P] [US1] Add GitHub Copilot auth-state coverage in `tests/unit/cli-startup-auth.test.ts` and `tests/unit/github-copilot-device-flow.test.ts`
- [x] T032 [P] [US1] Add GitHub Copilot task execution integration coverage in `tests/integration/agent-task-run.test.ts` and `tests/integration/model-selection.test.ts`

### Implementation for User Story 1

- [x] T033 [P] [US1] Create GitHub Copilot provider profile definitions in `src/providers/github-copilot-profile.ts`
- [x] T034 [P] [US1] Implement GitHub Copilot credential resolver in `src/providers/github-copilot-auth.ts`
- [x] T035 [P] [US1] Implement GitHub Copilot adapter in `src/providers/github-copilot-adapter.ts`
- [x] T036 [US1] Update provider registry and model service for GitHub Copilot mandatory availability in `src/providers/provider-registry.ts` and `src/providers/model-service.ts`
- [x] T037 [US1] Extend provider errors and startup validation for GitHub Copilot credential failures in `src/providers/provider-errors.ts` and `src/persistence/health-check.ts`
- [x] T038 [US1] Integrate GitHub Copilot into provider selection and task execution in `src/agent/task-runner.ts` and `src/cli/index.ts`
- [x] T039 [US1] Verify GitHub Copilot task execution and persistence in `tests/integration/agent-task-run.test.ts`

**Checkpoint**: User Story 1 delivers the required GitHub Copilot provider workflow independently.

---

## Phase 5: User Story 2 - 通过指令管理会话与模型 (Priority: P2)

**Goal**: 用户可以在桌面窗口和共享命令链路中管理 session 生命周期并切换当前模型。

**Independent Test**: 用户通过输入框输入 `/new`、`/session-list`、`/session-sel`、`/session-archive`、`/session-restore`、`/session-del` 和 `/model` 完成一轮会话生命周期操作，系统在窗口输出框中返回正确结果并保持上下文一致。

### Tests for User Story 2 ⚠️

- [x] T040 [P] [US2] Add integration test for session lifecycle through shared routing in `tests/integration/session-lifecycle.test.ts`
- [x] T041 [P] [US2] Add contract test for structured session command output in `tests/contract/session-command-contract.test.ts`
- [x] T042 [P] [US2] Add integration test for session restore with model continuity in `tests/integration/session-restore-model.test.ts`

### Implementation for User Story 2

- [x] T043 [P] [US2] Extend session repository queries for fast snapshot reads in `src/sessions/session-repository.ts` and `src/sessions/session-queries.ts`
- [x] T044 [US2] Update session service for active session selection and restore semantics in `src/sessions/session-service.ts`
- [x] T045 [P] [US2] Update session list and state command handlers in `src/commands/session-list-command.ts` and `src/commands/session-state-command.ts`
- [x] T046 [US2] Update dispatcher and input router to preserve session/model context across repeated submissions in `src/commands/dispatcher.ts` and `src/commands/input-router.ts`
- [x] T047 [US2] Connect current session and model state to task context and desktop subscriptions in `src/agent/task-context.ts` and `src/desktop/main/ipc.ts`
- [x] T048 [US2] Verify session lifecycle and restore independence in `tests/integration/session-lifecycle.test.ts` and `tests/integration/session-restore-model.test.ts`

**Checkpoint**: User Story 2 enables independently testable command-driven session and model management.

---

## Phase 6: User Story 3 - 通过指令管理 Prompt、记忆与工具调用 (Priority: P3)

**Goal**: 用户可以通过统一指令管理 prompt、memory 与必要工具调用，并将这些能力作用于 GitHub Copilot 任务流程。

**Independent Test**: 用户通过窗口输入框选择 prompt 与 memory 后发起 GitHub Copilot 任务，系统能够调用 `glob`、`grep`、`exec` 推进任务，并持续在输出框中展示结构化结果。

### Tests for User Story 3 ⚠️

- [x] T049 [P] [US3] Add contract test for prompt and memory commands in `tests/contract/context-command-contract.test.ts`
- [x] T050 [P] [US3] Add GitHub Copilot prompt and memory injection integration test in `tests/integration/context-injection.test.ts`
- [x] T051 [P] [US3] Add GitHub Copilot tool workflow integration test with persisted history in `tests/integration/tool-workflow.test.ts`

### Implementation for User Story 3

- [x] T052 [P] [US3] Update prompt and memory repositories for GitHub Copilot traceability in `src/prompts/prompt-repository.ts` and `src/memory/memory-repository.ts`
- [x] T053 [P] [US3] Update prompt and memory services for selection flow in `src/prompts/prompt-service.ts` and `src/memory/memory-service.ts`
- [x] T054 [P] [US3] Update prompt and memory command handlers in `src/commands/prompt-command.ts` and `src/commands/memory-command.ts`
- [x] T055 [P] [US3] Update tool adapters for GitHub Copilot task context compatibility in `src/tools/glob-tool.ts`, `src/tools/grep-tool.ts`, and `src/tools/exec-tool.ts`
- [x] T056 [US3] Extend tool orchestration and persistence for GitHub Copilot task runs in `src/tools/tool-service.ts` and `src/tools/tool-invocation-repository.ts`
- [x] T057 [US3] Inject selected prompt, memory, and tool results into GitHub Copilot task execution in `src/agent/task-runner.ts`
- [x] T058 [US3] Update output attribution formatting for model, prompt, memory, and tool blocks in `src/shared/result.ts`
- [x] T059 [US3] Verify prompt, memory, and tool workflow independence in `tests/integration/tool-workflow.test.ts`

**Checkpoint**: User Story 3 completes the full GitHub Copilot context and tool-assisted workflow.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: 收尾、强化和跨故事一致性验证。

- [x] T060 [P] Add supplemental unit tests for desktop renderer state and input routing in `tests/unit/desktop-renderer.test.tsx` and `tests/unit/input-router.test.ts`
- [x] T061 [P] Add supplemental unit tests for GitHub Copilot auth and adapter behavior in `tests/unit/github-copilot-auth.test.ts` and `tests/unit/github-copilot-adapter.test.ts`
- [x] T062 [P] Update operator documentation for GitHub Copilot launch flow in `README.md` and `specs/001-code-agent-core/quickstart.md`
- [ ] T063 Harden desktop error handling and shutdown cleanup in `src/desktop/main/main.ts`, `src/desktop/main/window.ts`, `src/desktop/main/ipc.ts`, and `src/app/runtime.ts`
- [x] T064 Confirm no non-essential multi-window, extra-provider, or extra-tool capabilities were added beyond approved scope in `specs/001-code-agent-core/spec.md`
- [ ] T065 Run quickstart validation for build, launch, session, prompt/memory, GitHub Copilot, and tool workflows in `specs/001-code-agent-core/quickstart.md`
- [ ] T066 Confirm daily commit evidence is present for the iteration in repository history notes or working log

---

## Phase N+1: CLI Alignment and Copilot Auth Hardening

**Purpose**: 收敛 CLI 交互入口、认证流程与 GitHub Copilot 真实联调路径，避免未完成桌面/CLI 任务继续互相干扰。

- [x] T067 Add interactive terminal loop with `/exit` and `/quit` support in `src/cli/index.ts` and `tests/unit/cli-interactive.test.ts`
- [x] T068 Add manual `/auth-login` device-flow command and skip startup auth by default in `src/cli/index.ts`, `README.md`, and `tests/unit/cli-auth-login-command.test.ts`
- [x] T069 Prefer direct `github-auth-token` chat access with exchange fallback in `src/providers/github-copilot-adapter.ts` and `tests/contract/github-copilot-provider-contract.test.ts`
- [x] T070 Add stable compiled CLI wrapper entrypoint in `cli/index.ts`, `tsconfig.json`, and `README.md`
- [x] T071 Add command discovery support with `/help` in `src/commands/dispatcher.ts`, `src/cli/index.ts`, and `README.md`

---

## Phase N+2: Desktop Dialog Relaunch and Output Simplification

**Purpose**: 在执行下一轮测试前，收敛默认启动体验与桌面输出呈现。该阶段会覆盖当前“无参启动进入终端交互模式”的默认 UX：后续默认行为改为 CLI 启动后关闭当前终端对话并打开新的桌面对话框；终端交互模式保留为显式诊断/备用路径。

### Tests for Desktop Dialog Relaunch ⚠️

- [x] T072 [P] [US0] Add desktop launch handoff test to verify `node dist/cli/index.js` closes the current terminal dialog flow and opens a new desktop dialog with separate input/output regions and a `pueblo>` input label in `tests/desktop/window-cli-launch.test.ts`
- [x] T073 [P] [US0] Add desktop output rendering test to verify LLM responses show only `outputSummary`, keep tool invocation/result blocks visible, and keep `modelOutput` collapsed by default in `tests/desktop/window-output-summary.test.ts` and `tests/unit/desktop-renderer.test.tsx`

### Implementation for Desktop Dialog Relaunch

- [x] T074 [US0] Update no-argument CLI startup to hand off from terminal mode to a new desktop dialog window, closing the current terminal conversation flow after launch in `src/cli/index.ts`, `cli/index.ts`, and `README.md`
- [x] T075 [P] [US0] Refactor the desktop renderer into explicit input/output regions with a persistent `pueblo>` label for the input area in `src/desktop/renderer/App.tsx` and `src/desktop/renderer/styles.css`
- [x] T076 [US0] Reshape desktop output blocks so task responses render `outputSummary` in the main output region, keep tool call/result summaries visible, and expose `modelOutput` only as collapsed metadata in `src/shared/result.ts`, `src/desktop/main/ipc.ts`, and `src/shared/schema.ts`
- [x] T077 [US0] Verify end-to-end CLI-to-dialog handoff and simplified output rendering in `tests/desktop/window-cli-launch.test.ts` and `tests/desktop/window-input-output.test.ts`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User Story 0 and User Story 1 are both P1 and define the MVP together
  - User Story 2 depends on shared routing, active window state, and provider/model flow from earlier phases
  - User Story 3 depends on provider execution, session context, and desktop output flow from earlier phases
- **Polish (Final Phase)**: Depends on all desired user stories being complete
- **Phase N+1**: Depends on User Story 0 and User Story 1 stability - aligns CLI entrypoint and Copilot auth flow
- **Phase N+2**: Depends on Phase N+1 - overrides default no-argument CLI UX with desktop dialog handoff before the next test cycle

### User Story Dependencies

- **User Story 0 (P1)**: Starts after Foundational - establishes popup window, input, output, and shared routing entry
- **User Story 1 (P1)**: Starts after Foundational - establishes GitHub Copilot provider access and task execution
- **User Story 2 (P2)**: Starts after Foundational - conceptually builds on shared routing and provider selection from US0/US1 while remaining independently testable
- **User Story 3 (P3)**: Starts after Foundational - depends on task orchestration, session context, and GitHub Copilot execution from earlier stories

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Contracts and routing helpers before story-specific integration
- Models and repositories before services
- Services before handlers, IPC wiring, or task-runner integration
- Core implementation before integration validation
- Story complete before moving to the next priority slice for delivery

### Parallel Opportunities

- Setup tasks `T003`, `T004`, and `T005` can run in parallel
- Foundational tasks `T009`, `T010`, `T011`, `T012`, `T013`, `T014`, and `T015` can run in parallel after `T008`
- In US0, `T018`-`T020` can run in parallel; `T021`-`T025` can run in parallel
- In US1, `T030`-`T032` can run in parallel; `T033`-`T035` can run in parallel
- In US2, `T040`-`T042` can run in parallel; `T043` and `T045` can run in parallel after test tasks
- In US3, `T049`-`T051` can run in parallel; `T052`-`T055` can run in parallel once foundational tasks are complete
- Polish tasks `T060`, `T061`, and `T062` can run in parallel
- Phase N+2 test tasks `T072` and `T073` can run in parallel; implementation tasks `T075` and `T076` can run in parallel after CLI handoff design in `T074`

---

## Parallel Example: User Story 0

```bash
# Launch desktop shell tests together:
Task: "T018 [P] [US0] Add desktop smoke test for window launch in tests/desktop/window-launch.test.ts"
Task: "T019 [P] [US0] Add desktop integration test for input submission and output rendering in tests/desktop/window-input-output.test.ts"
Task: "T020 [P] [US0] Add desktop integration test for plain-text routing and graceful exit in tests/desktop/window-plain-text.test.ts"

# Launch renderer and shell bootstrap tasks together:
Task: "T021 [P] [US0] Implement Electron main-process bootstrap in src/desktop/main/main.ts"
Task: "T023 [P] [US0] Implement secure preload bridge in src/desktop/preload/index.ts"
Task: "T024 [P] [US0] Implement React renderer shell with input and output panes in src/desktop/renderer/App.tsx"
Task: "T025 [P] [US0] Implement renderer entry, HTML shell, and base styles in src/desktop/renderer/main.tsx, src/desktop/renderer/index.html, and src/desktop/renderer/styles.css"
```

## Parallel Example: User Story 1

```bash
# Launch GitHub Copilot tests together:
Task: "T030 [P] [US1] Add provider contract test for GitHub Copilot in tests/contract/github-copilot-provider-contract.test.ts"
Task: "T031 [P] [US1] Add GitHub Copilot auth-state integration test in tests/integration/github-copilot-auth.test.ts"
Task: "T032 [P] [US1] Add GitHub Copilot task execution integration test in tests/integration/github-copilot-task-run.test.ts"

# Launch provider implementation tasks together:
Task: "T033 [P] [US1] Create GitHub Copilot provider profile definitions in src/providers/github-copilot-profile.ts"
Task: "T034 [P] [US1] Implement GitHub Copilot credential resolver in src/providers/github-copilot-auth.ts"
Task: "T035 [P] [US1] Implement GitHub Copilot adapter in src/providers/github-copilot-adapter.ts"
```

## Parallel Example: User Story 3

```bash
# Launch GitHub Copilot context workflow tests together:
Task: "T049 [P] [US3] Add contract test for prompt and memory commands with window output blocks in tests/contract/context-window-command-contract.test.ts"
Task: "T050 [P] [US3] Add GitHub Copilot prompt and memory injection integration test in tests/integration/github-copilot-context-injection.test.ts"
Task: "T051 [P] [US3] Add GitHub Copilot tool workflow integration test with persisted history in tests/integration/github-copilot-tool-workflow.test.ts"

# Launch context and tool tasks together:
Task: "T052 [P] [US3] Update prompt and memory repositories for GitHub Copilot traceability in src/prompts/prompt-repository.ts and src/memory/memory-repository.ts"
Task: "T053 [P] [US3] Update prompt and memory services for window-driven selection flow in src/prompts/prompt-service.ts and src/memory/memory-service.ts"
Task: "T054 [P] [US3] Update prompt and memory command handlers for structured desktop output in src/commands/prompt-command.ts and src/commands/memory-command.ts"
Task: "T055 [P] [US3] Update tool adapters for GitHub Copilot task context compatibility in src/tools/glob-tool.ts, src/tools/grep-tool.ts, and src/tools/exec-tool.ts"
```

---

## Implementation Strategy

### MVP First (User Story 0 + User Story 1)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 0
4. Complete Phase 4: User Story 1
5. **STOP and VALIDATE**: Confirm popup window launch, input/output flow, and GitHub Copilot task execution independently
6. Demo the desktop shell MVP

### Incremental Delivery

1. Setup + Foundational -> desktop/runtime foundation ready
2. Add User Story 0 -> validate popup window and input/output loop
3. Add User Story 1 -> validate GitHub Copilot access and task execution -> MVP complete
4. Add User Story 2 -> validate session lifecycle and model continuity in the window flow
5. Add User Story 3 -> validate prompt/memory/tool-assisted GitHub Copilot workflow
6. Complete Phase N+1 -> validate CLI entrypoint and Copilot auth hardening
7. Complete Phase N+2 -> validate desktop dialog relaunch and output simplification before broader testing
8. Finish Polish phase -> documentation, hardening, and cross-cutting validation complete

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 0 desktop shell and IPC flow
   - Developer B: User Story 1 GitHub Copilot provider access
   - Developer C: User Story 2 session/model continuity
3. Rejoin for User Story 3 shared context/tool orchestration and final polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Verify tests fail before implementing
- Verify deferred or out-of-scope features are not accidentally implemented in this iteration
- Verify each iteration includes integration coverage for the delivered module slice
- Commit after each task or logical group
- Active workstreams must not go more than one working day without a commit
- Avoid vague tasks, same-file conflicts, and cross-story dependencies that break independence
