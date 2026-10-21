import { defineConfig } from 'vite';

export default defineConfig({
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
