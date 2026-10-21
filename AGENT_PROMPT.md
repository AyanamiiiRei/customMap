# 任务：构建「川西 3D 户外地图」— 浏览器内可自由转动的 3D 地球 + 真 3D 地形 + 矢量户外地图

你是一个全栈 + 图形工程师。请按本文档端到端实现一个**本地运行、纯静态、无后端**的 Web 应用。
本文档中的技术选型、数据源、目录结构、配色、验收标准**已经过论证并锁定**，不要重新论证或替换；如遇阻塞先在 `NOTES.md` 记录，再按「降级方案」列执行。

---

## 0. 一句话目标

在 Chrome 里打开一个页面：看到一颗可以自由拖拽旋转的 3D 地球 → 滚轮一路放大到川西的某条山脊 → 山体是真正的 3D 地形（能看出立体起伏、可以倾斜视角看山），地表是户外地图风格的分层设色（深绿森林、浅绿草甸、黄沙、浅蓝湖泊、深蓝海洋），上面有分级道路、徒步小径、等高线、山峰、村镇名。**任意缩放级别下线条和文字都锐利，拖动和缩放全程 60fps 不卡顿。**

---

## 1. 硬性约束（不可协商）

1. **纯浏览器**，Chrome 最新版，WebGL2。目标硬件：AMD Radeon 780M 核显（≈GTX 1060 级别），1080p，目标 60fps。
2. **无后端**。所有数据是本地文件，通过本地静态服务器 + HTTP Range 读取。禁止任何公网运行时请求（字体、瓦片、样式全部本地化）。
3. **数据总量 ≤ 2.5 GB**（上限 5 GB，留余量）。原始 DEM 下载可以到 4 GB，但**产物**不能超。
4. **不要栅格地图瓦片**。底图必须是矢量（几何 + 属性），放大不糊。
   - 唯一例外：为了画质而**离线烘焙**的「户外底色」栅格（见 §5.3），它是数据产品不是底图拼图。
5. **禁止任何 GCJ-02 / BD-09 纠偏代码**。全部数据与渲染统一 WGS84 / EPSG:3857，不做任何偏移变换。
6. **不写 C/C++**。需要高性能离线处理时用 **Rust**（当前机器未装 cargo，需先 `curl https://sh.rustup.rs -sSf | sh`）。
7. 不渲染建筑、不渲染 3D 树木模型、不接真实卫星影像、不做商铺 POI。
8. 所有离线脚本必须**参数化 bbox**，方便以后换区域（现在只做川西）。

---

## 2. 技术栈（已定）

| 层 | 选择 | 版本/说明 |
|---|---|---|
| 渲染引擎 | **MapLibre GL JS** | `maplibre-gl@^6.15`。v6 起仅 ESM、仅 WebGL2。**不要用 Mapbox GL（许可）**，**不要用 Cesium/Three.js**（理由见 §11） |
| 前端构建 | Vite + TypeScript | 纯 TS 即可，图层面板可用原生 DOM；不必上 React |
| 瓦片封装 | **PMTiles** | `pmtiles@^4`，单文件 + Range 请求，`maplibregl.addProtocol('pmtiles', new Protocol().tile)` |
| OSM → 矢量瓦片 | **planetiler**（Java，本机 JDK 25） | 跑 OpenMapTiles profile |
| 全球低 zoom 底图 | **Natural Earth 1:50m** + **tippecanoe** | tippecanoe 未装，需先装 |
| DEM → 地形瓦片 | **Rust** 自研 bin | `gdal` crate 读 COG + `image`/`png` 编码 + `rayon` 并行 |
| 裁切/筛选 | **osmium-tool** | 现成 C++ 工具，调命令行 |
| 全局底图地理要素 | Natural Earth | 公有领域 |

---

## 3. 研究区

**下载/处理 bbox（WGS84，minx,miny,maxx,maxy）**：

```
96.0, 26.0, 105.0, 35.0
```

覆盖：甘孜州全境、阿坝州全境、凉山州、雅安市、成都市西缘、攀枝花，以及云南迪庆/丽江、西藏昌都、青海果洛的边缘（无害，顺便带上）。

