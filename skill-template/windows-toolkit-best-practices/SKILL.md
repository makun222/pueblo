---
name: windows-toolkit-best-practices
description: **目的**：在 Windows 环境下使用 glob/read/grep/exec 工具链进行代码操作时，避免常见的路径、编码、命令陷阱。
---

# Windows Toolkit Best Practices

## 核心原则

在 Windows 环境下执行文件操作和命令时，必须遵循以下规则以避免常见陷阱。

## 路径规则

### 1. glob 模式必须使用 `**/` 前缀

❌ 错误:
```
glob(pattern="src/*.ts")
```

✅ 正确:
```
glob(pattern="**/src/*.ts")
```

### 2. grep include 参数同样需要 `**/` 前缀

❌ 错误:
```
grep(pattern="console.error", include="src/**/*.ts")
```

✅ 正确:
```
grep(pattern="console.error", include="**/src/**/*.ts")
```

### 3. 路径分隔符统一使用正斜杠 `/`

即使在 Windows 下，工具链内部也统一使用 `/` 作为路径分隔符。

## 命令执行规则

### 1. 优先使用 exec 而非 shell_exec

- `exec` 直接执行可执行文件，避免 shell 解析问题
- 仅在需要管道、重定向、内置命令时使用 `shell_exec`

### 2. Node.js 和 npm 使用完整路径

不要假设 `node` 或 `npm` 在 PATH 中：

```
exec(command="D:\\Tools\\nodejs\\node.exe", ...)
exec(command="D:\\Tools\\nodejs\\npm.cmd", ...)
```

### 3. TypeScript 编译

使用项目中的 `node_modules/.bin/tsc` 或 npx：

```
exec(command="node_modules\\.bin\\tsc.cmd", ...)
```

### 4. PowerShell vs CMD

- `shell_exec(mode="powershell")`: 用于复杂脚本、管道操作
- `shell_exec(mode="cmd")`: 用于简单的 dir/del 等命令
- PowerShell 中注意转义：反引号 `` ` `` 而非反斜杠 `\`

## 编码规则

### 1. 读取文件始终使用 UTF-8

所有 `read` 操作默认使用 UTF-8，这是工具链的默认行为。

### 2. 写入文件使用 LF 行尾

确保写入的文件使用 LF（Unix 风格）行尾，而非 CRLF。

## 常见陷阱速查

| 陷阱 | 错误 | 正确 |
|------|------|------|
| glob 无结果 | `glob("src/*.ts")` | `glob("**/src/*.ts")` |
| grep 无结果 | `include="src/**"` | `include="**/src/**"` |
| npm 找不到 | `shell_exec("npm ...")` | `exec("D:\\Tools\\nodejs\\npm.cmd ...")` |
| 路径反斜杠 | `path\\to\\file` | `path/to/file` |
| PowerShell 转义 | `"hello\nworld"` | `"hello``nworld"` |
