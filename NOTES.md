# NOTES — 决策记录与踩坑

## 数据源实测（2026-10-20 晚）
- **Geofabrik 不通**（连接超时，http 000）→ 用备选 `download.openstreetmap.fr`，单连接仅 ~25KB/s → 自写 `pipeline/fetch-fast.sh` 48 分段并行下载（~1MB/s+）。
- Copernicus DEM S3 / ESA WorldCover S3 / Natural Earth S3 均直连可达，速度正常但总量受出口带宽 ~1MB/s 限制。
- JDK 未预装 → micromamba 用户态环境一把梭（gdal 3.13 + tippecanoe 2.79 + osmium 1.19 + openjdk **21**，REMINDERS 要求 21 而非 25）。
- **rustup 官方源 static.rust-lang.org 超时** → 用清华镜像 `RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup` 安装成功。
- **crates.io 直连超时** → `rust/geotiles/.cargo/config.toml` 项目级 rsproxy 镜像。
- **PyPI 不通**（pip 装不了 fonttools）→ micromamba 装 fonttools。
- geofabrik/github release 大文件慢 → 一律走 fetch-fast.sh 分段下载（go-pmtiles v1.28.0、planetiler v0.10.2、planetiler 水多边形 930MB 均如此）。

## 进度快照（2026-10-21 02:35 终态）
- ✅ 全部产物：world 9.7MB / osm 274MB / dem 2.4GB / relief 644MB(webp) / hiking 27MB / contours 434MB
- ✅ 字形 2×256 PBF 全本地；✅ 五项 tests 全过（size 为 3.64GB 软目标告警，硬上限内）
- ✅ P1/P2 验收截图全过（shots/01-09），含生产构建验证
- ✅ contours 完成 z9/z12/z14（z15 体量失控砍掉，见上）

## 在 dsh 沙箱里从零复现（2026-10-21，笔记本本地）
沙箱只允许写工作区，`$HOME` 只读。所有工具的 home/cache 都要重定向，否则会撞 EROFS：
```bash
export MAMBA_ROOT_PREFIX="$PWD/tools/mamba-root" CONDA_PKGS_DIRS="$PWD/tools/pkgs"
export XDG_CACHE_HOME="$PWD/tools/.cache" HOME="$PWD/tools/fakehome"
export RUSTUP_HOME="$PWD/tools/rustup" CARGO_HOME="$PWD/tools/cargo"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/tools/pw-browsers"
npm_config_cache="$PWD/.npm-cache"
```
- `micromamba create` 会写 `~/.conda/environments.txt` → 必须把 `HOME` 指到工作区内。
- `npm install` / `npx playwright install` 同理，前者用 `--cache ./.npm-cache`。
- headless Chromium 在沙箱里 crashpad 起不来会 SIGTRAP：`shot.mjs` 已加 `--disable-crash-reporter`。
- `tests/check-align.mjs` 依赖 pillow（`micromamba install pillow`），`08-glyphs.sh` 依赖 fonttools。
- 本机实测耗时：DEM 81 片 8 并发约 25 min；`06-dem` warp 3.5 min；`dem2tiles` z0-12 3 min；
  `bake-relief` z0-13 约 50 min；contours 生成 z9/z12/z14 约 13 min、tippecanoe 约 8 min。
  （contours 的 z15 会因体量失控被跳过，脚本里已注明。）

## 本机环境备忘
- 文件系统偶发瞬时 "没有那个文件或目录"（疑似网络盘），nohup 重定向失败时 touch 先建文件再重试即可。
- 5173 端口被别的项目（formusafe 9月27日残留 vite）占用 → 本项目用 5271。
- Rust 双份：~/.cargo（rustup, 清华镜像）+ ~/.local/rust-1.99.1（子代理手动装），geotiles 用后者构建。

## 改进记录 v2（2026-10-21 下午）

对 v0.1 产物做了一轮画质与体积修正，全部离线重烘一次（dem 3 min / relief 约 25 min）。