**初始相机**：`center: [101.8, 31.0]`, `zoom: 4.2`, `pitch: 0`, `bearing: 0`（先看到球）。
**演示目的地**（做 3 个快捷按钮，`flyTo`）：贡嘎山 `[101.88, 29.60]` z14 / 四姑娘山 `[102.90, 31.10]` z14 / 稻城亚丁 `[100.30, 28.45]` z14。

---

## 4. 数据源（URL 已实测可用）

### 4.1 OSM（矢量要素）
```
https://download.geofabrik.de/asia/china-latest.osm.pbf        # ~1–2 GB
```
> 国内可能不通。备选：`https://download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf`；
> 再不行用 bbbike.org 按 bbox 定制导出，或直接下载 `china-latest.osm.pbf` 的镜像。
> 裁切：`osmium extract -b 96.0,26.0,105.0,35.0 china-latest.osm.pbf -o data/raw/chuanxi.osm.pbf --strategy=complete_ways`

### 4.2 DEM：Copernicus DEM GLO-30（30 m，全球，含中国，免费可商用）
单瓦片 URL 模式（**已实测 200，43 MB/片**）：
```
https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N{NLAT:02d}_00_E{ELON:03d}_00_DEM/Copernicus_DSM_COG_10_N{NLAT:02d}_00_E{ELON:03d}_00_DEM.tif
```
例：`.../Copernicus_DSM_COG_10_N30_00_E103_00_DEM/...tif`
本 bbox 需要 N26..N34 × E096..E104 = **81 片，约 4 GB**。下载后转完即可删除原始 tif。

### 4.3 土地覆盖：ESA WorldCover 10m v2021（3°×3° 网格）
```
https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{NLAT:02d}E{ELON:03d}_Map.tif
```
例：`..._N30E102_Map.tif`（实测 104 MB/片）。本 bbox 需要 N24/N27/N30/N33 × E096/E099/E102 = **12 片，约 1.2 GB**。
类别码：10 树冠 / 20 灌木 / 30 草地 / 40 农田 / 50 建成区 / 60 裸地稀疏 / 70 雪冰 / 80 永久水体 / 90 湿地 / 95 红树林 / 100 苔藓。

### 4.4 全球底图：Natural Earth 1:50m（公有领域，< 15 MB）
`ne_50m_land`, `ne_50m_ocean`, `ne_50m_lakes`, `ne_50m_rivers_lake_centerlines`, `ne_50m_admin_0_countries`

---

## 5. 离线数据管线（四个产物，全部输出到 `public/data/`）

### 5.1 `world.pmtiles` — 全球低 zoom 底图（约 15 MB）
Natural Earth → `ogr2ogr` GeoJSON → `tippecanoe`：
```bash
tippecanoe -o public/data/world.pmtiles -Z0 -z6 --no-tile-size-limit \
  -L land:ne_50m_land.json -L ocean:ne_50m_ocean.json \
  -L lakes:ne_50m_lakes.json -L rivers:ne_50m_rivers_lake_centerlines.json \
  -L countries:ne_50m_admin_0_countries.json
```
作用：**球体在低 zoom 必须有内容**，否则只有川西一块补丁，观感彻底崩掉。

### 5.2 `osm.pmtiles` — 川西矢量瓦片（z0–z14，约 400–600 MB）

**主跑**（OpenMapTiles 标准 profile）：
```bash
java -Xmx24g -jar planetiler.jar \
  --osm-path=data/raw/chuanxi.osm.pbf \
  --output=data/work/osm.mbtiles --force
```
> planetiler 首次运行会自动下载 Natural Earth / water polygons 等辅助数据。

**必须额外补的一层：徒步线路**（OMT 标准 schema 不含 `route=hiking` relation）。
用 osmium 抽出来单独出一个小 pmtiles，前端作为第二个 vector source 叠加——**不要为此改 planetiler profile**，风险高收益低：
```bash
osmium tags-filter data/raw/chuanxi.osm.pbf \
  r/route=hiking,foot,mtb w/highway=path,footway,steps,track \
  -o data/work/hiking.osm.pbf --overwrite
# 转 GeoJSON（osmium export）后 tippecanoe -z14 → hiking.pmtiles
```
需要保留的属性：`name`, `ref`, `network`(iwn/nwn/rwn), `highway`, `sac_scale`, `trail_visibility`, `route`。

