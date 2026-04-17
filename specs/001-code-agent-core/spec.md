# Feature Specification: Pueblo Code Agent Core

**Feature Branch**: `001-code-agent-core`  
**Created**: 2026-04-14  
**Status**: Ready  
**Input**: User description: "pueblo是一个代码agent，支持主流provider及主要LLM（后期再进行扩展），会话管理、长短期记忆、prompt管理等功能，核心能力与kilocode对齐。增加需求：支持command指令集，包括/new：开启新session；/session-list 查看已生成session；/session-sel 选择session；/session-archive 归档session；/session-restore 恢复session；/session-del 删除session;/model 切换模型；/prompt-list 查看已生成prompt；/prompt-sel 选择prompt；/prompt-del 删除prompt；/memory-list 查看已生成memory；/memory-sel 选择memory；/memory-search 手动选择记忆等。目前只设计必要指令，支持未来扩展新指令。增加需求：系统支持工具调用：grep、glob、exec。"

## User Scenarios & Testing *(mandatory)*

### User Story 0 - 弹窗式对话入口 (Priority: P1)

作为使用 Pueblo 的开发者，我希望在启动产品后直接弹出一个简洁的对话窗口，窗口中包含输入框和输出框，这样我可以像对话一样持续输入任务或命令，并立即看到系统处理结果。

**Why this priority**: 启动后若没有可持续交互的窗口入口，用户只能看到一次性文本反馈，无法真正使用后续 session、model、prompt、memory 与工具能力。弹窗式对话入口是本轮可用性的直接门槛。

**Independent Test**: 用户启动应用后看到一个弹出窗口，窗口包含输入框与输出框；用户在输入框中连续输入普通文本和 slash command，系统都能读取、处理并在输出框中显示结果；关闭窗口或执行退出操作后正常结束。

**Acceptance Scenarios**:

1. **Given** 用户启动 Pueblo，**When** 程序完成初始化，**Then** 系统自动弹出一个包含输入框和输出框的对话窗口。
2. **Given** 用户在输入框中输入命令或任务文本并提交，**When** 系统接收输入，**Then** 系统读取该文本并进入统一处理流程。
3. **Given** 用户连续输入多条内容，**When** 每条内容处理完成，**Then** 输出框按顺序持续显示结果且窗口保持可继续输入。
4. **Given** 用户关闭窗口或执行退出操作，**When** 系统结束当前交互，**Then** 系统释放资源并明确结束本次会话。

---

### User Story 1 - 接入 GitHub Copilot 模型能力 (Priority: P1)

作为使用 Pueblo 的开发者，我希望首个版本就能直接接入 GitHub Copilot，
这样我可以在同一个产品入口中使用 GitHub Copilot 完成代码生成、代码修改、分析与执行等核心任务。

**Why this priority**: GitHub Copilot 已被明确指定为首个版本必须支持的 provider。若缺少该能力，当前版本的模型接入价值和后续 prompt、memory、工具工作流都无法满足用户目标。

**Independent Test**: 用户完成 GitHub Copilot 接入后，可通过同一产品入口发起代码相关任务，系统能够成功建立会话、返回结果，并保持一致的任务启动与响应体验。

**Acceptance Scenarios**:

1. **Given** 用户已完成 GitHub Copilot 可用配置，**When** 用户选择 GitHub Copilot 发起
   代码任务，**Then** 系统成功执行请求并返回可读结果。
2. **Given** 用户在 GitHub Copilot 与其他受支持 provider 之间切换，**When** 用户重复相同类型的代码任务，**Then** 系统保持一致的基础交互流程与任务结果结构。

---

### User Story 2 - 通过指令管理会话与模型 (Priority: P2)

作为使用 Pueblo 的开发者，我希望通过统一的 command 指令集管理会话与模型，这样我
可以快速开启新 session、选择历史 session、归档或恢复会话，并在不同模型之间切换，
而不必依赖复杂操作路径。

**Why this priority**: 对代码 agent 而言，会话与模型控制是高频操作。若缺少统一指令集，
用户在持续协作中的切换成本会明显增加，也不利于未来扩展更多控制能力。

**Independent Test**: 用户仅通过命令指令完成新建会话、查看会话列表、选择会话、归档会
话、恢复会话、删除会话和切换模型，系统均能返回正确结果并保持对应上下文状态。

**Acceptance Scenarios**:

1. **Given** 用户输入 `/new`，**When** 系统创建新 session，**Then** 系统开启新的会话上
   下文并将其作为当前活动 session。