### 体积：3.64 GB → 2.50 GB
- **terrarium 编码改为整米量化**（`encode.rs`）：原实现把小数米写进 B 通道，B 变成纯噪声、PNG 完全压不动，
  单瓦片 ~145 KB。改为 `R=v>>8, G=v&255, B=0` 后精度仍有 1 m（z12 一个像素 ≈38 m，用不到更细），
  **dem 2.4 GB → 1.2 GB**。`terrarium_decode` 对新旧两种布局都成立。
- relief 因加了 alpha 通道一度涨到 745 MB，土地覆盖改用众数重采样后回落到 **637 MB**。

### 画质
- **删掉 `hillshade` 图层**：它排在 `raster-opacity: 1` 的 relief 下面，永远被完全遮住，
  等于每帧白做一次 DEM 渲染到纹理。780M 这种核显上是纯浪费。
- **土地覆盖改用 GDAL `-r mode` 重采样**（原来是 bilinear，类别码被平均成不存在的值；
  改成 `near` 后低 zoom 又变成单像素抽样的棋盘格）。众数核才是分类栅格该用的：
  成都平原的农田、森林边界现在都成片了，不再是绿/黄斑点。
- 分类图再加 3x3 众数滤波，去掉陡坡上的孤立裸岩像素。
- **雪线 4800 → 5200 m**，并让高程色带权重随海拔从 0.30 升到 0.75：
  原来 4800 m 以上整片刷白，贡嘎整个峰体糊成一坨；现在 4800-5200 是碎石色过渡，
  陡坡保留岩石纹理，雪只在 5200 m 以上且坡度小于 ~34° 的地方出现。
- 裸地 class 60 由暖卡其 `#A9A296` 改为冷中性灰 `#8F948B` —— 暖色在深绿森林里会读成粉色斑点。
- relief 在 DEM 范围外输出 **alpha=0**，bbox 东缘那条不透明的橄榄色竖带消失。
- 地形晕渲对比度 0.55+0.45s → 0.50+0.50s，噪声 0.12 → 0.09，去饱和 0.10 → 0.06。

### 交互
- 初始视角 z4.2 → **z2.6**，打开先看到球体，再往里推。
- `place=town` 出点 z8 → **z10**，`village` z11 → **z12**。原来 z9 一屏 50 个「XX乡/XX镇」，
  现在只剩 4 个县名，细节交给地形和路网。
- 等高线加深（线色 `#A8916F`，opacity 0.45 / 计曲线 0.75）。

### 构建/验证
- `scripts/shot.mjs` 加 `--disable-crash-reporter`：沙箱里 crashpad 起不来会让 headless Chromium 直接 SIGTRAP。
- `Raster` 增加 `read_window_r` / `read_merc_window_r`，可显式指定重采样核（DEM 用 bilinear，分类栅格用 mode）。
- Rust 单测 21 项全过（新增 terrarium 整米量化两条）。

## 性能：预取与 LOD 切换（2026-10-21 晚）

目标：缩放时不再「松手之后才变清楚」。手段分三层。

### 1. MapLibre 选项（`src/main.ts`）
| 选项 | 值 | 作用 |
|---|---|---|
| `cancelPendingTileRequestsWhileZooming` | **false** | 默认 true 会在放大时把上一级没下完的瓦片全砍掉，细节只能等停了才出现。这是官方文档里针对「缩放结束才出细节」的那一条 |
| `maxTileCacheZoomLevels` | 8（默认 5） | 跨级别保留瓦片，换级时不必回去重下 |
| `maxTileCacheSize` | 900 | 每 source 的瓦片缓存上限 |
| `refreshExpiredTiles` | false | 本地数据不会过期，省掉 revalidate |
| `fadeDuration` | 120（原 0） | 0 是硬切，换级那一下很扎眼；120ms 只用来盖住切换 |

### 2. 预取（`src/prefetch.ts`）
空闲时用 PMTiles 客户端（`PMTiles` + `FetchSource`）直接把字节取回来塞进 HTTP 缓存：
- 栅格（dem / relief）向未来 2 级、向过去 2 级；矢量（osm / contours / hiking）各 1 级。
  **两个方向都要**——只预取子级的话，缩小时永远比放大卡（父级从来没人提前下）。