**转 PMTiles**：`pmtiles convert osm.mbtiles osm.pmtiles`（go-pmtiles）或用 Rust `pmtiles` crate。

### 5.3 `dem.pmtiles` — 地形高度场（terrarium 编码，z0–z12，约 350–450 MB）

Rust bin `dem2tiles`：
1. `gdalbuildvrt` 把 81 片 COG 拼成一个 VRT；
2. `gdalwarp -t_srs EPSG:3857 -tr 26 26 -r cubic -of COG -co COMPRESS=DEFLATE` 得到一张 ~3850×... 的 3857 大图（30 m 原生，Mercator 下取 26 m 可保证赤道到 30° 不丢精度）；
3. 逐 z 逐 tile 用 `gdal` crate 的 `RasterBand::read_as` 读窗口（**读窗口必须比 256×256 大 3 px 用于双线性**），双线性重采样到 256×256；
4. 编码 **terrarium**：`h = clamp(round(elev*256)+32768, 0, 65535)`；`R = h>>8`, `G = h&255`, `B = round(frac*256)`；解码公式 `elev = R*256 + G + B/256 - 32768`。
   （精度 1/256 m ≈ 4 mm，足够；海拔钳制到 [-500, 9000]）
5. PNG 输出，`rayon` 并行，写入瓦片金字塔 → 打包成 `dem.pmtiles`。

**maxzoom 锁死 z12**。z13 以上让 MapLibre 自动 overzoom。理由：z13 已是 19 m/px，30 m 源数据在 z12 之后没有新信息，多做一层只多 4 倍体积换 0 收益。

### 5.4 `relief.pmtiles` — 烘焙户外底色（z0–z13，约 500–700 MB）★ 画质关键

**这是整个项目画质的核心。** MapLibre 内置的 `hillshade` 图层可控性差、低 LOD 会糊，所以底色在离线阶段自己画好，运行时只当一张「贴在地形上的颜色图」。

Rust bin `bake-relief`，逐 z13 tile 输出 RGB PNG：

```
base = landcover_color(WorldCover class, 该像素)
base = mix(base, hypsometric_tint(elev), 0.35)          # 高程色带微调
base *= (0.55 + 0.45 * slope_shade(normal, sun))        # 主光晕渲
base *= (1 - 0.25 * concavity)                          # 凹地/沟谷压暗（AO 近似）
relief = base * (1 + 0.12 * noise(u,v))                 # 极轻的纹理噪声，去"塑料感"
最后乘一个全局 saturation 0.9 的降饱和，避免颜色过艳
```

- **landcover_color**：WorldCover 类别 → 户外配色的**明度变体**（森林内部要有深浅变化，不能是一块死绿。用 `noise + 高程 + 坡度` 在 ±8% 明度内扰动）。
- **hypsometric_tint**：<2500 m 偏黄绿；2500–4000 m 偏冷绿；4000–4800 m 过渡到灰褐裸岩；>4800 m 偏白（雪线附近用高程+坡度混合，陡壁不积雪）。
- **slope_shade**：多方向晕渲（sum of 4 个方位角的 hillshade，归一化），比单光源自然得多，这是「像户外地图」的关键。
- **concavity**：DEM 与 11×11 均值滤波之差，负值为沟谷。
- **WorldCover 覆盖不到的水体**：`class==80` 直接画湖色；OSM 水系矢量会在上面再压一层，两者要对齐（都从同一 DEM/水系来源，误差 < 1 像素即可）。

同一套 tile 网格（z/x/y）、同一投影（EPSG:3857），保证与 DEM 完美对齐。

### 5.5 `contours.pmtiles` — 等高线（可选，Phase 3，约 150–250 MB）
Rust bin `contours`，marching squares 从 DEM 生成。**关键：采样窗口必须每边多留 16 px 的 buffer**，否则瓦片边界处等高线会断开。
间隔随 zoom：z9–11 → 500 m；z12–13 → 200 m；z14 → 100 m；z15 → 50 m。每 5 条为计曲线（加粗、加深）。
输出属性：`ele`（整米）、`idx`（boolean，是否计曲线）。

