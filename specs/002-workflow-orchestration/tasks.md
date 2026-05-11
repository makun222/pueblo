# Tasks: Workflow-Oriented Task Orchestration

**Input**: Design documents from `/specs/002-workflow-orchestration/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: 测试任务默认必需。对于任何影响行为、接口或模块协作的功能，任务列表 MUST 先包含失败测试，再包含实现任务，并在该迭代补齐集成测试。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. Task descriptions may be written in Chinese, but file paths and identifiers should remain in English where appropriate.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (e.g. [US1], [US2], [US3], [US4])
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 为 workflow 模块和运行态 `.plans/` 目录准备最小结构与约束。

- [x] T001 Create workflow module directories in `src/workflow/` and `src/workflow/pueblo-plan/`, and add test placeholders in `tests/unit/` and `tests/integration/`
- [x] T002 Update ignore rules for runtime plan artifacts in `.gitignore` and `.npmignore` to exclude `.plans/` while preserving committed specs
- [x] T003 [P] Record workflow module boundaries and `.plan.md` dual-path rules in `src/app/README.md` and `README.md`
- [x] T004 [P] Record deferred non-goals for v1 workflow support in `specs/002-workflow-orchestration/spec.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 建立 workflow 层的共享模型、持久化、路由和计划文件存储基础设施。

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Extend shared schemas for workflow instances, workflow status, workflow context blocks, and runtime plan metadata in `src/shared/schema.ts`
- [x] T006 [P] Extend app config for workflow routing thresholds and runtime plan paths in `src/shared/config.ts`
- [x] T007 [P] Add SQLite migration support for workflow instance persistence in `src/persistence/migrate.ts`
- [x] T008 [P] Implement workflow model helpers in `src/workflow/workflow-model.ts`
- [x] T009 [P] Implement workflow repository persistence in `src/workflow/workflow-repository.ts`
- [x] T010 Implement workflow service orchestration in `src/workflow/workflow-service.ts`
- [x] T011 [P] Implement workflow registry and definition lookup in `src/workflow/workflow-registry.ts`
- [x] T012 [P] Implement runtime plan file storage and loading in `src/workflow/workflow-plan-store.ts`
- [x] T013 [P] Implement final plan export support in `src/workflow/workflow-exporter.ts`
- [x] T014 Implement workflow routing decisions in `src/workflow/workflow-router.ts`
- [x] T015 Identify tasks safe for multi-agent parallel execution and document dependencies in `specs/002-workflow-orchestration/tasks.md`

**Checkpoint**: Workflow foundation ready; user story implementation can now begin in parallel.

---

## Phase 3: User Story 1 - 自动接管复杂任务 (Priority: P1) 🎯 MVP

**Goal**: 系统能够识别复杂任务，并在需要时将任务从普通单轮执行切换到 `pueblo-plan` workflow。

**Independent Test**: 提交超出单轮预算的复杂任务后，系统创建 workflow instance、生成运行态 plan 路径和 `plan` memory，并返回 workflow 已接管的结果；简单任务仍走原有任务路径。

### Tests for User Story 1 ⚠️

- [x] T016 [P] [US1] Add unit tests for workflow routing heuristics and explicit handoff decisions in `tests/unit/workflow-router.test.ts`
- [x] T017 [P] [US1] Add integration test for complex-task workflow handoff in `tests/integration/workflow-handoff.test.ts`
- [x] T018 [P] [US1] Add regression test to verify simple tasks still bypass workflow in `tests/integration/workflow-pass-through.test.ts`

### Implementation for User Story 1

- [x] T019 [P] [US1] Implement `pueblo-plan` workflow definition and trigger policy in `src/workflow/pueblo-plan/pueblo-plan-workflow.ts`
- [x] T020 [P] [US1] Implement workflow-aware runtime submission flow in `src/commands/input-router.ts` and the shared CLI submission pipeline in `src/cli/index.ts`
- [x] T021 [US1] Integrate workflow routing with task submission in `src/cli/index.ts`
- [x] T022 [US1] Create workflow instance startup flow in `src/workflow/workflow-service.ts` and `src/workflow/workflow-repository.ts`
- [x] T023 [US1] Implement initial runtime `.plan.md` bootstrap and workflow result payloads in `src/workflow/workflow-plan-store.ts`, `src/workflow/pueblo-plan/pueblo-plan-markdown.ts`, and `src/cli/index.ts`
- [x] T024 [US1] Create initial `plan` memory index entry for workflow startup in `src/memory/workflow-memory.ts` and `src/memory/memory-service.ts`
- [x] T025 [US1] Verify complex-task handoff and simple-task passthrough coverage in `tests/integration/workflow-handoff.test.ts` and `tests/integration/workflow-pass-through.test.ts`