- 每级有 budget，视口铺满整个球时会自动跳过。
- 触发点：`load` / `idle` / `moveend` / `zoomend`。
- **`movestart` 时立即暂停**：浏览器对同一 host 只有 6 条 HTTP/1.1 连接，
  预取一抢就把 MapLibre 真正要用的那几张挤到后面。
  实测在 `zoom` 里抢瓦片，手势后收敛从 84ms 拖到 164ms，所以撤掉了。
- `?prefetch=0` 可关掉，方便对比。

### 3. 服务器缓存头
`vite.config.ts` 与 `scripts/prod-server.mjs` 都对 `/data/`、`/fonts/` 发
`Cache-Control: public, max-age=3600`。没有这个，预取等于白做（浏览器不会留）。
重建数据后要立刻生效就强制刷新一次。

### 实测（headless + SwiftShader，1600×900，z9 → z12 easeTo）
- 手势期间瓦片请求的 **HTTP 缓存命中率：1–2% → 20–25%** —— 预取确实把瓦片提前拿到了。
- 手势后收敛时间：测量噪声太大（off 67/124/346，on 65/127/892），**没有测出可靠的墙钟改善**。
  这台机器是 SwiftShader 软件渲染，`areTilesLoaded` 轮询本身也被拖慢，不足以作为结论。
  真实帧率仍以 780M 实机为准。
- 缩放方向上的收益是可解释的：缩小时的父级瓦片原来从没被预取过，现在有了。

## 修：HUD 海拔偏高（2026-10-22）

现象：成都平原显示 600 多米（实际 ~494），川西山区偏高约 2000 m。

原因：`map.queryTerrainElevation()` 返回的是**乘过 `exaggeration` 之后**的高度
（官方文档原话：*the value returned here will be reflective of (multiplied by) that exaggeration value*）。
地形夸张默认 1.3：
- 494 × 1.3 = 642 → 「六百多」✓
- 7401 × 1.3 = 9621 → 偏高 2220 m ✓

一个常量偏移解释不了 2000 的差，但乘系数刚好对上两端。

修法：`src/ui/hud.ts` 存原始值，显示时除以 `map.getTerrain()?.exaggeration`。
顺带把 `0` 当作「该点 DEM 还没加载」（川西没有海平面地形），不再显示 `0 m`。

验证（headless，夸张度 1.3）：
| 点 | 原始查询 | 修正后 | 数据实值 |
|---|---|---|---|
| 成都天府广场 | 642 | **494** | 494 |
| 稻城县城 | 4880 | **3754** | 3755 |
| 康定 | 3465 | **2665** | 2660 |
| 贡嘎主峰 | 9641 | **7416** | 7401 |
把夸张度调到 2.0 后，HUD 仍读 493 m（原始 987）。

## 全球粗底：ETOPO（2026-10-22）

问题：比例尺拉到 200km（z5-6）时川西之外是纯色地球仪，因为地形数据只覆盖研究区 bbox。

方案：ETOPO 2022 60″（1.8km，含海底地形）做 z0-7 的全球底，并进现有两个产物。

### 数据
| 产物 | 内容 | 大小 |
|---|---|---|
| `relief-world.pmtiles` | 全球户外底色 z0-7，含海洋深度着色 | 57 MB |
| `dem.pmtiles` | 原川西 z0-12 + 全球 z0-6 补洞 | 1.4 GB（原 1.2 GB） |

ETOPO 原始文件 466 MB（NOAA，单连接 ~90KB/s，必须用 `fetch-fast.sh` 24 段并发）。

### 实现要点
- `pipeline/10-world-relief.sh`：warp 到 3857 @1223m（z7 在赤道 1:1）→ gdal_rasterize
  NE 沙漠/苔原多边形当粗略地类 → `dem2tiles` z0-6 → **insert-missing 合并**进
  `dem.mbtiles`（川西瓦片优先，全球只补缺的）→ `bake-relief --world-palette` z0-7。
- `bake-relief` 新增海面分支：`elev < 0` 直接按水深上色（`ocean_color`），
  深端取 `#1E4E6B`，和 style 的 `background` / `world-ocean` 完全同色，
  z7 之后全球底色退场时海面不会跳色。