2. **Given** 用户已有多个 session，**When** 用户执行 `/session-list` 与 `/session-sel`，
   **Then** 系统返回可选 session 并切换到用户指定的会话。
3. **Given** 用户希望整理历史工作流，**When** 用户执行 `/session-archive`、`/session-restore`
   或 `/session-del`，**Then** 系统正确更新会话状态并反馈结果。
4. **Given** 用户需要切换模型，**When** 用户执行 `/model`，**Then** 系统切换到所选模型并
   在后续任务中使用该模型。

---

### User Story 3 - 通过指令管理 Prompt、记忆与工具调用 (Priority: P3)

作为使用 Pueblo 的开发者，我希望通过统一指令管理短期记忆、长期记忆、可复用 prompt
以及必要的工具调用能力，并且这些能力能够作用于 GitHub Copilot 的任务流程，这样我可以减少重复输入，并让 agent 更稳定地完成代码相关任务。

**Why this priority**: 记忆、prompt 与工具调用共同决定 agent 在真实代码任务中的可用性。
它们建立在统一模型接入和会话管理之上，是形成持续生产效率的关键能力。

**Independent Test**: 用户通过 `/prompt-list`、`/prompt-sel`、`/prompt-del`、`/memory-list`、
`/memory-sel` 和 `/memory-search` 完成 prompt 与记忆管理，并在 GitHub Copilot 的代码任务中调用 `grep`、`glob`、`exec` 工具；系统能够正确使用所选上下文与工具结果完成任务。

**Acceptance Scenarios**:

1. **Given** 用户维护了一组 prompt 模板，**When** 用户执行 `/prompt-list` 和 `/prompt-sel`，
   **Then** 系统展示可用 prompt 并将所选 prompt 应用于后续任务。
2. **Given** 用户不再需要某个 prompt，**When** 用户执行 `/prompt-del`，**Then** 系统删除
   指定 prompt 并确保后续任务不再引用该 prompt。
3. **Given** 用户已有多个可复用记忆条目，**When** 用户执行 `/memory-list`、`/memory-sel`
   或 `/memory-search`，**Then** 系统允许用户查看、选择或手动检索需要注入的记忆。
4. **Given** 用户需要在代码库中定位内容或文件，**When** agent 调用 `grep` 或 `glob`，**Then**
   系统返回与任务相关的搜索结果供后续分析使用。
5. **Given** 用户需要执行受支持的命令操作，**When** GitHub Copilot 任务流程调用 `exec`，**Then** 系统执行命令并返回结果，以便继续完成代码任务。

### Edge Cases

