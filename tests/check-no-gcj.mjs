#!/usr/bin/env node
// check-no-gcj.mjs — 全仓 grep GCJ/BD09 纠偏关键词，命中即失败
import { execSync } from 'child_process';

const PATTERN = 'gcj|bd09|wgs84to';
let out = '';
try {
  out = execSync(
    `grep -rniE '${PATTERN}' --include='*.ts' --include='*.js' --include='*.mjs' --include='*.rs' --include='*.sh' --include='*.py' src pipeline rust tests scripts index.html 2>/dev/null | grep -v 'check-no-gcj' || true`,
    { encoding: 'utf8' });
} catch (e) { out = e.stdout || ''; }

// 白名单：本测试文件与文档中的说明性提及
const hits = out.split('\n').filter(l =>
  l.trim() && !l.includes('NOTES.md') && !l.includes('README.md') && !l.includes('AGENT_PROMPT.md'));

if (hits.length) {
  console.error('✗ 命中坐标纠偏关键词:');
  hits.forEach(h => console.error('  ' + h));
  process.exit(1);
}
console.log('✓ 无 GCJ/BD09 纠偏代码');
