# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`  
**Created**: [DATE]  
**Status**: Draft  
**Input**: User description: "$ARGUMENTS"

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
  
  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently - e.g., "Can be fully tested by [specific action] and delivers [specific value]"]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- What happens when [boundary condition]?
- How does system handle [error scenario]?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
  Specifications SHOULD be authored in Chinese by default, while file names,
  identifiers, and paths may remain in English.
-->

### Functional Requirements

- **FR-001**: System MUST [specific capability, e.g., "allow users to create accounts"]
- **FR-002**: System MUST [specific capability, e.g., "validate email addresses"]  
- **FR-003**: Users MUST be able to [key interaction, e.g., "reset their password"]
- **FR-004**: System MUST [data requirement, e.g., "persist user preferences"]
- **FR-005**: System MUST [behavior, e.g., "log all security events"]

*Example of marking unclear requirements:*

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]
- **FR-007**: System MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Module Design & Interfaces *(mandatory)*

<!--
  ACTION REQUIRED: Before implementation planning, define the module-level
  design basis for this feature.
-->

- **Module Scope**: [明确本功能涉及哪些模块、各模块职责边界，以及为何保持模块内高内聚、模块间低耦合]
- **Function List**: [列出模块内关键功能点，说明哪些属于本次迭代范围]
- **Necessary Scope**: [说明哪些是本次迭代的必要功能，哪些能力被明确延后，以满足 only necessary 原则]
- **Interface Design**: [列出外部接口、内部接口、输入输出结构、调用约束]
- **Dependencies**: [列出依赖模块、外部系统、约束条件与耦合假设]

### Critical Flow Visuals *(mandatory for important requirements)*

<!--
  ACTION REQUIRED: Important requirements MUST include both a sequence diagram
  and a use case diagram. If this feature is not considered important, explain
  why and who accepted that classification.
-->

- **Sequence Diagram**: [链接、嵌入位置或 TODO，说明关键时序交互]
- **Use Case Diagram**: [链接、嵌入位置或 TODO，说明参与者与用例边界]
- **Importance Decision**: [说明该功能是否属于重点需求；若否，记录理由]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: [Measurable metric, e.g., "Users can complete account creation in under 2 minutes"]
- **SC-002**: [Measurable metric, e.g., "System handles 1000 concurrent users without degradation"]
- **SC-003**: [User satisfaction metric, e.g., "90% of users successfully complete primary task on first attempt"]
- **SC-004**: [Business metric, e.g., "Reduce support tickets related to [X] by 50%"]

## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right assumptions based on reasonable defaults
  chosen when the feature description did not specify certain details.
-->

- [Assumption about target users, e.g., "Users have stable internet connectivity"]
- [Assumption about scope boundaries, e.g., "Mobile support is out of scope for v1"]
- [Assumption about data/environment, e.g., "Existing authentication system will be reused"]
- [Dependency on existing system/service, e.g., "Requires access to the existing user profile API"]

## Out of Scope *(mandatory)*

<!--
  ACTION REQUIRED: Explicitly list capabilities intentionally deferred from the
  current iteration so the spec remains focused on necessary functionality only.
-->

- [列出本次不做的功能，并说明其被延后的原因]

## Iteration Fit & Test Strategy *(mandatory)*

<!--
  ACTION REQUIRED: Confirm how this feature fits the current iteration and how
  it will be validated under the constitution.
-->

- **Iteration Scope**: [说明本功能在当前迭代中交付哪个或哪些模块需求，以及为何可独立验收]
- **TDD Plan**: [说明先写哪些失败测试，再进入实现]
- **Integration Validation**: [说明本迭代必须覆盖的集成测试范围]
- **Parallel Work Opportunities**: [说明哪些任务可由多个 agent 并行执行，以及依赖关系]