- `--world-palette`：全球用一套更暗更绿的高程色带（`hypsometric_tint_world`），
  比原来浅黄绿的 physical map 色带更接近 WorldCover 上色的细图。

### 接缝（花了最多时间的地方）
细图（WorldCover 真实地类）和全球图（纯高程色带）拼在一起，最初是一块荧光绿矩形。
三层修正：
1. **低 zoom 时向高程色带靠拢**：`zoom_blend = 0.30 + clamp((7.5-z)/2.5, 0, 0.62)`，
   z5 时 0.92（几乎等于全球底色，看不出边界），z7.5 之后回落 0.30 交还真实地类。
   理由：z5 一个像素代表 5km，WorldCover 的「主导地类」已经没有意义。
2. **边缘羽化** `--feather-meters 60000`：靠近 bbox 边界 60km 内继续向全球色带过渡。
3. **全球色带加深**，缩小两套调色板的整体明度差。

效果：z5 只剩极淡的矩形痕迹，z7 基本看不出，z9 以上完全恢复细图。

### 顺带
- `check-bbox.mjs` 区分「全球产物」和「研究区产物」：前者要求覆盖 bbox，后者要求落在 bbox 内。
- `prefetch.ts` 加入 `relief-world`（z0-7，很便宜）。
- 体积 2.50 → 2.65 GB。

## 3D 俯视：LOD 与相机高度（2026-10-22 晚）

### 远处的 LOD（已改）
`map.setSourceTileLodParams(3, 5)`，在 `load` 后调用：
- 第 1 个参数 = 同屏允许的 zoom 级数。默认值在地平线附近 LOD 衰减很快，
  60° 俯角时屏幕上缘的地形比下缘糊一大截；调到 3 后远处能拿到更细的瓦片。
- 第 2 个参数 = 高 pitch 下允许的瓦片数倍率，放宽到 5。
- 代价：请求数 +15~20%，LOD 分级边界会略微可见（放大到 z12 以上不明显）。

### 相机高度（已加）
HUD 增加「视角」一行。MapLibre 6 的 `Map` 没有公开 `getCameraAltitude()`，
只有内部 `_camera.transform.getCameraAltitude()`。它返回的高度**包含地形夸张**，
所以要换算：`真实海拔 = alt − centerElev × (1 − 1/exaggeration)`。
实测 z12 / pitch 62 / 夸张 1.3：内部值 15956 m，地面 5447 m（真实 4190 m），
显示 14699 m，与换算结果一致。

### 闪烁（改了一处，未完全定位）
`fadeDuration` 从 120 改回 **0**。120ms 的 alpha 淡入在大量瓦片同时进出时
本身就像在闪，而地形 drape 每帧都在重画，淡入只会增加噪点。
**「横向拖动时相机高度跳变」在 headless 里没能复现**：脚本拖拽时
`transform.getCameraAltitude()` 全程恒定（MapLibre 在 gesture 期间会
`holdElevation` 冻结中心高程，松手才 putCenterBackOnTerrain），5 次拖拽松手后的
高度差都是 0。所以要么是真实指针/惯性输入才触发，要么与 DEM 瓦片在手势中落地有关。
排查入口：控制台 `__map.setCenterClampedToGround(false)`（关掉中心点跟随地面高程），
或者 `__map.getCenterClampedToGround()` 看当前状态。

## UI 重做（2026-10-22 晚）

原来的界面是一块 `white-space: pre` 的文字条 + 几个方角按钮，交互也老气。整版重写：

- **`src/ui/ui.css`**（新）：玻璃拟态浮层 —— `backdrop-filter: blur(18px) saturate(150%)`、
  1px 半透明白边、深投影、14~18px 圆角、`cubic-bezier(.2,.8,.2,1)` 过渡。
  强调色 `#F2A65A` 取自地图里的道路橙。
- **顶栏**：左侧品牌胶囊（山形 SVG + 名字），中间目的地胶囊（带海拔副标），
  右侧两个图标按钮（回全球视角 / 图层）。窄屏下品牌自动收起、胶囊横向滚动并加渐隐遮罩。
- **左下仪表盘**：坐标 / 海拔 / 视角 / 缩放 + FPS 灯（>40 绿、<40 黄、<20 红）。
  改成逐字段写 DOM，不再每 250ms 重建 innerHTML。