**Checkpoint**: 复杂任务可被稳定切换到 `pueblo-plan` workflow，简单任务保持现有行为。

---

## Phase 4: User Story 2 - 生成并推进 plan/todo 执行台本 (Priority: P1) 🎯 MVP

**Goal**: workflow 可以生成结构化 `.plan.md`，并在每轮创建不超过 10 项任务的 `todo` 批次，逐轮推进计划。

**Independent Test**: workflow 接管任务后可写出层次化 plan 文档，生成本轮 todo 批次，在一轮结束后将结果回写到运行态 `.plan.md` 并更新下一轮状态。

### Tests for User Story 2 ⚠️

- [x] T026 [P] [US2] Add unit tests for plan markdown rendering and parsing in `tests/unit/pueblo-plan-markdown.test.ts`
- [x] T027 [P] [US2] Add unit tests for todo round selection and max-10 enforcement in `tests/unit/pueblo-plan-rounds.test.ts`
- [x] T028 [P] [US2] Add integration test for round creation and plan updates in `tests/integration/workflow-rounds.test.ts`

### Implementation for User Story 2

- [x] T029 [P] [US2] Implement plan document generation and update logic in `src/workflow/pueblo-plan/pueblo-plan-markdown.ts`
- [x] T030 [P] [US2] Implement planner logic for goal, constraints, task tree, and acceptance criteria in `src/workflow/pueblo-plan/pueblo-plan-planner.ts`
- [x] T031 [P] [US2] Implement todo round selection and progression in `src/workflow/pueblo-plan/pueblo-plan-rounds.ts`
- [x] T032 [US2] Implement plan/todo memory payload builders in `src/memory/workflow-memory.ts`
- [x] T033 [US2] Extend memory helpers to create workflow plan and todo memories in `src/memory/memory-service.ts`
- [x] T034 [US2] Wire round startup, round completion, and plan rewrites into `src/workflow/workflow-service.ts` and `src/workflow/pueblo-plan/pueblo-plan-workflow.ts`
- [x] T035 [US2] Update task execution persistence hooks to attach current workflow round metadata in `src/agent/task-runner.ts` and `src/cli/index.ts`
- [x] T036 [US2] Verify round generation, todo memory creation, and runtime plan rewrites in `tests/integration/workflow-rounds.test.ts`

**Checkpoint**: workflow 已具备完整的运行态台本与 todo 轮次推进能力。

---

## Phase 5: User Story 3 - 活跃 plan/todo 持续进入上下文 (Priority: P1) 🎯 MVP

**Goal**: 活跃 `plan` 与当前轮次 `todo` 通过独立 workflow context 通道固定注入 prompt，不再依赖 Pepe 的相似度筛选。

**Independent Test**: 在 workflow 活跃期间，模型消息始终包含 plan/todo 上下文块；即使 Pepe result items 为空或相似度较低，当前轮执行台本仍存在于 prompt 中。

### Tests for User Story 3 ⚠️

- [x] T037 [P] [US3] Extend workflow context resolution coverage in `tests/unit/context-resolver.test.ts` and add focused helpers in `tests/unit/workflow-context.test.ts`
- [x] T038 [P] [US3] Add unit tests for task message building with pinned workflow context in `tests/unit/task-message-builder.test.ts`
- [x] T039 [P] [US3] Extend context injection coverage for workflow context with Pepe enabled in `tests/integration/context-injection.test.ts`

### Implementation for User Story 3

