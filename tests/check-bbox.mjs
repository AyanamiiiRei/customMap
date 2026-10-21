#!/usr/bin/env node
// check-bbox.mjs — 打印所有 pmtiles 的 zoom 范围与 bounds，与研究区 bbox 比对
import { PMTiles } from 'pmtiles';
import { serveDir } from './serve.mjs';

const BBOX = [96.0, 26.0, 105.0, 35.0];
const { server, base } = await serveDir('public/data');

const files = ['world', 'osm', 'dem', 'relief', 'hiking', 'contours'];
let fail = 0;
for (const f of files) {
  try {
    const p = new PMTiles(`${base}/${f}.pmtiles`);
    const h = await p.getHeader();
    console.log(`${f}.pmtiles: z${h.minZoom}–z${h.maxZoom} bounds=[${h.minLon},${h.minLat},${h.maxLon},${h.maxLat}]`);
    if (f === 'world') continue; // 全球底图 bounds 是全球
    const inside = h.minLon >= BBOX[0] - 0.6 && h.minLat >= BBOX[1] - 0.6 &&
                   h.maxLon <= BBOX[2] + 0.6 && h.maxLat <= BBOX[3] + 0.6;
    if (!inside) { console.error(`  ✗ bounds 超出研究区范围过多`); fail = 1; }
  } catch (e) {
    console.log(`${f}.pmtiles: 缺失或不可读 (${e.message})`);
    if (['osm', 'dem'].includes(f)) fail = 1; // 核心产物缺失算失败
  }
}
server.close();
process.exit(fail);