- 当用户选择的 provider 暂时不可用时，系统如何提示失败并允许用户切换到其他可用模型？
- 当同一用户拥有多个长期会话和多个项目上下文时，系统如何避免记忆误注入到错误任务？
- 当短期记忆超出有效上下文容量时，系统如何保留关键上下文并避免影响任务连续性？
- 当用户编辑或删除 prompt 模板、记忆条目后，系统如何确保后续任务不再引用过期内容？
- 当用户输入不受支持的 command 或参数不完整时，系统如何反馈错误并引导到可用指令？
- 当未来新增 command 时，系统如何在不破坏现有命令使用习惯的前提下平滑扩展？
- 当工具调用结果为空、返回过大或执行失败时，系统如何反馈并允许用户继续任务？
- 当 `exec` 执行的操作不适用于当前上下文时，系统如何避免误导用户或产生无效结果？
- 当交互式会话中用户连续输入高频命令或空输入时，系统如何避免界面卡住、重复打印或误触发执行？
- 当交互式模式收到中断信号（如 Ctrl+C）时，系统如何确保数据库连接与会话状态安全关闭？
- 当 GitHub Copilot 凭据失效、不可用或授权范围不足时，系统如何反馈并允许用户继续进行可恢复操作？
- 当弹出窗口初始化失败、窗口被误关闭或输入框失焦时，系统如何保持用户输入和输出状态可恢复？

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 在首个版本中支持 GitHub Copilot 作为必备 provider，并允许用户在受支持范围内选择使用。
- **FR-001A**: 系统 MUST 在首个版本中支持与 GitHub Copilot 建立官方接入关系，以完成任务请求、结果接收和错误反馈。
- **FR-002**: 系统 MUST 为不同 provider 与模型提供一致的任务发起、响应查看与错误反馈体验。
- **FR-000**: 系统 MUST 在启动时弹出一个简洁的对话窗口，而不是仅输出一次性提示后退出。
- **FR-000A**: 系统 MUST 在窗口中提供输入框与输出框，并支持用户持续输入与持续查看结果。
- **FR-000B**: 系统 MUST 能够读取输入框中提交的文本，并将其送入统一命令/任务处理流程。
- **FR-000C**: 系统 MUST 在窗口模式下支持普通文本输入触发任务执行语义，不得将所有非 slash 输入都视为非法命令。
- **FR-000D**: 系统 MUST 为窗口模式提供明确退出方式，并在退出前完成资源释放与状态保护。
- **FR-003**: 用户 MUST 能够创建、查看、恢复、切换和归档会话。
- **FR-003A**: 系统 MUST 提供最小必要 command 指令集，以覆盖核心会话、模型、prompt 与记忆操作，并支持未来扩展新指令。
- **FR-004**: 系统 MUST 在会话范围内保留任务历史与相关上下文，以支持多轮连续协作。
- **FR-004A**: 系统 MUST 支持通过 `/new` 创建新 session，并将其设为当前活动会话。
- **FR-004B**: 系统 MUST 支持通过 `/session-list` 查看已生成 session，通过 `/session-sel` 选择目标 session。
- **FR-004C**: 系统 MUST 支持通过 `/session-archive` 归档 session，通过 `/session-restore` 恢复已归档 session，通过 `/session-del` 删除指定 session。
- **FR-005**: 系统 MUST 支持短期记忆的记录、提取、更新与失效控制，用于当前或近期任务。
- **FR-006**: 系统 MUST 支持长期记忆的记录、分类、检索与复用，用于跨会话保持用户偏好和项目背景。
- **FR-007**: 系统 MUST 支持 prompt 的创建、编辑、分类、复用与按场景调用。
- **FR-007A**: 系统 MUST 支持通过 `/prompt-list` 查看已生成 prompt，通过 `/prompt-sel` 选择 prompt，通过 `/prompt-del` 删除 prompt。
- **FR-008**: 系统 MUST 在发起任务前明确当前会话上下文、记忆来源和所选 prompt，以便用户理解输入来源。
- **FR-008A**: 系统 MUST 支持通过 `/memory-list` 查看已生成 memory，通过 `/memory-sel` 选择 memory，并通过 `/memory-search` 手动选择需要注入的记忆。
- **FR-008B**: 系统 MUST 支持将 prompt 与 memory 应用于 GitHub Copilot 的任务流程，并向用户明确展示它们已被使用。
- **FR-009**: 系统 MUST 支持代码 agent 的核心任务能力，与 kilocode 的核心能力范围保持对齐，包括代码生成、修改、分析和执行辅助。
- **FR-009A**: 系统 MUST 支持通过 `/model` 切换当前任务所使用的模型，并在切换后明确反馈当前生效模型。
- **FR-009B**: 系统 MUST 支持在代码任务流程中调用 `grep`、`glob` 和 `exec` 三类必要工具，以完成搜索、定位和执行辅助操作。
- **FR-009C**: 系统 MUST 向用户明确区分模型生成内容、记忆注入内容与工具调用结果，以便用户理解输出来源。
- **FR-009D**: 系统 MUST 在首个版本中支持 GitHub Copilot 任务流程使用 prompt、memory 与必要工具调用能力。
- **FR-010**: 系统 MUST 在 provider、模型、会话或记忆不可用时提供清晰反馈，并允许用户继续完成可恢复操作。
- **FR-010A**: 系统 MUST 在用户输入未知 command、非法 command 参数或不适用的 command 状态时，给出明确错误提示与下一步建议。
- **FR-010B**: 系统 MUST 在 `grep`、`glob` 或 `exec` 调用失败、无结果或结果不完整时，提供明确反馈，并允许用户调整后继续任务。
- **FR-011**: 系统 MUST 允许用户控制哪些记忆和 prompt 可被当前任务使用。
- **FR-011A**: 系统 MUST 仅在任务需要时使用受支持工具，并确保工具调用范围与当前任务目标保持一致。
- **FR-012**: 系统 MUST 记录关键操作结果，便于用户追踪会话、记忆和 prompt 的变化。
- **FR-012A**: 系统 MUST 记录关键工具调用结果，便于用户追踪搜索、文件匹配和执行类操作的输出。

### Module Design & Interfaces *(mandatory)*

