# Pueblo 设计文档索引

> 统一入口，集中归集所有设计文档。
> 整理日期: 2026-07-03

---

## 目录结构

```
design/
├── INDEX.md              ← 本文件，全局索引
├── architecture/         ← 系统架构设计（整体架构、模块拓扑）
├── subsystem/            ← 子系统/功能模块设计
├── plan/                 ← 可执行的实施计划（操作步骤）
├── review/               ← 设计评审、复盘文档
├── guide/                ← 使用指南、集成手册
└── legacy/               ← 已废弃/历史文档（保留参考，标记状态）
```

## 文档状态标记

每篇文档需在标题下方标注状态：

| 标记 | 含义 |
|------|------|
| ✅ 活跃 | 当前有效，持续维护 |
| ⚠️ 待审 | 需要评审是否仍适用 |
| 📦 归档 | 已实现且不再维护 |
| 🗑️ 废弃 | 已被替代或不再适用 |
| 📝 草稿 | 初稿撰写中 |
| 🔄 迁移中 | 从原位置迁移至此，尚未最终确认 |

## 文档清单

### architecture/ — 系统架构

| 文档 | 源位置 | 状态 |
|------|--------|------|
| architecture-document.md | `agent-15a2e5cb-../architecture-document.md` → `design/architecture/architecture-document.md` | ✅ 活跃 |

### subsystem/ — 子系统设计

| 文档 | 新位置 | 源位置 | 状态 |
|------|--------|--------|------|
| loop.md | `design/subsystem/loop.md` | `designs/loop-plan-b.md` / `loop-update-design.md` | ✅ 已迁移（已合并 loop-update.md） |
| loop-update.md | `design/subsystem/loop-update.md` | `loop-update-design.md` | ⚠️ 已合并到 loop.md，源文件仅保留重定向 |
| mcp-upgrade.md | `design/subsystem/mcp-upgrade.md` | `designs/mcp-upgrade-1.md` | ✅ 已迁移 |
| mcp-tool-execution-fix.md | `design/subsystem/mcp-tool-execution-fix.md` | `docs/mcp-tool-execution-fix-design.md` | ✅ 已迁移 |
| amber-init.md | `design/subsystem/amber-init.md` | `docs/amber-init-design.md` | ✅ 已迁移 |
| context-resolver.md | `design/subsystem/context-resolver.md` | `designs/optimize-context-resolver.md` / `.kilo/plans/optimize-context-resolver.md` | ✅ 已迁移（已合并，.kilo/plans 版本已重定向） |
| context-budget-system-redesign.md | `design/subsystem/context-budget-system-redesign.md` | `agent-15a2e5cb-../context-budget-system-redesign.md` | ✅ 已迁移 |

### plan/ — 实施计划

| 文档 | 新位置 | 源位置 | 状态 |
|------|--------|--------|------|
| channel-feishu-plan.md | `design/plan/channel-feishu-plan.md` | `.kilo/plans/channel-feishu-integration.md` | ✅ 已迁移 |
| next-step-text-refactor.md | `design/plan/next-step-text-refactor.md` | `.kilo/plans/next-step-action-plain-text-refactor.md` | ✅ 已迁移 |
| next-step-ux-review.md | `design/plan/next-step-ux-review.md` | `.kilo/plans/next-step-action-ux-review.md` | ✅ 已迁移 |

### review/ — 设计评审

| 文档 | 新位置 | 源位置 | 状态 |
|------|--------|--------|------|
| 202409-turn-indexer-review.md | `design/review/202409-turn-indexer-review.md` | `docs/design-review-202409-turn-indexer.md` | ✅ 已迁移 |

### guide/ — 使用指南

| 文档 | 新位置 | 源位置 | 状态 |
|------|--------|--------|------|
| channel-feishu-guide.md | `design/guide/channel-feishu-guide.md` | `docs/channel-feishu-usage-guide.md` | ✅ 已迁移 |

### legacy/ — 历史/归档

| 文档 | 新位置 | 源位置 | 状态 |
|------|--------|--------|------|
| multi-agent-analysis.md | `design/legacy/multi-agent-analysis.md` | `designs/多Agent协作开发流程分析报告.md` | 📦 归档 |
| next-step-buttons-debug.md | `design/legacy/next-step-buttons-debug.md` | `docs/next-step-buttons-debug.md` | 🗑️ 废弃 |

---

## 维护规范

1. **新建设计文档**：直接放在 `design/` 对应子目录下，并在 INDEX.md 注册
2. **文档状态**：每次更新时检查并更新状态标记
3. **交叉引用**：使用相对路径引用其他设计文档 `../subsystem/xxx.md`
4. **Git 提交**：迁移完成后，原位置文件删除需单独 commit
5. **索引更新**：新增/归档/废弃文档时，同步更新 INDEX.md

## 待办

- [x] Phase 1: 建立目录结构 + INDEX.md
- [x] Phase 2: 迁移所有现状文档到 design/
- [x] Phase 3: 合并内容重复的文档（context-resolver, loop）
- [x] Phase 4: 迁移 workspace 中有价值的设计文档（architecture-document.md, context-budget-system-redesign.md 等）
- [x] Phase 5: 原位置留重定向提示
