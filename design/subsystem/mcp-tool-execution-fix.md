# MCP Tool Execution Fix — 设计与修复

> 🔄 迁移中 — 源位置: `docs/mcp-tool-execution-fix-design.md`

## 背景

当前 Pueblo 代码库中，**MCP 工具的执行链路**存在 4 个阻塞点，导致 LLM 无法调用 MCP（Model Context Protocol）服务器提供的工具。

这些阻塞点分布在工具注册、参数转换、类型断言和审批策略四个环节。

---

## 阻塞点总览

| # | 阻塞点 | 影响 | 修复难度 |
|---|--------|------|---------|
| 1 | ToolService 未注入 MCP Client Manager | 外部工具描述和执行时无法访问 MCP 工具 | 中 |
| 2 | normalizeProviderToolName 不允许 MCP 工具名 | LLM 返回的 `mcp__server__tool` 名称被过滤掉 | 低 |
| 3 | parseProviderToolArgs 不支持 MCP 参数 | 无法将 MCP 工具的参数转换为 ToolService 可接受的格式 | 低 |
| 4 | 审批策略兜底为 'deny' | CLI 模式下 MCP 工具调用被拒绝执行 | 中 |

---

## 阻塞点 1：ToolService 未注入 MCP Client Manager

### 根因

`src/tools/tool-service.ts` 中的 `ToolService` 在构造函数中接收 `mcpClientManager?: McpClientManager` 参数，但在 `src/cli/index.ts` 的初始化链中并没有传入 McpClientManager。

### 影响范围

- `src/cli/index.ts` — 创建 ToolService 的调用点
- `src/tools/tool-service.ts` — describeTools / executeTool 中 MCP 工具的分发逻辑

### 具体影响

1. `describeTools()`（tool-service.ts:205-213）只返回内置工具列表，不包含 MCP 工具
2. `executeTool()`（tool-service.ts:248-252）对 `mcp__` 开头的工具名返回 `'No such tool'` 错误

### 修复方案

在 CLI 初始化流程中创建 `McpClientManager` 并传入 `ToolService`：

```typescript
// src/cli/index.ts
import { McpClientManager } from '../mcp/mcp-client-manager.js';

// 在创建 ToolService 之前
const mcpClientManager = new McpClientManager(configPath, runtimeConfig);
await mcpClientManager.initializeClients();  // 启动 MCP 服务器进程并连接

// 创建 ToolService 时传入
const toolService = new ToolService({ mcpClientManager });
```

---

## 阻塞点 2：normalizeProviderToolName 不允许 MCP 工具名

### 根因

`src/providers/provider-adapter.ts` 中的 `normalizeProviderToolName()` 函数：

```typescript
export function normalizeProviderToolName(toolName: string): string | undefined {
  if (ProviderToolRegistry[toolName]) {
    return toolName;
  }
  // ... 其他 name matching
  return undefined;  // ← MCP 工具落至此分支，被过滤
}
```

### 影响范围

- `src/providers/provider-adapter.ts` — `normalizeProviderToolName()`（约 235 行）
- `src/agent/task-runner.ts` — `_buildSystemMessageAndTools()`（约 1264 行）调用上述函数

### 修复方案

在 `normalizeProviderToolName()` 中添加对 MCP 工具名的支持：

```typescript
export function normalizeProviderToolName(toolName: string): string | undefined {
  // ❗ 内置工具优先匹配
  if (ProviderToolRegistry[toolName]) {
    return toolName;
  }

  // ✅ MCP 工具名格式：mcp__<serverName>__<toolName>
  if (toolName.startsWith('mcp__')) {
    return toolName;
  }

  // ... 其他 name matching
  return undefined;
}
```

---

## 阻塞点 3：parseProviderToolArgs 不支持 MCP 参数

### 根因

`src/providers/provider-adapter.ts` 中的 `parseProviderToolArgs()` 函数没有定义 `'mcp_tool'` 类型分支。

### 影响范围

- `src/providers/provider-adapter.ts` — `parseProviderToolArgs()` 函数
- `ToolArgs` 类型定义 — 缺少 `mcp_tool` 分支

### 修复方案

在 `ToolArgs` 联合类型中添加 `mcp_tool` 类型，并在 `parseProviderToolArgs()` 中添加对应的分支处理：

