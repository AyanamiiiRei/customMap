import { defineConfig } from 'vite';

// 瓦片与字形加长缓存：prefetch.ts 会提前把 z+1/z+2 的瓦片字节拉进来，
// 没有 Cache-Control 的话浏览器会反复回源，预取就白做了。
const cacheHeaders = {
  name: 'data-cache-headers',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url: string = req.url ?? '';
      if (url.startsWith('/data/') || url.startsWith('/fonts/')) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [cacheHeaders],
  server: {
    port: 5271,
    fs: { allow: ['.'] },
  },
  build: {
    // data/ 与 fonts/ 体积大，不随 build 拷贝；serve 脚本里用符号链接挂进 dist
    copyPublicDir: false,
  },
  // maplibre 运行时按相对路径加载 maplibre-gl-worker.mjs，
  // 预打包会破坏这个相对关系，故排除出 optimizeDeps
  optimizeDeps: { exclude: ['maplibre-gl'] },
  publicDir: 'public',
});
