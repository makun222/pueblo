# Feature Specification: Workflow-Oriented Task Orchestration

**Feature Branch**: `002-workflow-orchestration`  
**Created**: 2026-05-10  
**Status**: Draft  
**Input**: User description: "将 code agent 的复杂工作模式化，形成 plan/todo workflow；将 workflow 实现收敛到 `src/workflow/`；`.plan.md` 同时作为 Pueblo 的执行台本和 app 工程提交物，先落到执行台本目录，再在全部完成后同步到 app 工程目录。"

## Summary

为 Pueblo 增加一个可扩展的 workflow 编排层，使复杂任务不再仅依赖单轮提示词自觉规划，而是由系统显式进入一个可恢复、可追踪、可分轮推进的执行流。首个 workflow 为 `pueblo-plan`，用于把复杂代码任务拆分成 `.plan.md` 执行台本与按轮次推进的 `todo` 批次，并确保活跃 `plan` 与当前轮次 `todo` 在任务完成前持续进入上下文。

该能力必须满足两个目标：

1. 让复杂任务从“临时多轮对话”升级为“可持久化 workflow”。
2. 让 `.plan.md` 同时具备 Pueblo 内部执行台本和当前 app 工程交付物的双重身份。

## User Scenarios & Testing

### User Story 1 - 自动接管复杂任务 (Priority: P1)

作为使用 Pueblo 的开发者，我希望系统在收到复杂编码任务时自动切换到 workflow 模式，而不是把全部规划都塞进一次问答里，这样我可以获得稳定的多轮推进体验，并在中断后继续执行。

**Why this priority**: 如果复杂任务仍然只依赖一次会话内的临时规划，Pepe 会继续面临上下文漂移和中途遗忘的问题。

**Independent Test**: 提交一个明显超过单轮 step budget 的任务后，系统创建 workflow 实例、生成 `.plan.md` 执行台本、创建 `plan` memory，并返回首轮执行计划而不是直接尝试一次性完成全部工作。

**Acceptance Scenarios**:

1. **Given** 用户提交复杂代码任务，**When** workflow 路由器判断任务超出单轮 step budget，**Then** 系统创建 `pueblo-plan` workflow 实例并进入规划阶段。
2. **Given** 用户通过显式命令请求 workflow 接管，**When** 当前输入满足 `pueblo-plan` 适用条件，**Then** 系统直接进入 workflow 模式而不再以普通单轮任务执行。
3. **Given** 当前任务被判断为简单任务，**When** 不需要 workflow，**Then** 系统继续使用现有单轮任务执行路径。

---

### User Story 2 - 生成并推进 plan/todo 执行台本 (Priority: P1)

作为使用 Pueblo 的开发者，我希望复杂任务先形成结构化 `.plan.md` 和轮次化 `todo` 列表，再分多个轮次逐步完成，这样每轮只处理最相关的工作切片，而不是反复重新理解整个任务。

**Why this priority**: 多轮任务需要一个权威台本，否则每一轮都只能依赖 message history 和摘要拼接，容易造成计划失真。

**Independent Test**: 对同一复杂任务进行多轮执行时，系统能在每一轮开始前生成不超过 10 个任务的 `todo` 列表，将本轮结果回写到 `.plan.md`，并推进下一轮。

**Acceptance Scenarios**:

1. **Given** workflow 已进入规划阶段，**When** 规划完成，**Then** 系统生成包含目标、约束、分层任务树、执行路径与验收条件的 `.plan.md`。
2. **Given** workflow 进入某一轮执行，**When** 系统选择本轮工作内容，**Then** 系统创建一个不超过 10 个高相关任务的 `todo` 批次。
3. **Given** 某一轮执行完成，**When** 系统收敛本轮结果，**Then** 系统更新 `.plan.md` 中对应任务状态、结果说明与下一轮入口。
4. **Given** 所有计划任务完成，**When** workflow 结束，**Then** 系统把最终 `.plan.md` 同步到 app 工程目录作为交付物。

---

