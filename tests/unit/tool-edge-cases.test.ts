/**
 * Pueblo 内置工具「能力边界」测试
 *
 * 目的：验证 2026-08-26 完善后的 file-guard / read / glob / grep 工具，
 *       以及此前修复过的 write / edit 工具在极限输入下的行为是否可预期、不崩溃。
 *
 * 每个用例注释标注了「预期能力」或「记录现状」：
 *  - 预期能力：实现应满足的边界契约（如：恰好等于阈值应放行）。
 *  - 记录现状：当前实现的已知边界行为（如：二进制探测盲区），
 *    防止后续改动无意中改变行为而无人察觉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkFileReadable } from '../../src/tools/file-guard';
import { createGlobTool } from '../../src/tools/glob-tool';
import { createGrepTool } from '../../src/tools/grep-tool';
import { createReadTool } from '../../src/tools/read-tool';
import { createWriteTool } from '../../src/tools/write-tool';
import { createEditTool } from '../../src/tools/edit-tool';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pueblo-edge-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('file-guard 三道闸门边界', () => {
  it('大小恰好等于阈值时放行（> 才拒绝）', () => {
    const dir = makeTempDir('size-eq');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, Buffer.alloc(1024, 0x61)); // 1KB

    const result = checkFileReadable(file, 1024);
    expect(result.ok).toBe(true);
  });

  it('大小超过阈值 1 字节时被拒（too-large）', () => {
    const dir = makeTempDir('size-over');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, Buffer.alloc(1025, 0x61));

    const result = checkFileReadable(file, 1024);
    expect(result).toEqual({ ok: false, reason: 'too-large', detail: '1025 bytes' });
  });

  it('空文件（0 字节）放行', () => {
    const dir = makeTempDir('empty');
    const file = path.join(dir, 'empty.txt');
    fs.writeFileSync(file, '');

    expect(checkFileReadable(file).ok).toBe(true);
  });

  it('目录路径被拒（not-a-file）', () => {
    const dir = makeTempDir('is-dir');
    expect(checkFileReadable(dir)).toEqual({ ok: false, reason: 'not-a-file' });
  });

  it('不存在的路径被拒（not-found）', () => {
    const dir = makeTempDir('missing');
    expect(checkFileReadable(path.join(dir, 'nope.txt'))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('扩展名黑名单大小写不敏感：.PNG 大写也被拒', () => {
    const dir = makeTempDir('ext-case');
    const file = path.join(dir, 'image.PNG');
    fs.writeFileSync(file, 'not-a-real-png');

    const result = checkFileReadable(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable-extension');
    expect(result.detail).toBe('.png');
  });

  it('NUL 字节出现在 8KB 探测窗口内 → binary-content', () => {
    const dir = makeTempDir('nul-head');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.alloc(100, 0x61)]));

    const result = checkFileReadable(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binary-content');
  });

  it('记录现状：NUL 字节出现在 8KB 窗口之后（9KB 处）→ 探测盲区，被放行', () => {
    const dir = makeTempDir('nul-tail');
    const file = path.join(dir, 'a.txt');
    const buf = Buffer.alloc(9 * 1024, 0x61);
    buf[9 * 1024 - 1] = 0;
    fs.writeFileSync(file, buf);

    const result = checkFileReadable(file);
    expect(result.ok).toBe(true); // 盲区：8KB 之后的内容不参与探测
  });

  it('黑名单外扩展名（.env）放行', () => {
    const dir = makeTempDir('env');
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'KEY=value');

    expect(checkFileReadable(file).ok).toBe(true);
  });
});

describe('read-tool 能力边界', () => {
  it('空路径 → failed（Path is required）', async () => {
    const dir = makeTempDir('empty-path');
    const tool = createReadTool();
    const result = await tool({ cwd: dir, path: '   ' });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Path is required');
  });

  it('路径越界（../）→ failed（must stay within the workspace root）', async () => {
    const dir = makeTempDir('escape');
    const tool = createReadTool();
    const result = await tool({ cwd: dir, path: '../outside.txt' });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('workspace root');
  });

  it('记录现状：request.path 会被 trim，无法读取以空格开头的文件名', async () => {
    const dir = makeTempDir('space-name');
    fs.writeFileSync(path.join(dir, ' lead.txt'), 'hello');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: ' lead.txt' });
    expect(result.status).toBe('failed'); // trim 后指向 lead.txt，不存在
  });

  it('记录现状：空文件被 split 为 1 行，返回 1 行空行', async () => {
    const dir = makeTempDir('read-empty');
    const file = path.join(dir, 'empty.txt');
    fs.writeFileSync(file, '');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'empty.txt' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(['1: ']); // 行号格式固定为 "N: "（含尾随空格）
    expect(result.totalLines).toBe(1);
  });

  it('无末尾换行：最后一行正常返回', async () => {
    const dir = makeTempDir('no-eol');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt' });
    expect(result.output).toEqual(['1: a', '2: b', '3: c']);
    expect(result.totalLines).toBe(3);
  });

  it('CRLF 文件：行内容不含 \\r，行号正确', async () => {
    const dir = makeTempDir('crlf');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\r\nb\r\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt' });
    expect(result.output).toEqual(['1: a', '2: b', '3: c']);
  });

  it('startLine > endLine → failed', async () => {
    const dir = makeTempDir('range-inv');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt', startLine: 3, endLine: 1 });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('startLine must be less than or equal to endLine');
  });

  it('startLine 超出文件行数 → empty（不崩溃）', async () => {
    const dir = makeTempDir('start-oob');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt', startLine: 100 });
    expect(result.status).toBe('empty');
    expect(result.output).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('endLine 超出文件行数 → 截断到 EOF', async () => {
    const dir = makeTempDir('end-oob');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt', endLine: 999 });
    expect(result.status).toBe('succeeded');
    expect(result.output).toHaveLength(3);
  });

  it('单行超 MAX_READ_CHARS（40000）：至少完整返回该超限行（不丢内容）', async () => {
    const dir = makeTempDir('long-line');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(45000), 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toBe(`1: ${'x'.repeat(45000)}`); // 超限但完整
  });

  it('多行累计超字符预算 → 截断 + hasMore + nextStartLine 正确', async () => {
    const dir = makeTempDir('char-budget');
    fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 6 }, () => 'a'.repeat(10000)).join('\n'), 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt' });
    expect(result.output).toHaveLength(3); // 第 4 行累计超过 40000，截断
    expect(result.hasMore).toBe(true);
    expect(result.nextStartLine).toBe(4);
  });

  it('limit=2 时只返回前 2 行', async () => {
    const dir = makeTempDir('limit');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc\nd\ne', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt', limit: 2 });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(['1: a', '2: b']);
    expect(result.hasMore).toBe(true);
    expect(result.nextStartLine).toBe(3);
  });

  it('记录现状：startLine=0 与未提供等价（从第 1 行开始）', async () => {
    const dir = makeTempDir('zero-line');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createReadTool();

    const result = await tool({ cwd: dir, path: 'a.txt', startLine: 0, endLine: 2 });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(['1: a', '2: b']);
  });
});

describe('glob-tool 能力边界', () => {
  it('空 pattern → empty（不崩溃）', async () => {
    const dir = makeTempDir('empty-pattern');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '' });
    expect(result.status).toBe('empty');
  });

  it('特殊字符文件名（空格/#/[]/中文）均可匹配', async () => {
    const dir = makeTempDir('special');
    for (const name of ['a b.txt', '#tag.md', '[x].txt', '中文文件.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '*' });
    expect(result.status).toBe('succeeded');
    for (const name of ['a b.txt', '#tag.md', '[x].txt', '中文文件.txt']) {
      expect(result.output).toContain(name);
    }
  });

  it('dotfile 可匹配（dot:true）', async () => {
    const dir = makeTempDir('dot');
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '*' });
    expect(result.output).toContain('.hidden');
  });

  it('目录也参与匹配', async () => {
    const dir = makeTempDir('dir-match');
    fs.mkdirSync(path.join(dir, 'subdir'));
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '*' });
    expect(result.output).toContain('subdir');
  });

  it('node_modules / dist / .git 被跳过', async () => {
    const dir = makeTempDir('skip-dirs');
    for (const sub of ['node_modules', 'dist', '.git']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      fs.writeFileSync(path.join(dir, sub, 'file.txt'), 'x');
    }
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '**/*.txt' });
    expect(result.status).toBe('empty');
    expect(result.output).toEqual([]);
  });

  it('预期能力：结果达 500 条上限后，summary 提示 "of N+"（不再丢失截断信息）', async () => {
    const dir = makeTempDir('glob-600');
    for (let i = 0; i < 600; i += 1) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    }
    const tool = createGlobTool();

    const result = await tool({ cwd: dir, pattern: '*.txt' });
    expect(result.output).toHaveLength(500);
    expect(result.summary).toBe('Matched 500 of 500+ path(s)'); // "+" 提示结果被截断
  });
});

