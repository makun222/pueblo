# 测试计划 模板

## 元数据
```
version: 1.0
author: Agent F (Tester)
basedOnPRD: prd.md v{version}
basedOnDesign: architecture.md v{version}
basedOnTasks: task-manifest.md v{version}
status: [DRAFT | REVIEWING | APPROVED]
```

## 1. 测试范围

### 1.1 纳入范围
- {功能模块A} — 所有PRD条目
- {功能模块B} — 所有PRD条目
- ...

### 1.2 排除范围
- {明确不测试的内容}（理由：{理由}）

## 2. 测试策略

### 2.1 测试层级
| 层级 | 执行者 | 时机 | 覆盖目标 |
|------|--------|------|---------|
| 单元测试 | Implementer | 代码实现阶段 | 每个函数/方法的边界和异常 |
| 集成测试 | Tester F | 代码合并后 | 模块间接口对接 |
| 回归测试 | Tester F | 每次代码变更后 | 全量功能保证 |

### 2.2 测试环境
{测试环境描述：如Mock方式、测试框架、CI配置}

## 3. 测试用例清单

### 3.1 {功能模块A}

| 用例ID | 标题 | 关联PRD | 关联接口 | 类别 | 优先级 |
|--------|------|---------|---------|------|-------|
| TC-001 | {测试标题} | PRD-1.1 | {INTERFACE-X} | normal | P0 |
| TC-002 | {测试标题} | PRD-1.1 | {INTERFACE-X} | boundary | P1 |
| TC-003 | {测试标题} | PRD-1.2 | {INTERFACE-Y} | exception | P0 |

### 3.2 {功能模块B}
...

## 4. 需求-测试追溯矩阵

| PRD条目 | 测试用例 | 覆盖类型 |
|---------|---------|---------|
| PRD-1.1 | TC-001 (正常), TC-002 (边界) | 功能覆盖 |
| PRD-1.2 | TC-003 (异常) | 异常覆盖 |
| PRD-NFR-1 | TC-004 (性能) | 非功能覆盖 |
| ... | ... | ... |

## 5. 单个测试用例模板

`test/cases/tc-{NNN}.md`

```markdown
# TC-{NNN}: {测试标题}

## 元数据
- linkedPRD: [PRD-{N}]
- linkedInterface: [INTERFACE-{M}]
- linkedTask: [task-{NN}]
- category: [normal | boundary | exception]
- priority: [P0 | P1 | P2]

## 前置条件
{测试开始前必须满足的条件}

## 测试步骤
1. {步骤1}
2. {步骤2}
3. {步骤3}

## 预期结果
{测试成功时的预期输出/状态}

## 测试数据
{输入数据示例，或数据构造说明}
```

---

## 测试计划质量控制规则

在输出测试计划前，F要逐项检查：
- [ ] 每个PRD功能条目至少有一个测试用例
- [ ] 测试用例类别覆盖了normal/boundary/exception
- [ ] 非功能需求（性能/安全）至少有评估方法
- [ ] 测试用例可独立执行（不依赖顺序）
- [ ] 每个测试用例有明确的预期结果
- [ ] 测试数据避免硬编码魔数
