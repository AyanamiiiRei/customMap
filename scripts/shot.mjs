#!/usr/bin/env node
// shot.mjs — headless 截图（SwiftShader 软件渲染 WebGL2）
// 用法: node scripts/shot.mjs <url-hash> <out.png> [waitMs]
// 例:  node scripts/shot.mjs '#4.2/31/101.8' shots/01-globe.png
import { chromium } from 'playwright';

import { homedir } from 'os';
import { join } from 'path';

const [, , hash = '', out = 'shots/shot.png', waitMs = '6000'] = process.argv;

// headless shell 可能未下载，回退到完整 chromium 二进制
const exe = process.env.CHROME_PATH ||
  join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const base = process.env.BASE_URL || 'http://localhost:5271';
await page.goto(`${base}/${hash}`);
await page.waitForFunction(() => window.__mapLoaded === true, undefined, { timeout: 120000 });
// 等瓦片+地形稳定：先等 idle，再补固定等待（地形瓦片解码可能晚于 idle）
try {
  await page.waitForFunction(() => window.__mapIdle === true, undefined, { timeout: 60000 });
} catch { /* 超时也截图，别卡死 */ }
await page.waitForTimeout(Number(waitMs));
// 可选交互：drawer=打开图层抽屉, no-terrain=按T关地形
const act = process.argv[5] || '';
if (act === 'drawer') {
  await page.click('#drawerToggle');
  await page.waitForTimeout(600);
} else if (act === 'no-terrain') {
  await page.keyboard.press('t');
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: out });
await browser.close();

if (errors.length) {
  console.log('console errors:');
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log('  ' + e));
}
console.log(`saved: ${out}`);
