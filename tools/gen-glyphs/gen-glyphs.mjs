#!/usr/bin/env node
// gen-glyphs.mjs <fontFile> <outDir> — 生成 0-255.pbf … 65280-65535.pbf
import fontnik from 'fontnik';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const [fontFile, outDir] = process.argv.slice(2);
if (!fontFile || !outDir) { console.error('usage: gen-glyphs.mjs <font> <outDir>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const font = await new Promise((resolve, reject) =>
  fontnik.load(readFileSync(fontFile), (err, res) => err ? reject(err) : resolve(res)));

for (let start = 0; start < 65536; start += 256) {
  const end = start + 255;
  const file = join(outDir, `${start}-${end}.pbf`);
  if (existsSync(file)) continue;
  const buf = await new Promise((resolve, reject) =>
    fontnik.range({ font, start, end }, (err, res) => err ? reject(err) : resolve(res)));
  writeFileSync(file, buf);
  if (start % 8192 === 0) console.log(`${start}-${end} done`);
}
console.log('all glyphs done');
