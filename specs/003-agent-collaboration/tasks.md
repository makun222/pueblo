# Tasks: Agent Collaboration Scheduling

**Input**: Design documents from `/specs/003-agent-collaboration/`
**Prerequisites**: plan.md (required), spec.md (required)
**Tests**: 所有非纯类型任务 MUST 先写失败测试，再写实现。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (e.g. [US1])

## Phase 1: Schema & Core Types (P0)

- [ ] T001 Create `CollaborationGraph`, `CollaborationNode`, `CollaborationEdge` schemas in `src/shared/schema.ts`
- [ ] T002 [P] Create `CollaborationInstance`, `CollaborationRound`, `NodeRoundResult`, `CompletionCriteria` schemas in `src/shared/schema.ts`
- [ ] T003 Export new schema types and infer TypeScript types

## Phase 2: AgentCollaborationService (P0)

- [ ] T004 Create `src/agent/agent-collaboration.ts` with `AgentCollaborationService` class
- [ ] T005 Implement `startCollaboration(graph, goal, criteria)` → `CollaborationInstance`
- [ ] T006 Implement `executeNextRound(instanceId)` → `CollaborationRound` (A→B pipeline)
- [ ] T007 Implement `evaluateCompletion(instance)` → boolean
- [ ] T008 Implement `getStatus(instanceId)` → status snapshot
- [ ] T009 Write unit tests in `tests/unit/agent-collaboration.test.ts`

## Phase 3: IPC Channels (P0)

- [ ] T010 Add `CollaborationProgress` and `CollaborationStartInput` types to `src/desktop/shared/ipc-contract.ts`
- [ ] T011 Register `collaboration:start`, `collaboration:progress`, `collaboration:complete`, `collaboration:error` handlers in `src/desktop/main/ipc.ts`
- [ ] T012 Wire IPC handlers to `AgentCollaborationService`

## Phase 4: Integration Validation

- [ ] T013 Integration test: start → execute round → check output injection in `tests/integration/agent-collaboration.test.ts`
- [ ] T014 Integration test: completion criteria triggers stop
