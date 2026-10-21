#!/usr/bin/env node
// prod-server.mjs — 生产静态服务器（支持 Range，PMTiles 必需）
// 路由: /assets|/vite 等构建产物 → dist/；/data /fonts → public/ 下的大目录（符号链接不可靠，直接映射）
import { createServer } from 'http';
import { stat, createReadStream } from 'fs';
import { join, extname, resolve } from 'path';

const PORT = Number(process.env.PORT || 5272);
const ROOT = resolve('.');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function resolvePath(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  if (p === '/' || p === '/index.html') return join(ROOT, 'dist/index.html');
  if (p.startsWith('/data/')) return join(ROOT, 'public', p);
  if (p.startsWith('/fonts/')) return join(ROOT, 'public', p);
  if (p.includes('..')) return null;
  return join(ROOT, 'dist', p);
}

createServer((req, res) => {
  const path = resolvePath(req.url);
  if (!path) { res.writeHead(403); res.end(); return; }
  stat(path, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const headers = {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      createReadStream(path).pipe(res);
    }
  });
}).listen(PORT, () => console.log(`serving on http://localhost:${PORT}`));
