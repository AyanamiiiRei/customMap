#!/usr/bin/env bash
# fetch-all.sh — 一键重跑全部数据管线（川西 bbox，约 7GB 下载，耗时数小时）
# 用法: bash pipeline/fetch-all.sh [bbox]     例: bash pipeline/fetch-all.sh "96.0,26.0,105.0,35.0"
# 幂等：已存在且完整的中间产物/产物自动跳过，中断后重跑即可续。
set -euo pipefail
cd "$(dirname "$0")/.."
BBOX="${1:-96.0,26.0,105.0,35.0}"

step() { echo; echo "════════ $* ════════"; }

# ── 0. 工具链自检 ──────────────────────────────────────────────
step "0. 工具链"
source pipeline/env.sh
missing=0
for c in osmium tippecanoe ogr2ogr gdalwarp java; do
  command -v $c >/dev/null || { echo "  缺 $c → 见 README「依赖安装」（micromamba 一把装）"; missing=1; }
done
[ -x tools/pmtiles ] || echo "  缺 tools/pmtiles（go-pmtiles release）"
[ -s tools/planetiler.jar ] || echo "  缺 tools/planetiler.jar（03 脚本会自动下）"
[ -x rust/geotiles/target/release/dem2tiles ] || echo "  缺 rust 二进制 → cd rust/geotiles && cargo build --release"
[ "$missing" = 1 ] && echo "  ↑ 请先补齐再继续（不会阻塞已满足的步骤）"

# ── 1. 下载原始数据（最大头，可中断续传）─────────────────────────
step "1. OSM 下载+裁切（~1.8GB）"
bash pipeline/00-fetch-osm.sh "$BBOX"

step "2. DEM 81 片（~3.5GB）"
bash pipeline/01-fetch-dem.sh "$BBOX"
bash pipeline/01b-fetch-dem-rev.sh "$BBOX"   # 反向再扫一遍补齐漏网

step "3. WorldCover 12 片（~1.2GB）"
bash pipeline/02-fetch-worldcover.sh "$BBOX"

step "4. planetiler 辅助数据（~1.4GB）"
bash pipeline/03b-fetch-planetiler-sources.sh

# ── 2. 矢量产物 ────────────────────────────────────────────────
step "5. world.pmtiles（Natural Earth）"
bash pipeline/05-world.sh

step "6. osm.pmtiles（planetiler，~30min）"
bash pipeline/03-osm-to-pmtiles.sh

step "7. hiking.pmtiles（徒步线路）"
bash pipeline/04-hiking.sh

# ── 3. 栅格产物 ────────────────────────────────────────────────
step "8. DEM 拼接重投影"
bash pipeline/06-dem.sh "$BBOX"

step "9. dem.pmtiles（terrarium z0-12）"
export GDAL_HOME="$PWD/tools/mambaenv"
rust/geotiles/target/release/dem2tiles \
  --input data/work/dem_3857.tif --output data/work/dem.mbtiles --minzoom 0 --maxzoom 12
tools/pmtiles convert data/work/dem.mbtiles public/data/dem.pmtiles

step "10. relief.pmtiles（烘焙户外底色 z0-13, webp）"
# --feather-meters：边缘 60km 内向全球粗底色带过渡，避免和 relief-world 拼出矩形色差
rust/geotiles/target/release/bake-relief \
  --dem data/work/dem_3857.tif --landcover data/work/worldcover_3857.tif \
  --output data/work/relief.mbtiles --minzoom 0 --maxzoom 13 --format webp --feather-meters 60000
tools/pmtiles convert data/work/relief.mbtiles public/data/relief.pmtiles

# ── 4. 可选：等高线 ─────────────────────────────────────────────
step "11. contours.pmtiles（等高线，可选）"
bash pipeline/09-contours.sh || echo "  等高线失败（非致命，可跳过）"

# ── 5. 字形 ────────────────────────────────────────────────────
step "12. 中文字形"
bash pipeline/08-glyphs.sh

# ── 6. 校验 ────────────────────────────────────────────────────
step "12a. 搜索索引（OSM → search.json）"
bash pipeline/11-search.sh

step "12b. 全球粗底（ETOPO，z0-7）"
bash pipeline/10-world-relief.sh

step "13. 自动化检查"
node tests/check-bbox.mjs
node tests/check-dem.mjs
node tests/check-align.mjs
node tests/check-size.mjs
node tests/check-no-gcj.mjs

step "全部完成"
ls -lh public/data/
echo "启动: npm run dev (http://localhost:5271) 或 npm run serve (http://localhost:5272)"