- **Module Scope**: 本功能覆盖模型接入模块、会话管理模块、记忆管理模块、prompt 管理模块、command 指令解析模块、工具调用模块、桌面窗口交互模块与 agent 核心任务编排模块。各模块职责必须清晰分离，模型接入负责能力统一，会话负责上下文生命周期，记忆负责上下文沉淀，prompt 负责输入模板复用，command 模块负责统一指令入口，工具调用模块负责受支持工具的结果获取，桌面窗口模块负责输入框/输出框交互，任务编排负责对外提供统一代码 agent 能力。
- **Function List**: 本次迭代至少包括 GitHub Copilot 接入、模型选择与切换、弹窗式窗口输入输出、会话创建与恢复、短期/长期记忆管理、prompt 管理、核心代码任务发起与结果查看、必要 command 指令集的查看/选择/删除/归档/恢复/搜索能力，以及 `grep`、`glob`、`exec` 工具调用能力。
- **Interface Design**: 对外需要提供统一的任务入口、窗口输入/输出入口、command 指令入口、会话入口、记忆入口、prompt 入口与工具结果反馈入口；内部需要定义模块之间的上下文传递、调用边界、指令解析规则、工具结果回传规则与状态更新规则。
- **Dependencies**: 该功能依赖 GitHub Copilot 可用性、用户提供的 GitHub Copilot 访问配置、会话与记忆持久化能力，以及后续扩展更多 provider/LLM 的能力边界。

### Critical Flow Visuals *(mandatory for important requirements)*

- **Sequence Diagram**: TODO(Sequence Diagram): 需要在规划阶段补充“启动程序 -> 弹出窗口 -> 输入框提交文本 -> 解析指令或任务 -> 选择 GitHub Copilot/会话/记忆/prompt -> 调用 grep/glob/exec -> 返回结果到输出框”的关键时序图。
- **Use Case Diagram**: TODO(Use Case Diagram): 需要在规划阶段补充开发者、桌面窗口、系统、GitHub Copilot provider 之间的主要用例关系图。
- **Importance Decision**: 该功能属于重点需求，因为它定义了 Pueblo 的核心能力边界与主要用户工作流，必须补充时序图和用例图。

### Key Entities *(include if feature involves data)*

- **Provider Profile**: 表示一个可接入的模型服务来源，包含提供方标识、可用模型列表、状态与使用约束。
- **Model Session**: 表示一次持续的 agent 协作会话，包含会话标识、历史消息、关联任务、状态与上下文范围。
- **Memory Record**: 表示可供 agent 复用的短期或长期记忆，包含类型、来源、适用范围、内容摘要与生命周期状态。
- **Prompt Asset**: 表示用户维护的 prompt 模板或片段，包含标题、分类、内容、适用场景与启用状态。
- **Agent Task**: 表示一次具体的代码工作请求，包含目标、输入上下文、关联会话、执行结果与状态。
- **Command Action**: 表示一次 command 指令调用，包含指令名称、目标对象、输入参数、执行结果与适用上下文。
- **Tool Invocation**: 表示一次工具调用行为，包含工具名称、调用目标、输入条件、执行结果与返回状态。
- **Desktop Window Session**: 表示一次弹窗式对话窗口交互，包含窗口标识、输入状态、输出内容和当前绑定会话。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-000**: 95% 以上的启动请求在 2 秒内弹出可输入的对话窗口，并显示输入框与输出框。
- **SC-000A**: 90% 以上的目标用户能够在单次窗口会话中连续完成不少于 5 条输入操作（命令或任务文本）且无需重启程序。
- **SC-001**: 90% 以上的目标用户能够在 10 分钟内完成首个模型接入并成功发起一次代码任务。
- **SC-002**: 85% 以上的已保存会话能够被用户成功恢复并继续完成后续多轮任务。
- **SC-003**: 80% 以上的目标用户在连续使用一周后认为记忆与 prompt 管理减少了重复输入。
- **SC-004**: 对于受支持的主流 provider 与主要 LLM，用户执行核心代码任务时的成功完成率达到 95% 以上。
- **SC-005**: 90% 以上的目标用户能够在无需额外说明文档的情况下，通过 command 指令完成常见会话、模型、prompt 与记忆操作。
- **SC-006**: 95% 以上的必要 command 指令调用能够返回明确结果反馈，且用户能够判断操作是否成功。
- **SC-007**: 90% 以上的典型代码任务能够通过 `grep`、`glob` 或 `exec` 的必要工具调用获得足够信息继续推进，而不需要用户重复手工查找。
- **SC-008**: 95% 以上的工具调用结果能够让用户明确判断调用成功、失败或无结果，并据此采取下一步操作。