### User Story 3 - 活跃 plan/todo 持续进入上下文 (Priority: P1)

作为使用 Pueblo 的开发者，我希望当前活跃的 `plan` 和本轮 `todo` 在 workflow 完成前始终出现在上下文中，这样 code master 不会因为 Pepe 的相似度筛选而忘掉当前执行台本。

**Why this priority**: 当前 `selectedMemoryIds` 只是候选池，不是硬保留区；如果不新增 pinned workflow context，计划上下文会继续被 Pepe 排名淘汰。

**Independent Test**: 在复杂任务的任意一轮中，即使用户输入与 `plan` 文本表面相似度较低，模型消息里仍然包含活跃 `plan` 和本轮 `todo`。

**Acceptance Scenarios**:

1. **Given** workflow 有活跃 `plan` memory，**When** 构造当前轮 prompt，**Then** 系统将该 `plan` 注入固定的 workflow context 区域。
2. **Given** workflow 有活跃 `todo` memory，**When** Pepe 返回普通 result items，**Then** `todo` 仍通过独立通道注入，而不是依赖相似度排名结果。
3. **Given** workflow 已完成或当前 `todo` 轮次关闭，**When** 下次解析上下文，**Then** 已失效的 `plan/todo` 不再以 pinned 方式注入。

---

### User Story 4 - 双落地 plan 文件 (Priority: P2)

作为使用 Pueblo 的开发者，我希望 `.plan.md` 先保存在 Pueblo 的执行台本目录，待 workflow 全部完成后再同步到 app 工程目录，这样系统内部执行状态与最终工程交付物可以同时成立且互不干扰。

**Why this priority**: 运行态执行台本需要频繁更新；工程交付物应该以稳定版本出现，不能在执行过程中频繁污染工作区提交物。

**Independent Test**: workflow 运行期间，执行台本仅写入 `.plans/` 运行目录；workflow 完成后，系统把最终版本写入 app 工程目录的目标路径。

**Acceptance Scenarios**:

1. **Given** workflow 首次生成 plan，**When** 规划阶段结束，**Then** 系统将 plan 写入工作区 `.plans/` 目录。
2. **Given** workflow 尚未完成，**When** plan 在后续轮次被更新，**Then** 仅运行态 plan 文件被重写，工程交付物路径保持不变。
3. **Given** workflow 完成，**When** 同步交付物，**Then** 系统把最终 plan 写入 app 工程目录的目标路径。

### Edge Cases

- 当 LLM 误判复杂度，把本可单轮完成的任务路由到 workflow 时，系统如何允许用户降级回普通执行？
- 当 workflow 已存在运行态 `.plan.md`，但用户再次发起相同目标时，系统如何避免重复创建平行 plan？
- 当用户在执行过程中手动修改 `.plans/` 内的 plan 文件时，系统如何检测并回收为最新权威状态？
- 当目标工程目录不可写、目标文件名冲突或路径不存在时，系统如何延迟导出而不影响 workflow 本身推进？
- 当 plan 或 todo memory 被手工取消选择时，系统如何保证活跃 workflow 上下文仍可注入？
- 当 Pepe 生成普通摘要 memory 时，系统如何避免把 `plan/todo` 再压缩成无用 summary？
- 当某轮 todo 为空或剩余任务都被阻塞时，系统如何明确进入 blocked/needs-input 状态？

## Requirements

### Functional Requirements