### 5.6 字体字形（必需，中文）
MapLibre 需要 `glyphs` PBF（0–65535 分 256 一段）。用 `fontnik` / MapLibre 官方 font 工具从 **Noto Sans SC Regular + Bold** 生成，放 `public/fonts/{NotoSansSC-Regular,NotoSansSC-Bold}/{0-255}.pbf`。
开发期可临时指向公网 glyph CDN，**但交付前必须本地化**（硬性约束 2）。

---

## 6. 前端

### 6.1 关键代码骨架

```ts
import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.addProtocol('pmtiles', new Protocol().tile);

const map = new maplibregl.Map({
  container: 'map',
  style: '/style.json',
  center: [101.8, 31.0], zoom: 4.2, pitch: 0, maxPitch: 85,
  maxZoom: 18, minZoom: 1,
  hash: true,
  maxTileCacheSize: 800,
  fadeDuration: 0,
  attributionControl: { compact: true },
});

map.on('load', () => {
  map.setTerrain({ source: 'dem', exaggeration: 1.3 });
  map.setLight({ anchor: 'viewport', position: [1.5, 90, 80] });
});
```

### 6.2 style.json 要点

```json
{
  "version": 8,
  "projection": { "type": "globe" },
  "glyphs": "/fonts/{fontstack}/{range}.pbf",
  "sources": {
    "world":  { "type": "vector", "url": "pmtiles:///data/world.pmtiles",  "maxzoom": 6 },
    "dem":    { "type": "raster-dem", "url": "pmtiles:///data/dem.pmtiles", "encoding": "terrarium", "tileSize": 256, "maxzoom": 12 },
    "relief": { "type": "raster", "url": "pmtiles:///data/relief.pmtiles", "tileSize": 256, "maxzoom": 13 },
    "osm":    { "type": "vector", "url": "pmtiles:///data/osm.pmtiles" },
    "hiking": { "type": "vector", "url": "pmtiles:///data/hiking.pmtiles" }
  },
  "terrain": { "source": "dem", "exaggeration": 1.3 }
}
```

**图层顺序（从下到上，必须照此序）**：
```
1  background            海洋深蓝
2  ocean fill (world)    海洋
3  land fill (world)     陆地中性底色
4  relief  raster        ← 川西户外底色（opacity 1，其余区域自动透明）
5  hillshade (world? 不需要；靠 relief 自带)
6  water fill (osm)      湖泊/水库/冰川（class: lake / glacier）
7  waterway line (osm)   河流
8  contour line          等高线（可选）
9  boundary line (world) 国界/省界
10 road casing + road    高速 → 国道 → 省道 → 县道 → 乡道
11 trail line (hiking)   徒步小径（虚线）
12 place symbol          城市/镇/村/乡
13 peak symbol (osm)     山峰
14 poi symbol (hiking)   宿营地/山屋/垭口/观景台
15 text labels (road)    道路编号
```

> terrain 与 globe 可以共存（v6 已稳定）。zoom < 5.5 时 exaggerated 地形在球面上自然显现；zoom ≥ 6 时 MapLibre 自动 globe→mercator 过渡，不做任何干预。

### 6.3 配色（直接照抄，不要自己发挥）

| 要素 | 颜色 | 线宽 / 说明 |
|---|---|---|
| 海洋 | `#1E4E6B` | — |
| 湖泊/水库 | `#A9D3E8` | — |
| 冰川/雪 | `#F2F6F8` | — |
| 河流 | `#7FB8D4` | 1.0 → 4.0 px（按 `waterway` stream/river/ canal） |
| 森林 | `#2E6B3E` 深绿 | 内部带 8% 明度扰动 |
| 针叶林/密林 | `#24552F` | — |
| 草甸/草地 | `#9FC97A` 浅绿 | — |
| 高山草甸 | `#B9C98A` | — |
| 农田 | `#E8E4C0` | — |
| 裸岩/碎石 | `#B9B2A6` | — |
| 沙/荒漠 | `#E3D2A3` 黄 | — |
| 建成区 | `#EDE6DA` | 只做底色块，不画建筑 |
| 高速 | `#E8734A` | casing `#C0552F` +2 px；z8 起 1.2 px → z16 8 px |
| 国道 | `#D9A441` | casing `#A87A28` +1.5 px |
| 省道 | `#C9B45C` | casing `#9C8A3E` +1 px |
| 县道 | `#B9A98C` | — |
| 乡道/无名 | `#FFFFFF` | casing `#B0B0B0` |
| 徒步小径 `path/footway` | `#B4552E` | 2 px，`line-dasharray: [2, 2]`，**z12 起显示** |
| 徒步 `track` | `#8B6B4A` | 1.6 px 虚线，z13 起 |
| 等高线 | `#B49A7A` | 0.8 px，opacity 0.35；计曲线 1.4 px / 0.6 |
| 行政边界 | `#8A7A9A` | 1 px 虚线，opacity 0.7 |
| 标注文字 | `#3A3A3A`，halo `#FFFFFF` | halo-width 1.8 |

