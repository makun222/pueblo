import { describe, it, expect } from 'vitest';
import {
  normalizeProviderToolName,
  parseProviderToolArgs,
  getToolExecutionPolicy,
} from '../../src/providers/provider-adapter';

// ============================================================
// Fix 2: normalizeProviderToolName 放行 mcp__ 前缀
// ============================================================
describe('normalizeProviderToolName', () => {
  it('should pass through mcp__ prefixed names unchanged', () => {
    expect(normalizeProviderToolName('mcp__filesystem__list_directory')).toBe('mcp__filesystem__list_directory');
    expect(normalizeProviderToolName('mcp__server__tool_name')).toBe('mcp__server__tool_name');
  });

  it('should still normalize built-in tool names', () => {
    expect(normalizeProviderToolName('glob')).toBe('glob');
    expect(normalizeProviderToolName('grep')).toBe('grep');
    expect(normalizeProviderToolName('read')).toBe('read');
    expect(normalizeProviderToolName('write')).toBe('write');
    expect(normalizeProviderToolName('edit')).toBe('edit');
  });

  it('should return undefined for unknown non-mcp names', () => {
    expect(normalizeProviderToolName('unknown_tool')).toBeUndefined();
  });
});

// ============================================================
// Fix 3: parseProviderToolArgs �?mcp__ 工具不抛异常
// ============================================================
describe('parseProviderToolArgs', () => {
  it('should pass through args for mcp__ prefixed tools without throwing', () => {
    const args = { path: '/test', recursive: true };
    const result = parseProviderToolArgs('mcp__filesystem__list_directory', args);
    expect(result).toEqual(args);
  });

  it('should pass through complex args for mcp__ tools', () => {
    const args = { uri: 'file:///test', options: { includeHidden: true } };
    const result = parseProviderToolArgs('mcp__server__read_file', args);
    expect(result).toEqual(args);
  });

  it('should still parse built-in tool args correctly', () => {
    const result = parseProviderToolArgs('read', { path: 'test.txt' });
    expect(result).toBeDefined();
  });
});

// ============================================================
// Fix 4: getToolExecutionPolicy �?mcp__ 工具返回 'free'
// ============================================================
describe('getToolExecutionPolicy', () => {
  it('should return "free" for mcp__ prefixed tool names', () => {
    expect(getToolExecutionPolicy('mcp__filesystem__list_directory')).toBe('free');
    expect(getToolExecutionPolicy('mcp__any__tool')).toBe('free');
  });

  it('should return "free" for built-in tools that are free', () => {
    expect(getToolExecutionPolicy('read')).toBe('free');
    expect(getToolExecutionPolicy('glob')).toBe('free');
    expect(getToolExecutionPolicy('grep')).toBe('free');
  });

  it('should return "approval-required" for write/edit type tools', () => {
    expect(getToolExecutionPolicy('write')).toBe('approval-required');
    expect(getToolExecutionPolicy('edit')).toBe('approval-required');
    expect(getToolExecutionPolicy('exec')).toBe('approval-required');
    expect(getToolExecutionPolicy('shell_exec')).toBe('approval-required');
  });
});