- **FR-001**: 系统 MUST 在 `src/workflow/` 下提供一个可扩展的 workflow 架构，用于注册、选择和执行不同 workflow。
- **FR-002**: 系统 MUST 支持首个 workflow `pueblo-plan`，用于复杂代码任务的规划、分解、轮次执行与收尾同步。
- **FR-003**: 系统 MUST 在收到输入后判断该任务应继续走普通单轮执行，还是由 workflow 接管。
- **FR-003A**: workflow 路由 MUST 同时支持显式调用、关键字/规则触发和 LLM 复杂度判断三种入口。
- **FR-004**: 当任务被 `pueblo-plan` 接管时，系统 MUST 创建 workflow 实例，并记录其状态、所属 session、目标、执行目录和活跃轮次。
- **FR-005**: 系统 MUST 在规划阶段生成运行态 `.plan.md`，默认写入 `<workspaceRoot>/.plans/<workflowId>/<slug>.plan.md`。
- **FR-006**: 系统 MUST 将 `.plan.md` 视为 workflow 的权威执行台本，记录目标、约束、验收条件、层次化任务树、轮次状态、执行日志摘要与导出目标路径。
- **FR-007**: 系统 MUST 为 workflow 创建 `plan` memory；该 memory 仅记录最小索引信息，包括运行态 plan 路径、目标交付路径、workflowId、当前轮次和状态。
- **FR-008**: 系统 MUST 在每轮开始时生成一个 `todo` 批次，并创建 `todo` memory 记录该轮详细任务清单、关联任务节点、预期结果和当前轮次编号。
- **FR-008A**: 单个 `todo` 批次中的任务数 MUST NOT 超过 10 项。
- **FR-009**: 系统 MUST 在每轮完成后把执行结果、完成状态和下一轮入口回写到运行态 `.plan.md`。
- **FR-010**: 当全部任务完成时，系统 MUST 将运行态 `.plan.md` 同步到 app 工程目录中的最终交付路径。
- **FR-010A**: 运行期间 app 工程目录中的最终交付路径 SHOULD 保持未写入或仅保留上一次已完成版本，不得在每轮执行中频繁覆盖。
- **FR-011**: 活跃 `plan` memory 与当前轮次 `todo` memory MUST 通过独立的 workflow context 通道注入 prompt，而不是仅依赖 Pepe 的 result ranking。
- **FR-012**: Pepe 对普通 memory 的召回逻辑 MUST 保持可用，但不得负责决定活跃 workflow `plan/todo` 是否进入上下文。
- **FR-013**: `selectedMemoryIds` MAY 继续记录 `plan/todo` 作为候选或可视化元数据，但系统 MUST 将其与“固定保留上下文”语义分离。
- **FR-014**: Pepe 的 summary 生成逻辑 MUST NOT 自动将 `plan` 或 `todo` memory 再生成摘要 memory，除非未来明确增加专用策略。
- **FR-015**: workflow MUST 支持暂停、恢复、失败、阻塞和完成等状态，以便多轮推进和中断恢复。
- **FR-016**: 桌面与 CLI 两种交互入口 MUST 共享同一套 workflow 路由与执行逻辑，不得形成两套平行实现。
- **FR-017**: 系统 MUST 为 workflow 留出未来扩展点，包括 workflow 注册、优先级决策、状态持久化和上下文注入策略。

### Module Design & Interfaces

- **Module Scope**: 新增 workflow 编排层，位于会话、任务执行和 Pepe 之间。workflow 层负责接管复杂工作、维护运行态 plan/todo、向上下文解析器暴露活跃 workflow context，并在完成时导出工程交付物。
- **Function List**: 至少包括 workflow registry、workflow router、workflow instance service、runtime plan store、todo round builder、workflow context resolver、plan exporter，以及首个 `pueblo-plan` workflow 实现。
- **Interface Design**: 输入入口通过 chat/CLI/desktop 统一进入 workflow router；workflow router 决定继续普通任务还是切换到 workflow；workflow context resolver 向上下文解析器返回固定注入的 `plan/todo`；plan exporter 在完成时将运行态 plan 导出到工程目录。
- **Dependencies**: 依赖现有 session、memory、agent task、Pepe context resolver、文件系统写入、可能新增的 workflow 状态持久化表，以及当前目标目录解析能力。

### Key Entities

