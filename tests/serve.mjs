// serve.mjs — 测试用共享静态服务器（流式 + Range）
import { createServer } from 'http';
import { stat, createReadStream } from 'fs';
import { join } from 'path';

export function serveDir(dir) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent(req.url.split('?')[0]));
    stat(path, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        createReadStream(path, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
        createReadStream(path).pipe(res);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
