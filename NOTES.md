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
