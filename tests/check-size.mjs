#!/usr/bin/env node
// check-size.mjs — 数据总量检查：>2.5GB 警告（软目标），>5GB 失败（硬上限）
import { readdir, stat } from 'fs/promises';

const SOFT = 2.5 * 1024 ** 3;
const HARD = 5.0 * 1024 ** 3;
let total = 0;
try {
  for (const f of await readdir('public/data')) {
    total += (await stat(`public/data/${f}`)).size;
  }
} catch { /* 目录不存在 */ }
const gb = (total / 1024 ** 3).toFixed(2);
if (total > HARD) {
  console.error(`✗ public/data = ${gb} GB，超过 5 GB 硬上限`);
  process.exit(1);
} else if (total > SOFT) {
  console.log(`⚠ public/data = ${gb} GB，超 2.5 GB 软目标但在 5 GB 硬上限内（见 NOTES.md 体积节）`);
} else {
  console.log(`✓ public/data = ${gb} GB ≤ 2.5 GB`);
}