- **图层抽屉**：地形卡片（开关 + 夸张度滑块，关掉时滑块变灰）+ 8 个图层行
  （色块图例 + iOS 风格开关 + 展开式透明度滑块，带百分比）+ 底部快捷键提示。
  抽屉内滚动条自定义，`flex: 1 1 auto; min-height: 0` 保证 footer 常驻。
- **MapLibre 自带控件**（缩放/指北/全屏/比例尺/署名）全部重配色成同一套玻璃风。
- 比例尺从左下挪到右下，避免和仪表盘、窄屏下的署名挤在一起。
- 空状态用 `—` 并降低透明度，不再显示 "undefined"。

同时把 `setSourceTileLodParams` 从 (3,5) 收到 **(2,2)**：
实测把 zoom 级数放到 3 或把瓦片倍率放到 4~5，远处确实更清楚，
但坡面上会出现一条明显的绿色分层带（不同 zoom 的瓦片混渲染）。
(2,2) 在远处清晰度和画质之间是当前能找到的最好点。

## 图形设置页（2026-10-22 深夜）

抽屉改成两个标签页：**图层 / 图形**。图形页把之前只能在代码里改的性能参数全部暴露出来：

| 项 | 取值 | 对应 API |
|---|---|---|
| 画质预设 | 省电 / 均衡 / 高画质 | 一次性套用下面四项 |
| 渲染分辨率 | 1× / 1.5× / 2× / 自动 | `map.setPixelRatio()`，自动 = `min(devicePixelRatio, 2)` |
| 远处地形细节 | 省电 / 均衡 / 锐利 | `map.setSourceTileLodParams([1,1]/[2,2]/[3,5])` |
| 远景清晰度 | 关 / 默认 / 强 | `map.setAnisotropicFilterPitch(90/20/0)` |
| 空闲预取瓦片 | 开 / 关 | `prefetchState.enabled` |

- 单独改动任一项 → 预设标记为「自定义」。
- 底部实时显示 FPS（按 50/30 变色）、当前渲染分辨率、缩放。
- 全部设置存 `localStorage`（键升到 `chuanxi-map-state-v2`，会自动迁移 v1 的图层状态）。
- LOD 不再写死在 `main.ts`，统一由设置页施加，避免和用户选择打架。
- `prefetch.ts` 增加 `prefetchState.enabled` 运行时开关；暂停时 pump/定时器都会让路。
- `hud.ts` 导出 `perfStats.fps` 给设置页复用，不重复开 rAF 计数。

## 修：放大后 DEM 到货导致相机高度跳变（2026-10-22）

**复现**：z11 / pitch 60 起跳，`jumpTo` 到 z13.2 的一片新山区，逐帧采样
`_camera.transform.getCameraAltitude()`：

| 模式 | 结果 |
|---|---|
| 默认（中心点跟随地面） | t=76ms 一次 +5186（缩放本身）→ **t=1188ms 又一次 +64m**，同时 `getCenterElevation()` 从 5191 变成 5255 |
| `setCenterClampedToGround(false)` | 只有缩放那一次，**`getCenterElevation()` 全程恒定 4891，无二次跳变** |

**根因**：MapLibre 在静止时每帧都执行
`if (!elevationFreeze && centerClampedToGround) transform.setElevation(dem(center))`。
缩放之后新的 DEM 瓦片到货，该点高程随之改变，相机就跟着跳。手势期间 MapLibre 会
`holdElevation` 冻结，但**手势结束后解冻**，于是「LOD 加载完成后跳一下」。

**处理**：`map.setCenterClampedToGround(false)`，并在图形页加了「相机 › 跟随地面高程」
开关（默认关，想回到贴地飞行可以打开）。默认关掉后 `getCenterElevation()` 恒定，
缩放不再跳。

**代价**（实测过）：中心高程不再更新，平移到更高的山时相机会低于地面，
但 MapLibre 自己的 `_keepCameraAboveTerrain` 会把它抬起来，画面不会穿模
（实测从 4260m 区域平移到 6880m 的贡嘎主峰，视野正常，只是 HUD 的「视角」会
显示被抬高后的真实值）。

