# Edit 工具改进方案

> 创建日期: 2026-07-03
> 状态: 🟡 草案讨论中

## 一、背景

`edit` 工具是项目中的核心文件修改工具，用于根据 `oldText` 匹配文件内容并替换为 `newText`。在实际使用中，其精确匹配策略经常因微小的文本差异（空白、编码等）导致失败，且缺少行级操作能力。

## 二、当前实现分析

### 2.1 源码位置

| 文件 | 作用 |
|------|------|
| `src/tools/edit-tool.ts` (748行) | 核心实现 |
| `src/providers/provider-adapter.ts` (第68-102行) | Schema 定义 |

### 2.2 当前参数

```typescript
interface EditParameters {
  path: string;           // 必需：目标文件路径
  oldText: string;        // 必需：要匹配的原文
  newText: string;        // 必需：替换后的新文本
  startLine?: number;     // 可选：匹配范围起始行
  endLine?: number;       // 可选：匹配范围结束行
}
```

### 2.3 当前匹配流程 (`prepareEditRequest` → `prepareTextEditOutcome`)

```
用户输入 (path, oldText, newText, [startLine, endLine])
  │
  ├─ resolveEditPath() → 解析文件路径
  ├─ readFile() → 读取全部内容
  │
  ├─ 如果 startLine/endLine 存在:
  │     └─ 截取 [startLine, endLine] 范围文本 → 在此范围内 indexOf(oldText)
  │
  ├─ 否则:
  │     └─ 在全文中 indexOf(oldText)
  │
  ├─ 如果匹配次数 ≠ 1:
  │     └─ 返回错误
  │
  └─ 匹配成功:
        └─ applyPendingEditOutcome() → 备份 → 替换 → 写入
```

### 2.4 关键发现

1. **匹配方式**: 使用 `indexOf()` 精确字符串匹配，无任何标准化预处理
2. **范围约束**: `startLine`/`endLine` 仅缩小搜索范围，不提供独立行操作
3. **失败处理**: 匹配失败时仅返回错误消息，不提供候选位置
4. **备份机制**: 写入前会创建备份，支持 `undo_edit` 回滚
5. **无预览**: 无 `dryRun` 模式

## 三、改进方案

### ✨ 方案 A: 新增行级操作模式（高优先级）

新增三个不依赖 `oldText` 的操作模式，基于行号直接操作。

#### 设计

```typescript
// 复用现有参数+新增操作类型
// 方案 a1: 通过 detectOperationType() 自动判断
// 方案 a2: 显式参数 mode: 'replace' | 'insertAfter' | 'deleteLines'
```

#### 新增操作

| 操作 | 触发条件 | 参数需求 | 行为 |
|------|---------|---------|------|
| 行替换 | `oldText` 为空 且 `startLine`/`endLine` 存在 | path, startLine, endLine, newText | 替换第 `startLine` 到 `endLine` 行的内容为 `newText` |
| 行后插入 | `oldText` 为空 且 `startLine` 存在 | path, startLine, newText | 在第 `startLine` 行后插入 `newText` |
| 行删除 | `oldText` 为空 且 `startLine`/`endLine` 存在 | path, startLine, endLine | 删除第 `startLine` 到 `endLine` 行 |
| 追加 | `oldText` 为空 且无行号 | path, newText | 在文件末尾追加 `newText` |

#### 实现要点

- 在 `prepareTextEditOutcome()` 中增加分支判断
- 行号转换为 0-based 索引，注意文件末尾换行符处理
- 行操作模式下，`newText` 可以是多行内容
- `deleteLines` 模式忽略 `newText`

---

### ✨ 方案 B: oldText 容错增强（高优先级）

在保留 `indexOf()` 精确匹配的同时，增加降级匹配策略。

#### 匹配流程（改进版）

```
try indexOf(oldText)   ← 相等匹配
  ├─ 成功 (n=1) → 直接替换
  ├─ 成功 (n>1) → 检查 startLine/endLine 消歧
  └─ 失败 → 进入降级匹配
              ├─ 标准化 whitespace（tab→空格,trim行尾空格）
              ├─ 标准化换行（\r\n → \n）
              └─ 在标准化文本上 indexOf
                  ├─ 成功 → 用标准化位置执行替换
                  └─ 失败 → 返回候选位置（Levenshtein 最小距离区域）
```

#### 实现细节

- **行尾空白标准化**: 对 oldText 和文件内容进行 `.split('\n').map(l => l.trimEnd()).join('\n')`
- **换行符标准化**: `.replace(/\r\n/g, '\n')`
- **Tab → 空格**: 可选的降级步骤
- **候选位置提示**: 滑动窗口 + Levenshtein 距离计算

---

### ✨ 方案 C: 预览模式（中优先级）

#### 设计

```typescript
interface EditParameters {
  // ... 现有参数
  dryRun?: boolean;  // 新增: true 时只返回 diff 不写文件
}
```

#### 行为

- `dryRun: true` 时：
  1. 执行完整匹配流程
  2. 不创建备份，不写入文件
  3. 返回格式化的 diff 输出（类似 unified diff 格式）
  4. 返回匹配位置信息（行号、所在行上下文）

---

### ✨ 方案 D: 正则匹配模式（低优先级）

#### 设计

```typescript
interface EditParameters {
  // ... 现有参数
  oldPattern?: string;   // 新增: 正则表达式字符串
  oldFlags?: string;     // 新增: 正则标志（如 "gi"）
}
```

- 当 `oldPattern` 存在时，使用正则匹配替代 `indexOf(oldText)`
- `oldPattern` 和 `oldText` 互斥，同时提供时报错
- 匹配成功后，替换逻辑与现有 `oldText` 模式相同

---

## 四、实现路线图

| 优先级 | 方案 | 复杂度 | 风险 | 建议实现阶段 |
|--------|------|--------|------|------------|
| P0 | A: 行级操作 | 低（约50-80行新增代码） | 低 | 阶段一 |
| P0 | B: oldText 容错 | 低（约30-50行新增代码） | 低 | 阶段一 |
| P1 | C: 预览模式 | 中（约80-120行新增代码） | 低 | 阶段二 |
| P2 | D: 正则匹配 | 中（约50-80行新增代码） | 中（正则安全性） | 阶段三 |

### 阶段一（P0）

在 `edit-tool.ts` 中实现：

1. **行替换**: 在 `prepareTextEditOutcome()` 中增加 `if (!oldText && startLine != null)` 分支
2. **行后插入**: 同上的独立分支
3. **行删除**: 在编辑参数中支持删除模式
4. **空白容错**: 在 `findFirstMatch()` 中增加降级匹配
5. **追加模式**: 文件末尾追加内容

### 涉及修改的文件

| 文件 | 改动内容 |
|------|---------|
| `src/providers/provider-adapter.ts` | 更新 Schema 注释，允许 `oldText` 在行操作模式下为空 |
| `src/tools/edit-tool.ts` | 新增行操作分支 + 容错匹配逻辑 |
| `src/tools/tool-service.ts` | 新增 `undo_edit` 对行操作的兼容（影响次要） |

---

## 五、讨论项

- [ ] **行操作 vs 新工具函数**: 是扩展 `edit` 还是新增 `insertLines`/`deleteLines` 独立工具？
- [ ] **行号基准**: 1-based（用户视角）vs 0-based（内部索引）？
- [ ] **`deleteLines` 行为**: 删除后剩余行是否重新编号？是否有确认机制？
- [ ] **容错降级是否默认开启**: 还是需要通过 `fuzzy: true` 参数显式开启？
- [ ] **undo_edit 兼容性**: 行操作是否支持回滚？