describe('grep-tool 能力边界', () => {
  it('非法正则（未闭合括号）→ failed 不崩溃', async () => {
    const dir = makeTempDir('bad-regex');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world');
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: '(' });
    expect(result.status).toBe('failed');
  });

  it('空 pattern → 匹配所有行（500 截断）', async () => {
    const dir = makeTempDir('empty-regex');
    fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 3 }, () => 'x').join('\n'));
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: '' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toHaveLength(3);
  });

  it('预期能力：恰好 500 条匹配时，第 500 条正常输出且 summary 带 "+" 截断提示', async () => {
    const dir = makeTempDir('grep-500');
    fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 500 }, () => 'x').join('\n'));
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: 'x' });
    expect(result.output).toHaveLength(500); // 修复 off-by-one：第 500 条也被 push
    expect(result.summary).toContain('Matched 500 of 500+ line(s)');
  });

  it('超长匹配行（>40000 字符）：至少输出该行', async () => {
    const dir = makeTempDir('grep-long');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'needle' + 'x'.repeat(45000));
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: 'needle' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toHaveLength(1);
    expect(result.output[0].length).toBeGreaterThan(40000);
  });

  it('include 过滤按 matchBase 匹配（*.ts 命中深层目录）', async () => {
    const dir = makeTempDir('include');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), 'target');
    fs.writeFileSync(path.join(dir, 'a.js'), 'target');
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: 'target', include: '*.ts' });
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toContain('a.ts');
  });

  it('二进制文件（NUL 开头）被 file-guard 跳过', async () => {
    const dir = makeTempDir('grep-bin');
    fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.from([0, 1, 2, 3, 0x61]));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'plain');
    const tool = createGrepTool();

    const result = await tool({ cwd: dir, pattern: '.' });
    expect(result.output.some((line) => line.includes('a.txt'))).toBe(false);
    expect(result.output.some((line) => line.includes('b.txt'))).toBe(true);
  });
});

