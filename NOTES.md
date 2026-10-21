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

## 本机环境备忘
- 文件系统偶发瞬时 "没有那个文件或目录"（疑似网络盘），nohup 重定向失败时 touch 先建文件再重试即可。
- 5173 端口被别的项目（formusafe 9月27日残留 vite）占用 → 本项目用 5271。
- Rust 双份：~/.cargo（rustup, 清华镜像）+ ~/.local/rust-1.99.1（子代理手动装），geotiles 用后者构建。
