import { chromium } from 'playwright';
try {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH,
    args: ['--disable-crash-reporter','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
  const bad = [];
  p.on('pageerror', e => bad.push(String(e).slice(0,150)));
  await p.goto('http://localhost:5271/#10/25.75/100.15');
  await p.waitForFunction(() => window.__mapLoaded === true, undefined, { timeout: 180000 });
  console.log('loaded ok');
  await p.waitForTimeout(8000);
  await b.close();
} catch (e) {
  console.log('ERR:', String(e).slice(0, 400));
}
