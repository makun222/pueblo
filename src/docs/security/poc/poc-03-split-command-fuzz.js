// =============================================================================
// PoC-03 — exec-tool splitCommand 拆分器 fuzz（F-03 边界用例）
// 基线：b84227d9 ｜ 复刻目标：src/tools/exec-tool.ts:21-24（1:1 复制实现）
//   const matches = commandText.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
//   return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
// 运行：node poc-03-split-command-fuzz.js
// 方法：对自研拆分器与参考拆分器（POSIX-ish 状态机）做差分，列出偏差。
// =============================================================================

'use strict';

// —— 1:1 复刻目标实现（exec-tool.ts:21-24）——
function splitCommandTarget(commandText) {
  const matches = commandText.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

// —— 参考实现：POSIX-ish 状态机（支持转义引号、空参数、引号内空格）——
function splitCommandReference(commandText) {
  const out = [];
  let cur = '';
  let inQuote = null;
  let started = false;
  for (let i = 0; i < commandText.length; i++) {
    const c = commandText[i];
    if (inQuote) {
      if (c === '\\' && inQuote === '"' && commandText[i + 1] === '"') { cur += '"'; i++; }
      else if (c === inQuote) { inQuote = null; }
      else { cur += c; }
    } else if (c === '"' || c === "'") {
      inQuote = c; started = true;
    } else if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false; }
    } else {
      cur += c; started = true;
    }
  }
  if (started || inQuote) out.push(cur);
  return out;
}

const cases = [
  // [名称, 输入]
  ['空字符串', ''],
  ['纯空白', '   \t  '],
  ['单参数', 'echo'],
  ['多参数', 'echo hello world'],
  ['引号内空格', 'echo "hello world"'],
  ['单引号内空格', "echo 'hello world'"],
  ['空参数(双引号)', 'echo ""'],
  ['空参数(单引号)', "echo ''"],
  ['转义引号', 'echo "a\\"b"'],
  ['反斜杠字面', 'echo a\\b'],
  ['相邻引号拼接', 'echo "a""b"'],
  ['引号+裸词拼接', 'echo "a"b'],
  ['未闭合双引号', 'echo "abc'],
  ['未闭合单引号', "echo 'abc"],
  ['引号内特殊字符&', 'echo "a&b"'],
  ['引号内管道', 'echo "a|b"'],
  ['Windows路径含空格', 'echo "C:\\Program Files\\app.exe"'],
  ['嵌套引号混用', "echo \"a'b\""],
  ['制表符分隔', 'echo\thello'],
  ['多行', 'echo hello\nworld'],
  ['Unicode', 'echo 你好世界 😀'],
  ['分号命令分隔', 'echo a; echo b'],
  ['与符号', 'echo a & echo b'],
  ['反引号', 'echo `id`'],
  ['美元符', 'echo $HOME'],
  ['超长参数(10k)', 'echo ' + 'x'.repeat(10000)],
];

const deviations = [];
console.log('='.repeat(76));
console.log('PoC-03 结果汇总（F-03 splitCommand 边界 fuzz）');
console.log('='.repeat(76));

for (const [name, input] of cases) {
  const t = splitCommandTarget(input);
  const r = splitCommandReference(input);
  const diff = JSON.stringify(t) !== JSON.stringify(r);
  const note = diff ? '⚠ 偏差' : '  一致';
  if (diff) deviations.push({ name, input, target: t, reference: r });
  console.log(`${note} ${name.padEnd(18)} target=${JSON.stringify(t).slice(0, 90)}`);
  if (diff) console.log(`            reference=${JSON.stringify(r).slice(0, 90)}`);
}

console.log('\n-- 偏差明细（与参考拆分器的行为差异）--');
console.log(`共 ${deviations.length}/${cases.length} 个用例出现偏差：`);
for (const d of deviations) {
  console.log(`\n• ${d.name}  输入=${JSON.stringify(d.input)}`);
  console.log(`  目标实现: ${JSON.stringify(d.target)}`);
  console.log(`  参考实现: ${JSON.stringify(d.reference)}`);
}

console.log('\n-- 安全含义 --');
console.log('1. 空参数 "" 丢失：' + (JSON.stringify(splitCommandTarget('echo ""')) === JSON.stringify(['echo']) ? '确认丢失（参数数量与预期不符）' : '保留'));
console.log('2. 转义引号 "a\\"b" 错拆：' + (JSON.stringify(splitCommandTarget('echo "a\\"b"')) !== JSON.stringify(splitCommandReference('echo "a\\"b"')) ? '确认错拆（可致参数边界混淆）' : '一致'));
console.log('3. 未闭合引号：' + (JSON.stringify(splitCommandTarget('echo "abc')) !== JSON.stringify(splitCommandReference('echo "abc')) ? '确认与原意不一致' : '一致'));
console.log('4. 引号内 & | 保留为字面：' + (JSON.stringify(splitCommandTarget('echo "a&b"')) === JSON.stringify(['echo', 'a&b']) ? '正确（& 在引号内不拆分，但 shell:false 下 & 不会被执行）' : '异常'));
console.log('\n证据位置：src/tools/exec-tool.ts:21-24');
