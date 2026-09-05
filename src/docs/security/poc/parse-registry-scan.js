// 解析 semgrep registry 扫描 JSON，输出关键命中信息（供 Phase 2 补跑记录）
// 用法：node parse-registry-scan.js <scan-json>
'use strict';
const fs = require('node:fs');
const file = process.argv[2] || './docs/security/report/scan-logs/semgrep-registry-2026-08-29.json';
const r = JSON.parse(fs.readFileSync(file, 'utf-8'));
console.log('=== SCAN META ===');
console.log('errors:', r.errors ? r.errors.length : 0);
console.log('results:', r.results.length);
for (const x of r.results) {
  console.log('---');
  console.log('rule :', x.check_id);
  console.log('sev  :', x.extra.severity);
  console.log('path :', x.path + ':' + x.start.line + '-' + x.end.line);
  console.log('msg  :', (x.extra.message || '').replace(/\s+/g, ' ').slice(0, 400));
  console.log('lines:', JSON.stringify(x.extra.lines || '').slice(0, 250));
}