describe('write-tool 能力边界', () => {
  it('空字符串 → 成功写入空文件', async () => {
    const dir = makeTempDir('write-empty');
    const tool = createWriteTool();

    const result = await tool({ cwd: dir, path: 'empty.txt', text: '' });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'empty.txt'), 'utf8')).toBe('');
  });

  it('含 </parameter> 等标签内容原样写入（回归：不泄漏到面板）', async () => {
    const dir = makeTempDir('write-tag');
    const tool = createWriteTool();
    const content = 'a</parameter>b<foo>c</invoke>';

    const result = await tool({ cwd: dir, path: 'a.txt', text: content });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(content);
  });

  it('中文 / emoji 内容原样写入', async () => {
    const dir = makeTempDir('write-utf8');
    const tool = createWriteTool();
    const content = '你好，世界 🚀 测试';

    const result = await tool({ cwd: dir, path: 'a.txt', text: content });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(content);
  });

  it('嵌套目录自动创建', async () => {
    const dir = makeTempDir('write-nested');
    const tool = createWriteTool();

    const result = await tool({ cwd: dir, path: 'a/b/c/d.txt', text: 'deep' });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a/b/c/d.txt'), 'utf8')).toBe('deep');
  });

  it('覆盖已有文件', async () => {
    const dir = makeTempDir('write-overwrite');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
    const tool = createWriteTool();

    const result = await tool({ cwd: dir, path: 'a.txt', text: 'new' });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('new');
  });

  it('300KB 大内容写入成功', async () => {
    const dir = makeTempDir('write-big');
    const tool = createWriteTool();
    const content = 'line\n'.repeat(50000); // 约 250KB+

    const result = await tool({ cwd: dir, path: 'big.txt', text: content });
    expect(result.status).toBe('succeeded');
    expect(fs.statSync(path.join(dir, 'big.txt')).size).toBe(Buffer.byteLength(content, 'utf8'));
  });
});

describe('edit-tool 能力边界', () => {
  it('oldText 含正则特殊字符 → 按字面量匹配替换', async () => {
    const dir = makeTempDir('edit-regexp');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'const x = "[a-z].*";', 'utf8');
    const tool = createEditTool();

    const result = await tool({ cwd: dir, path: 'a.txt', oldText: '[a-z].*', newText: 'LITERAL' });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('const x = "LITERAL";');
  });

  it('多行 oldText 精确匹配替换', async () => {
    const dir = makeTempDir('edit-multiline');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc', 'utf8');
    const tool = createEditTool();

    const result = await tool({ cwd: dir, path: 'a.txt', oldText: 'a\nb', newText: 'AB' });
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('AB\nc');
  });
});