### 6.4 标注规则（「细节多但字不糊脸」靠规则，不靠砍数据）

- **分级出点**：`place=city` z≥5 / `town` z≥8 / `village` z≥11 / `hamlet` z≥13。
- **碰撞避让全部开启**：`text-allow-overlap: false`、`text-ignore-placement: false`、`text-padding: 4`。
- **优先级排序**：`symbol-sort-key` = `city 0 / town 1 / village 2 / hamlet 3 / peak 4 / hut 5`。让重要标注抢位置，次要的自动消失。
- **点标注自动挪位**：`text-variable-anchor: ["top","bottom","left","right"]` + `text-radial-offset: 0.8`。
- **道路编号**：`symbol-placement: line`、`text-rotation-alignment: map`、`symbol-spacing: 350`、只出 `trunk/primary/secondary` 的 `ref`。
- **徒步小径名**：z≥14 才出，`text-size` 10，颜色 `#8A4A2E`。
- **山峰**：三角形 symbol + `name` + `ele`（米），z≥10。
- **每级视野内标注硬上限 40 个**：超过说明 minzoom 设错，回头调 `minzoom` 而不是加过滤。
- 字体一律 `Noto Sans SC`，标题 Bold、正文 Regular。

### 6.5 UI

- **右侧抽屉「图层」**，分组 + 复选框 + 透明度滑块：
  `地形 3D（含夸张度 1.0–2.0 滑块）` / `晕渲底色` / `等高线` / `徒步线路` / `水系` / `道路` / `地名` / `山峰与营地` / `行政边界`
- 状态写 `localStorage`，刷新后恢复。
- 左上角信息条：**鼠标位置经纬度 + 该点海拔（从 DEM 读）+ 当前 zoom**。海拔用 `map.queryTerrainElevation(lngLat)`。
- 比例尺（`ScaleControl`）、指北针、全屏、`NavigationControl`（含 pitch 与 rotate）。
- 快捷键：`T` 切地形、`H` 切图层抽屉、`Esc` 关面板。
- 界面语言：中文。
- 页面加载后 3 秒内必须看到地球（首屏只加载 world + 低 zoom 瓦片）。

### 6.6 性能要求

- 目标：1080p / 780M / **≥ 50 fps**（连续拖动时），静止 idle 时不掉帧。
- 手段：`maxTileCacheSize: 800`；`fadeDuration: 0`；`pixelRatio` 上限 2；避免 `line-blur` / `text-halo-blur`（这两个在 drape 到地形时开销大）；图层总数控制在 25 以内。
- **不做 service worker 全量缓存**（会 OOM）。
- 加一个可开关的 FPS 显示（`map.on('render')` 计时），不要用第三方库。

### 6.7 本地开发/运行

**必须用支持 HTTP Range 的静态服务器**，PMTiles 依赖 Range 请求：
```bash
npx serve public -l 5173      # ✅ 支持 Range
# ❌ 绝对不要用 python3 -m http.server（不支持 Range，PMTiles 会整文件拉进内存）
```
提供 `pnpm dev`（Vite，注意配置 `server.fs.allow`）与 `pnpm serve`（静态产物）两个脚本，并在 README 里写明必须走 `pnpm serve` 验证。

---

## 7. 实施顺序（每阶段有验收，不要跳）