## 地点搜索（⌘K）（2026-10-22）

**索引**：`pipeline/11-search.sh` + `pipeline/11-search-index.py`
- `osmium tags-filter` → `osmium export -f geojsonseq` → python
- 抽取：place(city/town/village/hamlet/suburb/…)、natural=peak/saddle、mountain_pass、
  tourism=alpine_hut/wilderness_hut/camp_site/viewpoint、natural=water（含 multipolygon 关系）、
  waterway=river、highway=motorway/trunk/primary/secondary/path/track/footway
- **坑 1**：湖泊大多是 multipolygon 关系，只过滤 `w/natural=water` 会漏掉（泸沽湖就漏了），
  必须加 `r/natural=water`。
- **坑 2**：道路/河流是线状要素，一条国道在 OSM 里是上百个 way，
  按「名称+坐标」去重会刷出 4.8 万条；改成线状要素按**名称**去重后降到 4,805。
- **坑 3**：`osmium export` **不会导出 route=hiking 关系**，所以步道只能靠命名的
  `highway=path/track/footway` way 来补（539 条）。
- 结果：46,346 条 / 39,905 个名称 / **2.65 MB**，缓存到 `public/data/search.json`（已入库）。
- 拼音用 `pypinyin`（conda-forge 装了），生成全拼 + 首字母；没装则自动降级。

**前端**：`src/ui/search.ts`
- ⌘K / Ctrl+K / `/` / 右上放大镜 → 命令面板；输入框 + 结果列表 + 快捷键提示
- 惰性加载：首屏 0 请求，第一次打开面板才 fetch（实测 beforeOpen=0 / afterOpen=1）
- 打分：名称完全相等 1000 > 前缀 820 > 子串 620 > 拼音全等 700 > 首字母 680 >
  拼音前缀 520 > 首字母前缀 500 > 拼音子串 380，再 + 类别权重 - 距离惩罚（min 70）
- 单字符只做前缀匹配，避免「贡」这种命中上万条
- 类型 → 跳转：城市 z11 / 镇 z12 / 村 z13.5 / 山峰 z15.5 pitch55 / 山屋 z16 …
- 选中后落一枚脉冲 pin + 气泡（名称 / 类别 / 海拔），最近 5 条存 localStorage
- IME：composition 期间不触发搜索、不响应 Enter
- `map.movestart` 时自动收面板，避免挡住拖动

**测试**：`tests/check-search.mjs` —— 结构校验 + bbox + 索引越界 + 体积上限 +
抽查（贡嘎山/幺妹峰/稻城县/泸沽湖 的类型与坐标误差）。

## 视角旋钮 + 拖动改绑（2026-10-22）

### 旋钮
MapLibre 自带的 `NavigationControl` 又小又偏，换成 `src/ui/viewknob.ts` 自己画的：
- 52px 圆形旋钮，外圈刻度 + 橙色指北针 + 外环弧线表示俯角（0~85°）
- 横向拖 = 转方位角（0.42°/px），纵向拖 = 调俯角（0.36°/px）
- **单击 = 回正**（正北 + 水平）；拖动时旁边浮出「东北 27° · 俯角 14°」
- 聚焦后方向键微调（Shift 加速），Enter/空格回正
- 旋钮放在 +/− 缩放**左侧**（同一行，垂直居中），全屏在其下；整列统一 52px
- 读数气泡改为挂在旋钮上、向左浮出，不再压在按钮上
- 比例尺从左下挪回来（右下让给旋钮）；窄屏下直接隐藏比例尺，免得和两行署名打架

### 拖动绑定（关键坑）
MapLibre **6.15 已经把旋转绑到 Ctrl+左键 / 右键**，Shift+左键变成了框选缩放——
所以「Shift 拖动」在原来的代码里根本不是旋转。
`dragRotate: { around: 'pointer' }` 是官方自带的 pointer 锚点模式
（「抓住指针下的地形点旋转，该点留在屏幕原位」），但它的触发键写死在
内部 `moveStateManager._correctEvent` 里：`button===0 && ctrlKey || button===2`。