```typescript
export type ToolArgs =
  | { type: 'glob'; pattern: string }
  | { type: 'grep'; pattern: string; include?: string; path?: string }
  | { type: 'exec'; command: string }
  | { type: 'shell_exec'; mode: 'cmd' | 'powershell'; command: string }
  | { type: 'read'; path: string; startLine?: number; endLine?: number }
  | { type: 'edit'; path: string; oldText: string; newText: string; startLine?: number; endLine?: number }
  | { type: 'write'; path: string; text: string }
  | { type: 'memo_recall'; keyword?: string }
  // ✅ 新增 MCP 工具类型
  | { type: 'mcp_tool'; toolName: string; args: Record<string, unknown> };
```

---

## 阻塞点 4：`getToolExecutionPolicy()` 将 MCP 工具设为 `'approval-required'`，CLI 模式下无审批处理器

### 根因

`src/providers/provider-adapter.ts` 中的 `getToolExecutionPolicy()` 函数：

```typescript
function getToolExecutionPolicy(toolName: string): ToolExecutionPolicy {
  switch (toolName) {
    case 'glob': case 'grep': case 'read': case 'exec': return 'auto-approve';
    case 'write': case 'edit': case 'shell_exec': return 'approval-required';
    case 'memo_recall': return 'auto-approve';
    default:
      return 'approval-required';  // ← MCP 工具落至此分支
  }
}
```

在 `task-runner.ts` 的审批逻辑中（~1010 行）：

```typescript
const decision = this.requestToolApproval?.(request) ?? 'deny';
// requestToolApproval 在 CLI 模式下未设置 → undefined → 返回 'deny'
```

### 影响范围

- `getToolExecutionPolicy()`（`src/providers/provider-adapter.ts` 约 667 行）
- `task-runner.ts` 中 `executeToolCallWithApproval()`/`resolveToolApprovalDecisions()`（~890-1010 行）
- CLI 启动入口（`src/cli/index.ts`）— `requestToolApproval` 回调未设置

### 修复方案

**选项 A（推荐）：在 `getToolExecutionPolicy()` 中添加 MCP 工具的白名单/策略配置：**

```typescript
function getToolExecutionPolicy(toolName: string, mcpToolPolicies?: Record<string, ToolExecutionPolicy>): ToolExecutionPolicy {
  // ❗ 内置工具策略优先
  switch (toolName) {
    case 'glob': case 'grep': case 'read': case 'exec': return 'auto-approve';
    case 'write': case 'edit': case 'shell_exec': return 'approval-required';
    case 'memo_recall': return 'auto-approve';
    default:
      // ✅ MCP 工具：查找策略映射表，默认 'auto-approve'（或按需）
      if (toolName.startsWith('mcp__')) {
        if (mcpToolPolicies && mcpToolPolicies[toolName]) {
          return mcpToolPolicies[toolName];
        }
        return 'auto-approve';  // MCP 工具默认自动批准
      }
      return 'approval-required';
  }
}
```

**选项 B：在 CLI 初始化时设置 `requestToolApproval` 回调：**

任务启动时自动批准 MCP 工具的调用，或提供 CLI 参数 `--mcp-auto-approve` 控制：

```typescript
// src/cli/index.ts — 运行任务入口处
const taskRunner = new TaskRunner({
  // ... 其他配置
  requestToolApproval: async (request) => {
    if (request.policy === 'auto-approve') return 'approved';
    // 对于 MCP 工具的 'approval-required' 策略：
    if (request.toolName.startsWith('mcp__')) {
      // 可以通过 CLI 标志 --mcp-auto-approve 跳过确认
      if (flags.mcpAutoApprove) return 'approved';
      // 或通过交互式提示（stdin 确认）
      return await promptUserForApproval(request);
    }
    // 其他 approval-required 工具走交互式审批
    return await promptUserForApproval(request);
  },
});
```

**选项 C（最安全）：将 MCP 工具策略设为可配置的映射表：**

```typescript
// McpClientManager 读取配置文件中的 per-tool 策略
// mcp.json:
// {
//   "servers": { ... },
//   "policies": {
//     "mcp__server1__read_file": "auto-approve",
//     "mcp__server1__write_file": "approval-required"
//   }
// }
```

---

## 依赖关系与实施顺序