### P0 — 技术验证 spike（半天，**先做这个再写生产代码**）
不写自己的管线，直接用公开的 terrain-RGB DEM 瓦片 + 一个开源矢量 style，跑 `map.setTerrain()` + `projection: globe`。
**目的**：在 780M 上实测「球 + 3D 地形 + 矢量叠加」的帧率和观感，确认它能不能到你要的画质。
**产出**：`SPIKE.md`，含 3 张截图（球体 / z12 山体 / z15 小径）+ 实测 FPS + 一句结论：「继续 MapLibre」或「必须自研渲染器」。
> 若结论是后者：停下来，写报告，不要硬做。

### P1 — 全链路跑通（1–2 天）
world / osm / dem 三个 pmtiles 产出 → 前端能以 3D 地形显示 → 道路、水系、地名出来 → 球体可自由旋转 → 能 zoom 到贡嘎。
底色先用 **MapLibre 内置 `hillshade` 图层**顶替（`hillshade-method: "multidirectional"`），不要等烘焙。
**验收**：`pnpm serve` 打开 → 3 秒见地球 → 拖到川西 → 开地形 → 山体有立体感 → 无 console 报错。

### P2 — 画质与内容（2–3 天）
`relief.pmtiles` 烘焙并替换掉内置 hillshade → 徒步线路层 → 图层面板 + 状态持久 → 标注规则调优 → 鼠标海拔读数。
**验收**：截图在视觉上接近 Outdooractive / LocusMap 的户外风格（分层设色正确、山脊有明暗、森林不是一块死绿、水体颜色鲜亮）。

### P3 — 打磨（可选）
等高线 → 全球底图观感（球体大气层 / 星空背景可用 `sky`）→ 目的地快捷跳转 → 性能 profile 与优化。

---

## 8. 目录结构

```
customMap/
├─ README.md                    # 一键跑通说明（含数据获取、依赖安装、Range 服务器警告）
├─ NOTES.md                     # 决策记录、踩坑、降级方案
├─ SPIKE.md                     # P0 结论
├─ package.json                 # scripts: dev / build / serve
├─ tsconfig.json / vite.config.ts
├─ pipeline/                    # 全部可重跑的离线脚本
│  ├─ 00-fetch-osm.sh
│  ├─ 01-fetch-dem.sh           # 81 片，带重试与断点续传
│  ├─ 02-fetch-worldcover.sh    # 12 片
│  ├─ 03-osm-to-pmtiles.sh      # osmium + planetiler + pmtiles
│  ├─ 04-hiking.sh              # osmium tags-filter + tippecanoe
│  ├─ 05-world.sh               # Natural Earth + tippecanoe
│  ├─ 06-dem.sh                 # gdal buildvrt/warp
│  └─ 07-pmtiles.sh             # 汇总打包
├─ rust/
│  └─ geotiles/                 # crate
│     ├─ src/bin/dem2tiles.rs
│     ├─ src/bin/bake-relief.rs
│     ├─ src/bin/contours.rs
│     └─ src/{tile,dem,encode,landcover,shade}.rs
├─ src/                         # 前端
│  ├─ main.ts
│  ├─ layers.ts                 # 图层定义与开关
│  ├─ ui/{panel.ts,hud.ts}
│  └─ style/style.json
├─ public/
│  ├─ data/{world,osm,dem,relief,hiking}.pmtiles
│  └─ fonts/{NotoSansSC-Regular,NotoSansSC-Bold}/*.pbf
└─ tests/                       # 见 §9
```

---

## 9. 必须写的自动化检查（`tests/`，可用 node 脚本而非测试框架）

1. `check-bbox.mjs`：所有 pmtiles 的 `min_zoom` / `max_zoom` / bounds 打印出来，与 bbox `[96,26,105,35]` 比对。
2. `check-dem.mjs`：随机抽 200 个川西已知点（贡嘎 7556 m、四姑娘山 6250 m、成都 ~500 m、稻城 ~3750 m），从 `dem.pmtiles` 解码取高程，**误差 > 50 m 即报错**（terrarium 编码/瓦片对齐错了会立刻暴露）。
3. `check-align.mjs`：取一个湖泊的 OSM 面中心点，比对 `relief` 图在该点的颜色是否落在水色区间 → 验证栅格与矢量对齐。
4. `check-size.mjs`：`du -sb public/data` ≤ 2.5 GB。
5. `check-no-gcj.mjs`：全仓 grep `gcj|bd09|wgs84to`，命中即失败。

