# MCP 工具被拒绝执行 — 根因分析及修复设计

## 概述

在 CLI 模式下，Agent 可以「看到」MCP 工具的名称和描述，但实际调用时总是被拒绝（denied）。本文档定位了从工具定义注册 → LLM 上下文构建 → 工具调用参数解析 → 执行审批链路的完整根因，并提出 4 项相互独立的修复。

---

## 阻塞点 1：`ToolService` 缺少 `mcpClientManager` 注入

### 根因

`src/cli/index.ts` 创建 `ToolService` 实例时未传入 `mcpClientManager`：

```typescript
// 当前代码（~第384行）
const toolService = new ToolService({
  repository: toolInvocationRepository,
  cwd: () => currentWorkspace,
  resolveEditReviewHandler: () => fileReviewHandler,
  editShadowRoot: () => path.resolve(currentWorkspace, '.pueblo', 'shadow-edits'),
  memoRecallTool,
  // ❌ mcpClientManager: mcpClientManager — 缺失！
});
```

`ToolService` 构造函数中接收 `McpClientManager` 实例（类型定义见 `src/tools/tool-service.ts:41-70` 的 `ToolServiceDependencies` 接口），当 `mcpClientManager` 为 `undefined` 时：

```typescript
// src/tools/tool-service.ts:~200
this.mcpClientManager?.getAllTools() ?? []
```

返回空数组。导致 `describeTools()` 向 LLM 上下文中没有注入任何 MCP 工具定义 → LLM 无法感知 MCP 工具。

### 影响范围

- `ToolServiceDependencies` 接口（`src/tools/tool-service.ts`）
- `ToolService` 构造函数
- `describeTools()` 方法 — join 内置工具 + MCP 工具时产出的列表
- `executeTool()` 方法 — 需要根据 toolName 前缀分发到 MCP 执行路径
- `src/cli/index.ts` — ToolService 实例化处

### 修复方案

**A. 修改 `src/cli/index.ts` — 注入 `mcpClientManager`：**

```typescript
import { McpClientManager } from '../mcp/mcp-client.js';

// 在 ToolService 创建前初始化 McpClientManager
const mcpClientManager = new McpClientManager({
  // 配置来源:
  // 1. 命令行参数 --mcp-servers
  // 2. 配置文件 $CWD/.pueblo/mcp.json / ~/.pueblo/mcp.json
  // 3. 环境变量 PUEBLO_MCP_SERVERS
});

// 注入到 ToolService
const toolService = new ToolService({
  repository: toolInvocationRepository,
  cwd: () => currentWorkspace,
  resolveEditReviewHandler: () => fileReviewHandler,
  editShadowRoot: () => path.resolve(currentWorkspace, '.pueblo', 'shadow-edits'),
  memoRecallTool,
  mcpClientManager,  // ✅ 新增注入
});
```

**B. 修改 `ToolService.executeTool()` — 添加 MCP 执行分支：**

```typescript
// src/tools/tool-service.ts 现有 executeTool(call, sessionId)
async executeTool(call: ToolCall, sessionId: string): Promise<ToolResult> {
  // 1. 检查是否为 MCP 工具（toolName 格式: mcp__serverName__toolName）
  if (call.toolName.startsWith('mcp__')) {
    // 从名称中提取 serverName 和 toolName
    const parts = call.toolName.split('__');
    if (parts.length !== 3) {
      return { type: 'error', error: `Invalid MCP tool name format: ${call.toolName}` };
    }
    const [, serverName, mcpToolName] = parts;
    
    if (!this.mcpClientManager) {
      return { type: 'error', error: 'MCP client manager not available' };
    }
    
    return await this.mcpClientManager.executeTool(serverName, mcpToolName, call.args);
  }
  
  // 2. 原有内置工具执行逻辑
  // ... existing switch/case logic for built-in tools
}
```

---

## 阻塞点 2：`normalizeProviderToolName()` 剔除 MCP 工具名

### 根因

`src/providers/provider-adapter.ts` 中的 `normalizeProviderToolName()` 函数仅允许预定义的内置工具名，遇到未知名称（如 `mcp__serverName__toolName`）返回 `undefined`。

当前代码模式（推理自调用方上下文，实际函数名需确认）：

```typescript
function normalizeProviderToolName(toolName: string): string | undefined {
  const normalizedValue = toolName.toLowerCase().replace(/-/g, '_');
  switch (normalizedValue) {
    case 'glob': case 'grep': case 'exec': case 'shell_exec':
    case 'read': case 'edit': case 'write': case 'memo_recall':
      return normalizedValue;
    default:
      return undefined;   // ← MCP 工具名（mcp__xxx__yyy）落至此分支
  }
}
```

### 影响范围

- `normalizeProviderToolName()`（`src/providers/provider-adapter.ts`）
- 调用方：provider-adapter.ts 中响应解析 LLM 返回的 toolCall 时的名称归一化位置
- `parseProviderToolArgs()` — 因 toolName 已被转为 `undefined` 而进入错误路径

### 修复方案

**允许 MCP 合格名称通过：**

```typescript
function normalizeProviderToolName(toolName: string): string | undefined {
  const normalizedValue = toolName.toLowerCase().replace(/-/g, '_');
  
  // ✅ MCP 工具的命名约定：mcp__<serverName>__<toolName>
  if (normalizedValue.startsWith('mcp__')) {
    return normalizedValue;
  }
  
  switch (normalizedValue) {
    case 'glob': case 'grep': case 'exec': case 'shell_exec':
    case 'read': case 'edit': case 'write': case 'memo_recall':
      return normalizedValue;
    default:
      return undefined;
  }
}
```

此变更确保 MCP 工具的合格名称可在后序的 `parseProviderToolArgs()` 和 `getToolExecutionPolicy()` 中正确传递。

---

## 阻塞点 3：`parseProviderToolArgs()` 对非内置工具名抛出异常

### 根因

`src/providers/provider-adapter.ts` 中的参数解析函数仅识别内置工具的参数格式，遇到 MCP 工具名直接抛异常：

```typescript
function parseProviderToolArgs(toolName: string, args: unknown): ToolArgs {
  // 现有 switch/case 处理各内置工具的参数解析
  switch (toolName) {
    case 'glob':   return { ... };
    case 'grep':   return { ... };
    case 'exec':   // 需要 shell: boolean 等
    // ... 其他内置工具
    default:
      throw new ProviderError(`Unsupported tool: ${String(toolName)}`);
  }
}
```

MCP 工具的 `mcp__serverName__toolName` 名称落至 `default` 分支 → 抛出异常 → 调用链中断。

### 影响范围

- `parseProviderToolArgs()`（或等价函数，`src/providers/provider-adapter.ts` 约 605 行）
- 调用方：task-runner.ts 中处理 LLM 返回的 toolCall 时的参数解析环节
- 下游：`ToolService.executeTool()` 无法收到有效参数

### 修复方案

**为 MCP 工具添加宽松的参数传递通道：**

```typescript
function parseProviderToolArgs(toolName: string, args: unknown): ToolArgs {
  // ✅ MCP 工具：透传原始 args，不进行强类型校验
  if (toolName.startsWith('mcp__')) {
    return { type: 'mcp_tool', toolName, args: args as Record<string, unknown> };
  }
  
  switch (toolName) {
    case 'glob': return { type: 'glob', pattern: parseStringArg(args, 'pattern') };
    // ... 其他内置工具
    default:
      throw new ProviderError(`Unsupported tool: ${String(toolName)}`);
  }
}
```

**对应的 `ToolArgs` 联合类型需要扩展（`src/providers/provider-adapter.ts` 类型定义处）：**

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