处理（`src/ui/gestures.ts`）：
```js
patch(dragRotate, e => (e.button===0 && (e.ctrlKey || (e.shiftKey && !e.altKey))) || (e.button===2 && !e.ctrlKey));
patch(dragPan,   e => e.button===0 && !e.shiftKey && !e.ctrlKey && !e.altKey);
```
- **Shift + 左键** → 抓点旋转（走官方 pointer 模式，带地形高程）
- **Alt / Ctrl + 左键** → 绕屏幕中心旋转（自己实现，0.45°/px）；Linux 上 Alt+拖动
  常被窗口管理器抢走，所以 Ctrl 也接受
- 同时 `boxZoom: false`，把 Shift 让出来
- 内部字段拿不到时静默跳过，最坏退化回默认绑定

实测：
| 操作 | 方位 | 中心 |
|---|---|---|
| Shift 拖 200px | 0° → 160° | 变（pointer 模式）|
| 抓取点屏幕漂移 | — | **< 1px** |
| Alt 拖 200px | 0° → 90° | 不变（center 模式）|
| 无修饰键拖 | 不变 | 变（平移）|

### 未解决
bearing ≠ 0 时，地形 drape 的 **relief 栅格**会出现绿色竖向条纹 + 少量黑色碎片
（`terrain` 开、`relief` 层隐藏后消失）。在 SwiftShader 下稳定复现，
关掉各向异性过滤无效。怀疑是 MapLibre 旋转后 RTT 贴图变换的问题，需要真机确认。

## 修：地图「突然跑到几百公里外」（2026-10-22）

### 根因（MapLibre 已知行为）
地形手势期间 MapLibre 会**冻结相机高程**（拖动时保持等高）。手势一结束，
它拿冻结值和新采样的 DEM 高程对账，调 `transform.recalculateZoomAndCenter`：
保持相机 3D 位置不动，反过来重算 **center 和 zoom**。俯角陡的时候，
Δe 会沿视线把中心滑走 `Δe · tan(pitch)`（85° 约 11 倍），同时 zoom 被重算，
于是「停手的一瞬间地图被拽走一大截」。平地上几米的高程差就能看出来，
川西这种落差上直接是几公里起步，叠加 zoom 重算就是「跑出几百公里」。

### 之前那版为什么是反的
我上次为了消掉「放大后 DEM 到货导致高度跳变」，直接把
`setCenterClampedToGround(false)` 永久写死。这个字段同时也管**每帧跟随地形**，
关掉之后相机会「浮」在旧高程上：
- 平移时地形从相机下面穿过去 → 视差漂移
- 中心高程永远不更新 → 地形一换就各种异常

也就是说：修好了小毛病，引入了大毛病。

### 正确解法
只在**手势窗口内**把 `getCenterClampedToGround()` 遮成 false，字段不动
（`src/ui/gestures.ts` 的 `preventTerrainGestureSnap`）。

v6 里有两个闸口会读这个方法，必须都遮：
- `HandlerManager` 读 Map 上的同名方法
- `Camera._finalizeElevation` 读 `map._camera` 上的方法

静止时恢复真实方法，每帧跟随地形照常工作。

实测：
| 检查 | 结果 |
|---|---|
| 静止时 `getCenterClampedToGround()` | true |
| 拖动中 | false |
| 松手后 | true |
| 松手瞬间中心位移（pitch 78 跨地形） | **0 km** |
| 静止后滚轮缩放，中心高程是否跟随 | 5702 → 5945（跟随正常） |

**代价**：缩放结束后新 DEM 瓦片到货时，相机仍有约 64 m 的小跳（z13 约 4 px）。
这是「每帧跟随地形」换来的，比之前那套「float + 回弹」好得多。

参考：
- MapLibre 地形手势回弹的成因与解法（bitruvius SDK 的 `preventTerrainGestureSnap` 文档）
  https://cdn.bitruvius.com/sdk/v0.3.2/docs/functions/_bitruvius_sdk-maplibre.preventTerrainGestureSnap.html
- GeoLibre 同类修复：unclamp map center while terrain is on
  https://github.com/opengeos/GeoLibre/commit/9cfc1f672078f7057309907068cabeb4a3c26e54