- **Workflow Definition**: 一个可注册的 workflow 类型定义，包含触发条件、适用范围、状态机和执行器。
- **Workflow Instance**: 某个 session 下的一次 workflow 运行实例，记录 workflowId、type、status、goal、sessionId、targetDirectory、runtimePlanPath、deliverablePlanPath、activeTodoRound 和 timestamps。
- **Runtime Plan Document**: 保存于 `.plans/` 的权威执行台本，包含目标、约束、任务树、轮次记录、状态、导出路径和执行摘要。
- **Todo Round**: 从 plan 中选出的当前轮次工作集，最多 10 项任务，记录 round number、task refs、status 和 expected outputs。
- **Workflow Context Block**: 专供上下文解析器使用的固定上下文对象，包含活跃 plan 摘要、活跃 todo 内容、workflow 状态和必要路径元数据。
- **Plan Memory**: 轻量索引 memory，标签包含 `workflow`, `plan`, `workflow:pueblo-plan`。
- **Todo Memory**: 轮次级详细 memory，标签包含 `workflow`, `todo`, `workflow:pueblo-plan`。

### Workflow State Model

- `idle`: 当前 session 无活跃 workflow。
- `assessing`: 正在判断是否需要 workflow 接管。
- `planning`: 正在生成或更新运行态 `.plan.md`。
- `round-active`: 当前轮 `todo` 已生成，模型按本轮任务执行。
- `round-review`: 当前轮结果正在回写 plan 并选择下一轮。
- `blocked`: 缺少用户输入、权限或外部条件，无法继续。
- `completed`: plan 全部完成且已成功导出交付物。
- `failed`: workflow 由于错误终止。
- `cancelled`: workflow 被用户显式终止。

### Critical Flow Visuals

- **Sequence Diagram**: TODO(Sequence Diagram): 需要补充 “输入到来 -> workflow router 判断 -> `pueblo-plan` 创建 workflow instance -> 生成 runtime `.plan.md` -> 创建 plan memory -> 生成 todo round -> 执行 -> 回写 plan -> 完成后导出工程 plan” 的时序图。
- **Use Case Diagram**: TODO(Use Case Diagram): 需要补充 “开发者 / workflow router / `pueblo-plan` / Pepe / 文件系统 / app 工程目录” 之间的用例图。
- **Importance Decision**: 该功能属于重点需求，因为它改变了复杂任务的主执行路径，并直接解决 Pepe 对 code master 的上下文漂移问题。

## Success Criteria

### Measurable Outcomes

- **SC-001**: 90% 以上明显超出单轮预算的代码任务能被正确路由到 `pueblo-plan` workflow，而不是直接在单轮内耗尽 step budget。
- **SC-002**: 95% 以上活跃 workflow 轮次中，模型消息都包含当前 `plan` 与当前轮次 `todo` 的固定上下文块。
- **SC-003**: 85% 以上复杂任务可在中断后基于 `.plans/` 中的运行态台本恢复，而不需要用户重新解释完整背景。
- **SC-004**: 90% 以上已完成 workflow 能成功将最终 `.plan.md` 导出到 app 工程目录的目标路径。
- **SC-005**: 活跃 workflow 存在时，Pepe 普通召回结果的上下文误伤率显著下降，至少不再因为 plan/todo 被淘汰而丢失执行台本。

## Assumptions

- 复杂任务是否需要 workflow 接管，默认同时参考 step budget、显式用户请求和 LLM 判断三种信号。
- `.plans/` 是 workflow 的内部运行目录，可以作为恢复和审计依据。
- app 工程目录交付物路径默认相对当前目标目录解析，但允许未来由用户或 workflow 明确指定。
- 活跃 workflow 的 plan/todo 由 workflow 层作为权威来源，Pepe 只负责普通记忆召回。
- 首个版本只实现 `pueblo-plan`，但架构必须允许未来增加更多 workflow。

## Out of Scope

- 本次只实现 `pueblo-plan`，不扩展其他 workflow 类型。
- 本次不要求为所有 workflow 设计图形化管理界面。
- 本次不要求新增 workflow 专用桌面 UI surface；结果展示继续复用既有 CLI / desktop output blocks。
- 本次不要求让 Pepe 自动理解并重排 plan 文件中的任务树。
- 本次不要求实现多 workflow 并发执行或跨 session workflow 协调。
- 本次不要求将 plan/todo 作为通用知识记忆长期复用到无关任务中。