- [x] T040 [P] [US3] Implement workflow context projection helpers in `src/workflow/workflow-context.ts`
- [x] T041 [US3] Extend task context model to include `workflowContext` in `src/agent/task-context.ts`
- [x] T042 [US3] Inject workflow context into context resolution in `src/agent/context-resolver.ts` and `src/workflow/workflow-service.ts`
- [x] T043 [US3] Inject fixed workflow context blocks into provider messages in `src/agent/task-message-builder.ts`
- [x] T044 [US3] Prevent active `plan/todo` memories from being auto-summarized in `src/agent/pepe-worker-process.ts` and cover the behavior in `tests/unit/pepe-supervisor.test.ts`
- [x] T045 [US3] Prevent duplicate rendering of pinned workflow memories in general Pepe result sections in `src/agent/context-resolver.ts` and `src/agent/task-message-builder.ts`
- [x] T046 [US3] Preserve workflow memory IDs as metadata without relying on them for prompt inclusion in `src/sessions/session-service.ts` and `src/workflow/pueblo-plan/pueblo-plan-memory.ts`
- [x] T047 [US3] Verify pinned workflow context survives Pepe ranking changes in `tests/integration/context-injection.test.ts` and `tests/unit/pepe-supervisor.test.ts`

**Checkpoint**: code master 的当前执行台本不再依赖 Pepe 候选和排序结果才能进入上下文。

---

## Phase 6: User Story 4 - 双落地 plan 文件 (Priority: P2)

**Goal**: 运行态 `.plan.md` 存放于 `.plans/`，workflow 完成后将最终版本导出到 app 工程目录作为交付物。

**Independent Test**: workflow 运行过程中只更新 `.plans/` 内的 runtime plan；workflow 完成后最终 plan 被写入目标工程目录，且可以基于 runtime plan 恢复状态。

### Tests for User Story 4 ⚠️

- [x] T048 [P] [US4] Add integration test for runtime plan export to deliverable path in `tests/integration/workflow-plan-export.test.ts`
- [x] T049 [P] [US4] Add integration test for workflow recovery from runtime `.plan.md` in `tests/integration/workflow-recovery.test.ts`
- [x] T050 [P] [US4] Add unit tests for deliverable path resolution and conflict handling in `tests/unit/workflow-exporter.test.ts`

### Implementation for User Story 4

- [x] T051 [P] [US4] Implement final plan export behavior in `src/workflow/workflow-exporter.ts`
- [x] T052 [US4] Persist runtime plan path, deliverable plan path, and active round state in `src/workflow/workflow-repository.ts` and `src/workflow/workflow-model.ts`
- [x] T053 [US4] Implement workflow resume and recovery from runtime plan files in `src/workflow/workflow-service.ts` and `src/workflow/workflow-plan-store.ts`
- [x] T054 [US4] Complete workflow finish/blocked/failure transitions in `src/workflow/pueblo-plan/pueblo-plan-workflow.ts` and `src/workflow/workflow-service.ts`
- [x] T055 [US4] Surface export and recovery outcomes in shared results and desktop output formatting in `src/shared/result.ts` and `src/desktop/main/ipc.ts`
- [x] T056 [US4] Verify runtime-vs-deliverable path separation and recovery behavior in `tests/integration/workflow-plan-export.test.ts` and `tests/integration/workflow-recovery.test.ts`

**Checkpoint**: workflow 具备完整的运行态台本、恢复能力和最终工程交付导出能力。

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: 收尾、文档补充和跨故事一致性验证。

