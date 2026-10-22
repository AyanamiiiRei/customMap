#!/usr/bin/env node
// check-search.mjs — 校验搜索索引的结构、覆盖范围与抽查命中
import { readFileSync } from 'node:fs';

const FILE = 'public/data/search.json';
const BBOX = [96.0, 24.6, 105.0, 35.0];
let fail = 0;

const err = (msg) => { console.error(`  ✗ ${msg}`); fail = 1; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch {
  console.error(`✗ 缺少 ${FILE}`);
  process.exit(1);
}

const d = JSON.parse(raw);
const names = d.names ?? [];
const recs = d.recs ?? [];
const types = d.types ?? [];

if (d.v !== 1) err(`version 应为 1，实际 ${d.v}`);
const mb = Buffer.byteLength(raw) / 1048576;
if (mb > 5.0) err(`体积 ${mb.toFixed(2)} MB 超过 5 MB 上限`);
if (recs.length < 5000) err(`条目只有 ${recs.length}，预期 > 5000`);
else ok(`条目 ${recs.length.toLocaleString()}，名称 ${names.length.toLocaleString()}，${mb.toFixed(2)} MB`);

// 坐标与索引完整性
let outOfBounds = 0;
let badIdx = 0;
for (const r of recs) {
  if (r.length < 5) { badIdx++; continue; }
  const [lon, lat, t, , ni] = r;
  if (lon < BBOX[0] || lon > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) outOfBounds++;
  if (t < 0 || t >= types.length || ni < 0 || ni >= names.length) badIdx++;
}
if (badIdx) err(`有 ${badIdx} 条记录的 type/name 索引越界`);
else ok('type / name 索引全部有效');
if (outOfBounds) err(`有 ${outOfBounds} 条记录落在 bbox 外`);
else ok(`全部坐标落在 [${BBOX.join(', ')}] 内`);

// 名称不能为空、不能重复占位
const empty = names.filter((n) => !n || !String(n).trim()).length;
if (empty) err(`有 ${empty} 个空名称`);

// 拼音字段要么整体存在且等长，要么整体缺省
if (d.py) {
  if (d.py.length !== names.length || d.pyi.length !== names.length) err('py / pyi 长度与 names 不一致');
  else ok('拼音字段完整');
} else {
  console.log('  · 无拼音字段（pypinyin 未安装时可接受）');
}

// 抽查：名称 → 期望类型 + 坐标误差
const EXPECT = [
  ['贡嘎山', 'peak', 101.88, 29.6],
  ['幺妹峰', 'peak', 102.9, 31.1],
  ['稻城县', 'city', 100.3, 29.04],
  ['泸沽湖', 'lake', 100.79, 27.71],
  ['武侯祠', 'worship', 104.05, 30.65],
  ['色达喇荣五明佛学院', 'worship', 100.47, 32.15],
  ['毕棚沟', 'reserve', 102.92, 31.31],
  ['九寨沟风景名胜区', 'attraction', 103.92, 33.27],
  ['甘孜格萨尔机场', 'airport', 99.55, 31.76],
  ['羌人谷滑雪场', 'ski', 103.5, 31.68],
];
for (const [name, type, lon, lat] of EXPECT) {
  const idx = names.indexOf(name);
  if (idx < 0) { err(`索引里找不到「${name}」`); continue; }
  const rec = recs.find((r) => r[4] === idx);
  if (!rec) { err(`「${name}」没有对应记录`); continue; }
  const gotType = types[rec[2]];
  const dLon = Math.abs(rec[0] - lon);
  const dLat = Math.abs(rec[1] - lat);
  if (gotType !== type) err(`「${name}」类型为 ${gotType}，期望 ${type}`);
  else if (dLon > 0.05 || dLat > 0.05) err(`「${name}」坐标偏差 ${dLon.toFixed(3)}/${dLat.toFixed(3)}°`);
  else ok(`${name} → ${gotType} (${rec[0]}, ${rec[1]})`);
}

process.exit(fail);
