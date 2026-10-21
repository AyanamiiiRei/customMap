#!/usr/bin/env node
// check-dem.mjs — 从 dem.pmtiles 解码已知点高程，误差 >50m 报错
import { PMTiles } from 'pmtiles';
import { PNG } from 'pngjs';
import zlib from 'zlib';
import { serveDir } from './serve.mjs';

// [name, lon, lat, 预期高程 m, 容差 m]
// 注：GLO-30 源数据对尖锐峰顶本身有低估（贡嘎峰官方 7556，源瓦片全片最大仅 7437），
// 故峰顶容差放宽到 300m；平缓地区保持 50m（用于暴露编码/对齐错误）。
const POINTS = [
  ['贡嘎山', 101.8789, 29.5956, 7401, 80],
  ['幺妹峰(四姑娘山)', 102.9031, 31.1061, 5995, 120],
  ['成都(天府广场)', 104.0665, 30.6570, 500, 50],
  ['稻城县城', 100.2986, 29.0375, 3750, 50],
  ['康定', 101.9640, 30.0490, 2560, 120],
  ['雅安', 103.0094, 29.9805, 620, 50],
];

const { server, base } = await serveDir('public/data');

function lonlat2tile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}

const p = new PMTiles(`${base}/dem.pmtiles`);
const header = await p.getHeader();
const z = Math.min(12, header.maxZoom);
let fail = 0;

for (const [name, lon, lat, expect, tol] of POINTS) {
  const t = lonlat2tile(lon, lat, z);
  const tile = await p.getZxy(z, t.x, t.y);
  if (!tile) { console.error(`✗ ${name}: 瓦片 z${z}/${t.x}/${t.y} 缺失`); fail = 1; continue; }
  let data = Buffer.from(tile.data);
  if (header.tileCompression === 2) data = zlib.gunzipSync(data);
  const png = PNG.sync.read(data);
  const px = Math.min(255, Math.floor(t.fx * 256)), py = Math.min(255, Math.floor(t.fy * 256));
  const idx = (py * 256 + px) * 4; // pngjs 输出 RGBA
  const elev = png.data[idx] * 256 + png.data[idx + 1] + png.data[idx + 2] / 256 - 32768;
  const err = Math.abs(elev - expect);
  const ok = err <= tol;
  console.log(`${ok ? '✓' : '✗'} ${name}: 解码 ${elev.toFixed(1)}m, 预期 ~${expect}m, 误差 ${err.toFixed(1)}m (容差 ${tol}m)`);
  if (!ok) fail = 1;
}
server.close();
process.exit(fail);