## Assumptions

- 目标用户为需要借助 AI 完成编码、修改、分析与执行辅助任务的开发者。
- 首个版本仅覆盖主流 provider 与主要 LLM，更多 provider 和模型将在后续迭代扩展。
- 首个版本仅设计必要 command 指令，不在本次范围内覆盖所有潜在扩展指令。
- 首个版本仅支持 `grep`、`glob`、`exec` 三类必要工具调用，不在本次范围内覆盖更广泛工具生态。
- 用户已具备访问所选模型服务所需的前置条件，例如可用账号、授权或访问凭据。
- kilocode 的“核心能力对齐”在本规格中解释为：Pueblo 需要覆盖核心代码 agent 工作流，但不要求首个版本复制全部外围集成功能。
- 默认不在本次功能中定义计费、团队权限或企业级治理能力，除非后续规格单独提出。
- 默认 command 指令采用统一风格命名，并允许未来在不破坏现有必要指令的前提下继续扩展。
- 默认工具调用仅用于支持当前代码任务，不假设独立工具市场、插件商店或用户自定义工具注册能力。
- 首个版本必须包含 GitHub Copilot，其他 provider 是否同时交付可以按验证结果增量扩展。
- 首个版本允许引入一个简洁桌面弹窗窗口，用作 CLI 核心能力的输入输出壳层，而不是完整多页面前端产品。

## Out of Scope *(mandatory)*

- 首个版本不要求一次覆盖所有 provider，但 GitHub Copilot 不属于延期项。
- 首个版本不支持除 `grep`、`glob`、`exec` 之外的工具调用，因为当前只实现必要工具集。
- 首个版本不支持团队协作、计费、权限治理和远程托管存储，因为这些能力不属于当前必要交付范围。
- 首个版本不支持复杂多窗口桌面应用、Web 控制台或移动前端，因为当前只引入完成核心交互所需的单窗口壳层。

## Deferred Capabilities (Out of Scope for This Iteration)

**Multi-Window Support**: Deferring support for multiple simultaneous desktop windows. Current iteration focuses on single popup window for MVP interaction flow.

**Non-Essential Providers**: Deferring support for additional LLM providers (e.g., OpenAI, Anthropic, etc.) beyond mandatory GitHub Copilot. Provider registry allows future extension but no additional adapters implemented in this iteration.

**Other Deferred Items** (already documented in constraints):
- Team collaboration features
- Billing and permissions systems
- Plugin marketplace and custom tool registration
- Remote hosted storage and databases
- Complex multi-page frontends beyond single window shell

## Scope Validation

- 当前范围明确包含 GitHub Copilot、单窗口弹出式对话入口、prompt/memory 管理和 `grep`/`glob`/`exec` 工具调用。
- 当前实现不得引入团队协作、权限系统、计费、插件市场、自定义工具注册、远程数据库或复杂多页面前端。
- 当前实现中的 `/prompt-add` 与 `/memory-add` 仅作为完成 prompt/memory 管理闭环所需的最小写入入口，不构成额外范围扩张。

## Iteration Fit & Test Strategy *(mandatory)*

- **Iteration Scope**: 当前规格定义 Pueblo 的核心代码 agent 能力范围，首轮迭代应至少交付 GitHub Copilot 接入、弹窗式窗口输入输出、基于 command 的会话管理、基础记忆/prompt 管理、必要工具调用闭环，并支持一个完整代码任务工作流的独立验收。
- **TDD Plan**: 先编写窗口弹出与输入输出、GitHub Copilot 接入、模型切换、command 指令解析、会话恢复、记忆复用、prompt 调用与 `grep`/`glob`/`exec` 工具调用相关失败测试，再逐步实现相应能力，最终通过回归测试收敛设计。
- **Integration Validation**: 本迭代必须覆盖“窗口输入被系统读取并处理”“GitHub Copilot 接入后完成任务”“command 驱动的会话恢复后继续任务”“command 驱动的记忆与 prompt 注入后完成代码任务”“工具调用结果用于推进代码任务”五类集成验证。
- **Parallel Work Opportunities**: GitHub Copilot 接入、command 指令管理、会话管理、记忆管理、prompt 管理、窗口交互模块与工具调用可按模块拆分并行推进，但需在统一任务入口和上下文编排规则上进行集成对齐。
