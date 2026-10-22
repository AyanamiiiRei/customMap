#!/usr/bin/env node
// check-bbox.mjs — 打印所有 pmtiles 的 zoom 范围与 bounds，与研究区 bbox 比对
import { PMTiles } from 'pmtiles';
import { serveDir } from './serve.mjs';

const BBOX = [96.0, 24.6, 105.0, 35.0];
const { server, base } = await serveDir('public/data');

// world / dem / relief-world 是「全球」产物，其余是川西研究区产物
const files = ['world', 'osm', 'dem', 'relief', 'relief-world', 'hiking', 'contours'];
const GLOBAL = new Set(['world', 'dem', 'relief-world']);
let fail = 0;
for (const f of files) {
  try {
    const p = new PMTiles(`${base}/${f}.pmtiles`);
    const h = await p.getHeader();
    console.log(`${f}.pmtiles: z${h.minZoom}–z${h.maxZoom} bounds=[${h.minLon},${h.minLat},${h.maxLon},${h.maxLat}]`);
    if (GLOBAL.has(f)) {
      // 全球产物：必须覆盖研究区
      const covers = h.minLon <= BBOX[0] && h.minLat <= BBOX[1] &&
                     h.maxLon >= BBOX[2] && h.maxLat >= BBOX[3];
      if (!covers) { console.error(`  ✗ 全球产物没有覆盖研究区`); fail = 1; }
      continue;
    }
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