| 修复序号 | 阻塞点 | 前置依赖 | 影响文件 | 风险 |
|---------|--------|---------|---------|------|
| 1 | ToolService 注入 mcpClientManager | 无 | `src/cli/index.ts`, `src/tools/tool-service.ts` | 中 — 需确保 McpClientManager 的配置加载正确 |
| 2 | normalizeProviderToolName 允许 MCP 名 | 无 | `src/providers/provider-adapter.ts` | 低 — 纯条件扩展 |
| 3 | parseProviderToolArgs 支持 MCP 参数 | 修复 2 | `src/providers/provider-adapter.ts` | 低 — 新增 union 分支 |
| 4 | 审批策略兜底 | 无（可选依赖修复 2/3） | `src/providers/provider-adapter.ts`, `src/cli/index.ts`, `src/agent/task-runner.ts` | 中 — 需平衡安全性与可用性 |

**推荐实施顺序：2 → 3 → 1 → 4**

修复 2 和 3 是纯函数扩展，无副作用，可以安全地先实施。修复 1 需要较复杂的 McpClientManager 配置逻辑，修复 4 需要权衡 CLI 交互模式。

---

## 验证路径

### 单元测试覆盖

每项修复后执行以下测试：

| 修复 | 测试用例 | 预期 |
|-----|---------|------|
| 1 | 创建 ToolService 时传入 mcpClientManager | describeTools() 包含 MCP 工具；executeTool('mcp__srv__t', {...}) 返回 MCP 执行结果 |
| 1 | 不传入 mcpClientManager | 向后兼容：describeTools() 仅返回内置工具 |
| 2 | normalizeProviderToolName('mcp__filesys__read_file') | 返回 'mcp__filesys__read_file' |
| 2 | normalizeProviderToolName('invalid_tool') | 返回 undefined（不变） |
| 3 | parseProviderToolArgs('mcp__x__y', {path: '/tmp'}) | 返回 {type: 'mcp_tool', toolName: 'mcp__x__y', args: {path: '/tmp'}} |
| 3 | parseProviderToolArgs('glob', {pattern: '**/*'}) | 不变，仍返回 {type: 'glob', pattern: '**/*'} |
| 4 | getToolExecutionPolicy('mcp__server__tool') | 返回 'auto-approve'（或配置的策略） |
| 4 | getToolExecutionPolicy('glob') | 不变，返回 'auto-approve' |

### 集成测试路径

```
CLI 启动 → 加载 MCP 配置 → 创建 McpClientManager → 
注入 ToolService → describeTools() 包含 MCP 工具 →
LLM 返回 toolCall.toolName = 'mcp__server__tool' →
normalizeProviderToolName 放行 →
parseProviderToolArgs 返回 mcp_tool 类型 →
getToolExecutionPolicy 返回 auto-approve →
ToolService.executeTool() 分发到 mcpClientManager.executeTool() →
MCP 工具执行成功 → 结果写入 ToolInvocationRepository
```

---

## 失败回滚方案

每项修复独立可逆：

1. **修复 1**：回退 `src/cli/index.ts` 中 `mcpClientManager` 的移除及相关 import
2. **修复 2**：回退 `normalizeProviderToolName()` 中 `mcp__` 前缀检查
3. **修复 3**：回退 `parseProviderToolArgs()` 中 `mcp__` 分支和 `ToolArgs` 类型新增
4. **修复 4**：回退 `getToolExecutionPolicy()` 中 MCP 策略逻辑及 CLI 回调

---

## 补充注意事项

1. **MCP 工具名格式约定**：统一使用 `mcp__<serverName>__<toolName>` 的命名空间分隔符（双下划线），与现有 `glob`, `grep` 等内置工具名的下划线风格一致。
2. **MCP ClientManager 配置加载**：推荐优先级：命令行参数 > 项目本地配置 (`.pueblo/mcp.json`) > 用户全局配置 (`~/.pueblo/mcp.json`) > 环境变量。
3. **审批安全**：对于可能修改文件系统的 MCP 工具，建议在 McpClientManager 中提供 `getToolMetadata(serverName, toolName)` 方法返回工具的能力标签（read/write/exec），供 `getToolExecutionPolicy()` 参考其危险性。
4. **向后兼容**：所有修复均要求在不配置 MCP 的情况下，现有内置工具行为完全不变。