---

## 10. 明确的坑（照做，否则会浪费一天）

1. **PMTiles 必须走 Range 服务器**。Vite dev server 可以，`python3 -m http.server` 不行。
2. **`raster-dem` 的 `maxzoom` 一定要写**，且 ≤ 实际产出最大 z，否则 MapLibre 会请求不存在的瓦片并静默返回 0 高程 → 山体变平地。
3. **等高线跨瓦片断裂**是经典 bug，唯一可靠解法是采样时留 buffer，不是后处理缝合。
4. **地形开启后所有矢量图层会被 drape（渲染到纹理）**，图层越多越卡。如果 P1 阶段掉到 30 fps，先减图层数，不要先怪 DEM。
5. **globe + terrain 时瓦片缓存会翻倍**（球面和 mercator 各一套），`maxTileCacheSize` 不要设太小（< 300 会频繁重载导致闪烁）。
6. **`text-allow-overlap: false` 必须逐层显式写**，默认值有例外（`symbol-placement: line` 时行为不同）。
7. **gdalwarp 的 `-tr` 单位是目标 CRS 的米**，在 EPSG:3857 里 26 m 不等于地面 26 m（随纬度收缩），取 26 是为了在 30°N 附近刚好约等于 30 m 地面分辨率。
8. **WorldCover 的 tile 命名用 SW 角且按 3° 网格**，别按 1° 拼。
9. **planetiler 需要 JDK 21+**，本机是 25，OK；但内存要给足（`-Xmx24g`）。
10. **OSM 在中国的 landcover 覆盖极差**。所以底色绝不能用 OSM polygon，必须用 WorldCover。OSM 只负责线、水系面、道路、POI、地名。

---

## 11. 不要做的事（重要，避免走弯路）

- ❌ 不要用 **CesiumJS**：它的强项是 3D Tiles + 影像，矢量样式能力弱，做户外矢量风格要跟 3D Tiles 打架。
- ❌ 不要用 **Three.js 自研渲染器**：标注碰撞避让、LOD 缝合、drape、命中检测，自己写要 3–6 个月，且一定不如 MapLibre。**除非 P0 spike 的结论是 MapLibre 画质不可接受**。
- ❌ 不要用 **Mapbox GL JS**（v2+ 许可非开源）。
- ❌ 不要做 **WebGPU**（v6 只走 WebGL2，够用）。
- ❌ 不要做 **实时卫星影像**、不要做 **建筑 3D**、不要做 **商业 POI**。
- ❌ 不要做 **全球高精度 DEM**（全球 30 m 约 1 TB，物理上不可行）。低 zoom 靠 Natural Earth + 平涂，川西以外不提供地形，接受这个边界。
- ❌ 不要写 **GCJ-02 相关任何代码**。
- ❌ 不要用 **python3 -m http.server** 验证。

---

## 12. 交付物

1. 可 `pnpm install && pnpm dev` 直接运行的完整仓库。
2. `pipeline/` 下一键重跑的数据管线（换 bbox 即可换区域）。
3. `public/data/` 下 5 个 pmtiles（总量 ≤ 2.5 GB）。
4. `README.md`：依赖安装（含 rustup / tippecanoe / planetiler / go-pmtiles）、数据下载、管线执行顺序、启动方式、**Range 服务器警告**。
5. `NOTES.md`：每处偏离本文档的实现决定 + 原因。
6. 截图 6 张：地球全景、川西 z7、贡嘎 z12 带地形、z15 徒步小径、图层抽屉打开、地形关闭对比。

---

## 13. 开始前若真有阻塞，只允许就这三件事来问

1. Geofabrik 下载不通时用哪个镜像（先试 openstreetmap.fr，再试 bbbike 定制导出）。
2. 中文 glyph 生成工具链装不上时，是否接受用公网 glyph CDN 但仅限开发期。
3. P0 spike 的结论若是「MapLibre 画质不够」，是否切换到自研渲染器。

其他一切按本文档执行。