同时移除了图形设置里的「相机 › 跟随地面高程」开关（不再需要，字段改由手势窗口控制）。

## 双击后拖动 = 抓点旋转（2026-10-22）

不想按 Shift 也能抓点旋转，做法是把「连续点击的第二下」当成旋转手势：

- 窗口**捕获阶段**监听 `mousedown/mousemove/mouseup`，判断这次按下是不是
  上一次**点击**（位移 < 4px）之后 450ms 内、且落点相距 < 16px 的第二下。
- 判定成立时把模块级 `forcedRotate` 置位，我们自己打的 `_correctEvent` 补丁
  同时让 `dragRotate` 放行、`dragPan` 让路——所以走的还是官方 `around: 'pointer'`
  实现（带地形高程、抓取点不漂）。
- 上一手如果是**拖动**就不算，避免连续两次快速平移被误判成旋转。
- 抓点旋转拖完之后浏览器还会补一个 `dblclick`，700ms 内直接吞掉，否则会跟着放大；
  纯双击（没拖）不走这条路，放大照旧。

实测：
| 手势 | 结果 |
|---|---|
| 双击后按住拖 200px | 方位 0° → 160°，zoom 不变 |
| 两次快速平移 | 方位不变，正常平移 |
| 单击 + 快速按住拖 | 方位 0° → 120° |
| 纯双击 | zoom 12 → 13 |

## 地图上标出景区 / 文化古迹 / 车站机场（2026-10-22）

**不用加数据**：这些要素本来就在 `osm.pmtiles` 里（`park` / `poi` / `aerodrome_label` 层），
之前只是没有图层去画。新增 6 个图层，全部走已有的 `osm` 源，**0 额外字节**。

| 图层 | 来源 | 说明 |
|---|---|---|
| `scenic-line` / `scenic-label` | osm/park (nature_reserve, national_park) | 虚线边界 + `◇/◆ 名称` |
| `culture-dot` / `culture-label` | osm/poi (attraction, museum, monument, castle, place_of_worship, college, winter_sports, zoo…) | 圆点按类别配色 + 名称 |
| `transport-station` / `-label` | osm/poi (class=railway, subclass=station/halt) | 蓝点 + 站名 |
| `transport-airport` / `-label` | osm/aerodrome_label | 深蓝点 + 机场名 |

图层顺序：`water-fill` → `scenic-line` → `scenic-label` → `contour` → … → `culture-*` → `transport-*` → `trail-name`。

**踩到的两个点**：
1. 一开始给景区加了绿色 `fill`，结果整个九寨沟保护区被一层淡绿盖住，**地形起伏全被抹平**，
   变成一块死绿。改成只画虚线边界 + 标签，地形恢复。
2. `park` 层里同一个景区常被拆成多个多边形，所以「毕棚沟」「九寨沟风景名胜区」
   会重复出现 2~4 次。MapLibre 只做标签避让，不按名字去重，暂时接受。

面板新增三个分组（都可单独开关 + 调透明度）：景区与保护区 / 文化古迹 / 车站与机场。
`applyGroup` 补了 `circle-opacity`，否则圆点不跟着透明度走。

**注意**：色达喇荣五明佛学院在瓦片里是 `poi:college/college`，**地图上已经能显示**，
但它仍然**搜不到**——搜索索引走的是 OSM 原始标签过滤，需要把 `landuse=religious`
和 `amenity=university/college` 加进去才行（已评估：全局 +6,308 条 / +0.43 MB）。

## 铁路网（2026-10-22）

`osm.pmtiles` 的 `transportation` 层里 `class=rail` 已有数据（成都周边 150 个瓦片里 86 条），
直接加三个图层，同样 0 额外字节：

| 图层 | 作用 |
|---|---|
| `rail-casing` | 白色描边（3.4px），把铁路从底图上托出来 |
| `rail` | 深灰主线（2.0px）|
| `rail-ties` | 白色短虚线（`[1.2, 3.6]`），z11 起淡入，做出枕木的观感 |

顺序放在 `boundary` 之后、`road-casing` 之前——公路压在铁路上，
道口看起来才对。面板新增「铁路」分组，可单独开关。
