import { chromium } from 'playwright';
const mode = process.argv[2] || 'default';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH,
  args: ['--disable-crash-reporter','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5271/#13/29.7/101.88');
await p.waitForFunction(() => window.__mapLoaded === true, undefined, { timeout: 150000 });
await p.waitForTimeout(11000);
// 用飞行目的地进入 3D 俯视（hash 不带 pitch）
await p.evaluate(() => window.__map.jumpTo({ center: [101.88, 29.7], zoom: 13, pitch: 62, bearing: 0 }));
await p.waitForTimeout(9000);
if (mode === 'unclamped') {
  await p.evaluate(() => window.__map.setCenterClampedToGround(false));
  await p.waitForTimeout(4000);
}
await p.evaluate(() => {
  window.__s = [];
  const t = window.__map._camera.transform;
  const tick = () => { window.__s.push(t.getCameraAltitude()); if (window.__s.length < 100000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await p.mouse.move(800, 450);
await p.mouse.down();
for (let i = 0; i < 24; i++) { await p.mouse.move(800 + i * 25, 450); await p.waitForTimeout(45); }
await p.mouse.up();
await p.waitForTimeout(600);
const res = await p.evaluate(() => {
  const s = window.__s.filter(v => Number.isFinite(v));
  let maxJump = 0, jumps = 0;
  for (let i = 1; i < s.length; i++) {
    const d = Math.abs(s[i] - s[i - 1]);
    if (d > maxJump) maxJump = d;
    if (d > 30) jumps++;
  }
  return { frames: s.length, min: Math.round(Math.min(...s)), max: Math.round(Math.max(...s)),
           maxJumpM: Math.round(maxJump), jumpsOver30m: jumps, clamped: window.__map.getCenterClampedToGround() };
});
console.log(JSON.stringify({ mode, ...res }));
await b.close();
