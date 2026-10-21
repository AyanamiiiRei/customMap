# SPIKE — P0 技术验证记录

## 结论：**继续 MapLibre GL JS v6**（无需自研渲染器）

## 验证方法（与原始 P0 计划的偏差说明）
- 本机（HPC 计算节点，无显示器、GPU 为无显示输出的 Tesla T10）**无法测 780M 真实帧率**。
  实测手段：headless Chromium + SwiftShader 软件渲染（`--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`），
  SwiftShader 下 8–9 fps 属正常，**不作为性能依据**（性能以用户 780M 实测为准）。
- 因直接跑通了自有数据管线，P0 的「公共 terrain-RGB 瓦片」临时源未使用，直接以本项目产物验证。

## 已验证项（截图见 shots/）
1. **球体 + 矢量底图**：`shots/00-spike-globe.png` —— globe 投影正常，Natural Earth 陆/海/湖/河流渲染，球体大气光照渐变可见。
2. **矢量中文标注**：`shots/02-chuanxi-z7.png` —— z7 川西，县市中文名（Noto Sans SC 本地字形）、水系、碰撞避让全部正常，线条文字锐利。
3. **WebGL2**：headless 下 `getContext('webgl2')` = true；maplibre-gl 6.15.0（multidirectional hillshade 支持已在包内确认）。
4. **地形**：✅ `shots/03/04/09` —— 贡嘎山 z12 真 3D 地形 + 烘焙户外底色 + 雪线，生产构建同样验证通过。

## 已踩并解决的坑
- maplibre v6 worker 与 vite 预打包冲突 → `optimizeDeps.exclude: ['maplibre-gl']`。
- Chrome 125+ 需 `--enable-unsafe-swiftshader`，否则 webgl2 白屏。
