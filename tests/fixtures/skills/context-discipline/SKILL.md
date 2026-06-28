# context-discipline

## 目的
防止上下文膨胀，保持每轮信息紧凑、可操作。适用于所有对话轮次，尤其长任务。

## 触发时机
- 每个回复的**收尾阶段**（在完成本轮工作后输出状态块）
- 当发现自己在重复分析、重复读取已读文件、或引用超过 3 轮前的历史细节时，**立即应用本 Skill**

## 上下文截断规则

### 保留（写入 ENGINEERING NOTE 或 TASK_STATUS）
| 类别 | 示例 |
|------|------|
| 上一轮未完成的 TODO 清单 | `[ ] ipc.ts:351 添加 onProgress` |
| 本轮已修改的文件+行号+内容摘要 | `ipc.ts L389-395: 添加 MonitorWindow` |
| 本轮待执行的明确指令 | 用户说"继续"→继续未完成项 |
| 关键架构约束 | `DesktopLoopJobManager` 构造器签名不一致 |

### 丢弃（不要带入下一轮）
| 类别 | 示例 |
|------|------|
| 多轮重复的根因分析 | "问题在于两条路径..." (只保留第一次结论) |
| "让我确认一下"的 read 记录 | 中间验证性的文件读取 |
| 历史 turn 的中间态分析 | 已废弃的方案讨论 |
| 冗长的文件内容引用 | 超过 10 行的代码块 |

## 输出格式

### 每轮结束必须输出

```
## TASK_STATUS
- DONE: N/M
- TODO: [1] <具体文件:行号> <动作> [2] ...
- BLOCKED: <阻塞原因 或 none>

## ENGINEERING NOTE (retain)
- <文件> L<行号>: <决策/变更摘要>
- ...
```

### 规则
- TASK_STATUS 的 TODO 项必须包含**文件路径 + 行号范围 + 具体动作**
- ENGINEERING NOTE 每项一行，以文件路径开头
- 如果本轮无变更，ENGINEERING NOTE 可以为空
- 如果所有 TODO 完成，标记 `DONE: N/N` 并总结

## 反模式（禁止）

1. **禁止重新确认已完成项** — 如果 TASK_STATUS 标记 DONE，不要再次验证
2. **禁止重新分析根因** — 如果 ENGINEERING NOTE 已有结论，直接引用
3. **禁止无目的的文件读取** — 只有在需要定位修改点时才 read
4. **禁止引用超过 2 轮前的历史细节** — 除非在 ENGINEERING NOTE 中有记录
5. **禁止输出冗长的文件内容** — 引用文件内容时只给出所在行号和简短摘要

## 与 execution-discipline 的协作
- `execution-discipline` 控制**行为**（连续 edit、禁止中间确认）
- `context-discipline` 控制**输出**（截断、状态块、ENGINEERING NOTE）
- 两者不冲突，同时启用

## 验证
- 每轮回复是否在 100 行以内？
- 是否包含 TASK_STATUS 块？
- ENGINEERING NOTE 是否只包含本轮决策/变更？
- 是否避免了所有 5 项反模式？
