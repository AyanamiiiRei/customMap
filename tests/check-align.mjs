#!/usr/bin/env node
// check-align.mjs — 栅格 relief 与矢量 OSM 水系对齐校验
// 方法：以泸沽湖中心 (100.78, 27.72) 为基准点（WorldCover 实测 class=80 永久水体）：
//   1. osm.pmtiles 在该点应有 water 面要素（矢量水系存在）
//   2. relief.pmtiles 在该点像素应偏蓝（B > R + 15，经晕渲/降饱和后仍成立）
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { serveDir } from './serve.mjs';

const LAKES = [
  ['泸沽湖', 100.78, 27.72],
  ['纳帕海', 99.64, 27.88],
];

const { server, base } = await serveDir('public/data');
const osm = new PMTiles(`${base}/osm.pmtiles`);
const relief = new PMTiles(`${base}/relief.pmtiles`);

function lonlat2tile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}

// 点在 MVT 面要素内（射线法，tile 坐标系）
function pointInPoly(px, py, rings, extent) {
  const x = px * extent, y = py * extent;
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

let fail = 0;
for (const [name, lon, lat] of LAKES) {
  // 1) 矢量侧
  let vecOk = false;
  const z = 12;
  const t = lonlat2tile(lon, lat, z);
  const tile = await osm.getZxy(z, t.x, t.y);
  if (tile) {
    let data = Buffer.from(tile.data);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const vt = new VectorTile(new Protobuf(data));
    const water = vt.layers['water'];
    if (water) {
      for (let i = 0; i < water.length; i++) {
        const f = water.feature(i);
        if (f.type !== 3) continue;
        if (pointInPoly(t.fx, t.fy, f.loadGeometry(), f.extent)) { vecOk = true; break; }
      }
    }
  }
  // 2) 栅格侧
  const rh = await relief.getHeader();
  const rz = Math.min(13, rh.maxZoom);
  const rt2 = lonlat2tile(lon, lat, rz);
  const rtile = await relief.getZxy(rz, rt2.x, rt2.y);
  let rasterOk = false, rgb = null;
  if (rtile) {
    let rd = Buffer.from(rtile.data);
    if (rd[0] === 0x1f && rd[1] === 0x8b) rd = zlib.gunzipSync(rd);
    const raw = execFileSync('tools/mambaenv/bin/python', ['tests/decode_tile.py'], { input: rd, maxBuffer: 1 << 24 });
    const px = Math.min(255, Math.floor(rt2.fx * 256)), py = Math.min(255, Math.floor(rt2.fy * 256));
    const idx = (py * 256 + px) * 3;
    rgb = [raw[idx], raw[idx + 1], raw[idx + 2]];
    rasterOk = rgb[2] > rgb[0] + 15; // 偏蓝即水
  }
  const ok = vecOk && rasterOk;
  console.log(`${ok ? '✓' : '✗'} ${name} [${lon},${lat}]: 矢量水面=${vecOk ? '有' : '无'} relief RGB=${rgb ? `(${rgb})` : 'N/A'} ${rasterOk ? '偏蓝' : '非水色'}`);
  if (!ok) fail = 1;
}
server.close();
process.exit(fail);
