# REMINDERS — 在 hpc 上开工前先读这一份

`AGENT_PROMPT.md` 是完整规格（技术选型、数据结构、配色、验收）。
**这一份是补充**：本机的实测事实、拿不到 root 时怎么装依赖、以及我踩过的坑。**两份都要读，冲突时以本文件为准。**

---

## 0. 本机事实（我已实测，不要再花时间探测）

| 项 | 实测结果 |
|---|---|
| 系统 | Rocky Linux 10.2，20 核，30 GB RAM（26 可用），`/home` 515 GB 空闲 |
| node / npm | v22.23.1 / 10.9.8 ✅ |
| conda | 26.3.2 ✅（`~/miniconda3/bin/conda`） |
| **sudo** | ❌ **需要密码，拿不到 root**。所有依赖只能用户态装（conda / npm / cargo） |
| java | ❌ 未安装 |
| gdal / osmium / tippecanoe / pmtiles | ❌ 全部未安装 |
| cargo / rustc | ❌ 未安装 |
| chromium / chrome / Xvfb | ❌ 全部未安装 |
| playwright | ✅ 已存在于 `~/Repositories/formusafe/node_modules/playwright` |
| electron | ✅ v33.4.11 已缓存（`~/Repositories/formusafe/node_modules/electron/dist/electron`） |
| GPU | Tesla T10 / 15 GB / 驱动 610.43.02 —— **计算卡，无显示输出，本任务用不上，别折腾它** |

---

## 1. 网络（实测，这一条最省时间）

| 源 | 状态 |
|---|---|
| `download.geofabrik.de` | ❌ **超时，不通**。不要在这上面浪费时间 |
| `download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf` | ✅ 200 ← **OSM 走这个** |
| `download.bbbike.org` | ✅ 200（备用，可按 bbox 定制导出） |
| `copernicus-dem-30m.s3.amazonaws.com` | ✅ 200（实测 N29E101 山区片 40.5 MB） |
| `esa-worldcover.s3.eu-central-1.amazonaws.com` | ✅ 200（104 MB/片） |

DEM 81 片按平均 45 MB 估，**下载量约 3.3–4 GB**。用 `curl -C -` 断点续传 + 4–6 路并发。

---

## 2. 依赖安装（全部 conda-forge，我确认过这些包存在）

```bash
~/miniconda3/bin/conda create -y -n geo -c conda-forge \
    osmium-tool=1.19 tippecanoe=2.79 openjdk=21 gdal python=3.12
~/miniconda3/bin/conda activate geo     # 之后所有 pipeline 命令都在这个 env 里跑
curl https://sh.rustup.rs -sSf | sh -s -- -y   # rustc/cargo 进 ~/.cargo
```

- **openjdk 用 21，别用 25**（planetiler 对 25 支持不确定）。
- `gdal` 装的是 python 包 + `libgdal`，`gdalinfo`/`gdalwarp`/`gdalbuildvrt` 都会进 env 的 bin。
- 如果 `tippecanoe` 装不上（conda 有时缺构建），退路：`world.pmtiles` 用 planetiler 自带的 Natural Earth 能力出低 zoom，或者用 `geojson-vt` + `vt-pbf` 写个 30 行 node 脚本。**不要让球体上空着。**

---

## 3. 你能"看见"自己的渲染结果 —— 不要盲写样式

这台机器没有显示器，但 **WebGL2 在 headless Chromium 里能跑**（SwiftShader 软件渲染）。你有 playwright，自己搭：

```bash
npx playwright install chromium          # 用户态，~150 MB，不需要 sudo
```

```js
// shot.mjs —— 关键三个参数，缺一个就白屏
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:5173');
await page.waitForFunction(() => window.__mapLoaded === true, { timeout: 120000 });
await page.waitForTimeout(4000);       // 等瓦片和地形
await page.screenshot({ path: 'shots/01-globe.png' });
```

**必须知道的坑**：Chrome 125+ 默认禁用了 SwiftShader 的 WebGL 回退，不加 `--enable-unsafe-swiftshader` 时 `getContext('webgl2')` 返回 null，页面白屏，你会误判成代码 bug 然后开始瞎改。

**两条纪律**：

1. **SwiftShader 的帧率不是真实性能**。它在这个场景大概 5–15 fps，**绝对不要**拿这个数去得出「性能不达标」的结论，然后开始乱优化。性能以用户笔记本的 780M 为准，你测不了，如实写在 `NOTES.md` 里。
2. 截图必须**真看到东西**才算过：地球有陆海、川西有地形起伏、道路和文字是清晰的。截图全黑/全蓝/纯色块 = 没跑通，**不许写"已完成"**。

`~/Repositories/formusafe/scripts/screenshot-ui.ts` 是同一台机器上跑通过的 Electron 截图脚本（`--ozone-platform=headless`），可以参考手法，但**不要直接复用**——本项目要的是普通浏览器页面，不是 Electron 应用。

---

## 4. 五条不可协商

1. **数据宁缺毋假。** 任何下载失败 → 停下，写进 `NOTES.md`，**绝对不要用随机数或插值合成地形**。假 DEM 看起来像真的，肉眼分辨不出来，是这次任务里唯一"看起来成功但彻底报废"的失败模式。
2. **不要换渲染器。** MapLibre GL JS v6。不上 Cesium、不上 Three.js、不上 Mapbox GL。P0 spike 跑完觉得画质不行，就写报告停下来，不要自己决定换。
3. **不要写 GCJ-02 / BD-09 任何东西。** 全仓 grep 到 `gcj` 就算失败。
4. **原始数据不进 git。** `.gitignore` 里加 `data/raw/`、`data/work/`、`node_modules/`、`public/data/*.pmtiles`。
5. **本地服务器必须支持 Range**。`npx serve` 可以，`python3 -m http.server` 不行（PMTiles 会整文件拉进内存）。

---

## 5. 时间盒（你大概只有一晚）

- 先花 **20 分钟** 把 §1 §2 的依赖装完、下载脚本挂后台跑起来（DEM 4 GB 是长尾，先启动）。
- 然后 **P0 spike**，再 **P1 全链路**。
- **到早上 6:00 还没出 P1，就停下来**：写 `NOTES.md`（做到哪、卡在哪、下一步），提交代码，不要开 P2。
- 半成品 + 说清楚卡在哪，比"跑完了"但一堆假数据有价值得多。

---

## 6. 明早会被跑的四条自检（先自己跑一遍）

```bash
node tests/check-bbox.mjs      # 所有 pmtiles 的 bounds 应为 [96,26,105,35]
node tests/check-dem.mjs       # 贡嘎 7556m / 四姑娘山 6250m / 成都 ~500m / 稻城 ~3750m，误差 >50m 报错
node tests/check-align.mjs     # 湖泊中心点：矢量面 vs relief 底色是否对齐
du -sb public/data             # ≤ 2.5 GB
```

`check-dem.mjs` 是**最重要的一条**——它会立刻暴露「DEM 没下、瓦片对歪、编码写错」这三类问题。