- [x] T057 [P] Add supplemental unit coverage for workflow repository, plan store, and workflow service failure paths in `tests/unit/workflow-repository.test.ts`, `tests/unit/workflow-plan-store.test.ts`, and `tests/unit/workflow-service.test.ts`
- [x] T058 [P] Update operator guidance for workflow invocation, `.plans/` semantics, and final plan export in `README.md` and `specs/002-workflow-orchestration/plan.md`
- [x] T059 Confirm no extra workflow types, concurrent workflow execution, or non-approved UI surfaces were added beyond `pueblo-plan` in `specs/002-workflow-orchestration/spec.md`
- [x] T060 Create and validate an implementation quickstart for workflow scenarios in `specs/002-workflow-orchestration/quickstart.md`
- [x] T061 Run quickstart validation for simple-task passthrough, workflow handoff, round progression, context injection, and final export in `specs/002-workflow-orchestration/quickstart.md`
- [x] T062 Confirm daily commit evidence is present for the iteration in repository history notes or working log

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion; establishes workflow routing and startup.
- **User Story 2 (Phase 4)**: Depends on User Story 1 startup flow; adds plan/todo generation and round progression.
- **User Story 3 (Phase 5)**: Depends on User Story 1 and User Story 2; injects pinned workflow context and adjusts Pepe interaction.
- **User Story 4 (Phase 6)**: Depends on User Story 2; completes export, recovery, and finalization.
- **Polish (Final Phase)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; no dependency on other stories.
- **User Story 2 (P1)**: Requires workflow startup from User Story 1.
- **User Story 3 (P1)**: Requires active workflow artifacts from User Story 1 and round artifacts from User Story 2.
- **User Story 4 (P2)**: Requires runtime plan and workflow state persistence from User Story 2.

### Within Each User Story

- Tests MUST be written and FAIL before implementation.
- Shared models and repository changes before service logic.
- Workflow service changes before CLI/desktop integration.
- Runtime plan storage before markdown export/update logic.
- Context model changes before message builder changes.
- Story-specific integration validation before moving to the next slice.

### Parallel Opportunities

- Setup tasks `T002`, `T003`, and `T004` can run in parallel after `T001`.
- Foundational tasks `T006` through `T014` have multiple parallel lanes once `T005` is complete.
- In User Story 1, `T016` to `T018` can run in parallel; `T019` and `T020` can run in parallel.
- In User Story 2, `T026` to `T028` can run in parallel; `T029`, `T030`, and `T031` can run in parallel.
- In User Story 3, `T037` to `T039` can run in parallel; `T040`, `T041`, and `T044` can run in parallel.
- In User Story 4, `T048` to `T050` can run in parallel; `T051` and `T053` can run in parallel after persistence fields exist.
- Polish tasks `T057`, `T058`, and `T060` can run in parallel.

---

## Parallel Example: User Story 2

```bash
# Launch tests for plan/todo mechanics together:
Task: "T026 [P] [US2] Add unit tests for plan markdown rendering and parsing in tests/unit/pueblo-plan-markdown.test.ts"
Task: "T027 [P] [US2] Add unit tests for todo round selection and max-10 enforcement in tests/unit/pueblo-plan-rounds.test.ts"
Task: "T028 [P] [US2] Add integration test for round creation and plan updates in tests/integration/workflow-rounds.test.ts"

# Launch plan-generation implementation lanes together:
Task: "T029 [P] [US2] Implement plan document generation and update logic in src/workflow/pueblo-plan/pueblo-plan-markdown.ts"
Task: "T030 [P] [US2] Implement planner logic for goal, constraints, task tree, and acceptance criteria in src/workflow/pueblo-plan/pueblo-plan-planner.ts"
Task: "T031 [P] [US2] Implement todo round selection and progression in src/workflow/pueblo-plan/pueblo-plan-rounds.ts"
```

---

## Implementation Strategy

### MVP First (P1 Workflow Slice)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Complete Phase 4: User Story 2.
5. Complete Phase 5: User Story 3.
6. **STOP and VALIDATE**: Ensure complex-task handoff, todo rounds, and pinned workflow context all work before adding export/recovery.

### Incremental Delivery

1. Setup + Foundational → workflow infrastructure ready.
2. Add User Story 1 → complex tasks can be handed off to workflow.
3. Add User Story 2 → runtime plan and todo rounds become executable.
4. Add User Story 3 → pinned workflow context removes the current Pepe drift risk.
5. Add User Story 4 → export and recovery complete the operational lifecycle.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 routing and startup
   - Developer B: User Story 2 plan/todo document mechanics
   - Developer C: User Story 3 context injection and Pepe interaction
3. User Story 4 starts after runtime plan persistence stabilizes.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps each task to a user story for traceability.
- `selectedMemoryIds` remains metadata in this iteration; prompt inclusion for active `plan/todo` must come from workflow context.
- `.plans/` is runtime state, not the final deliverable path.
- Verify deferred workflow types and UI surfaces are not accidentally implemented in this iteration.
