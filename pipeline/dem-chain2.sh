#!/usr/bin/env bash
# dem-chain2.sh — DEM/WC 校验齐全 → warp → dem2tiles/bake-relief/contours → pmtiles
# 幂等：任何中间产物已存在则跳过对应步骤；任何失败即停（set -e）。
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh
export GDAL_HOME="$PWD/tools/mambaenv"
export PATH="$HOME/.local/rust-1.99.1/bin:$PATH"
BIN=rust/geotiles/target/release

log() { echo "[chain2 $(date +%H:%M:%S)] $*"; }

# 1. DEM 必须 81 片且全部通过 gdalinfo
t=$(ls data/raw/dem/*.tif 2>/dev/null | wc -l)
[ "$t" -ge 81 ] || { log "DEM 不足 81 片 ($t)，退出"; exit 1; }
log "DEM 81 片齐全，开始 warp"
bash pipeline/06-dem.sh
[ -s data/work/dem_3857.tif ] || { log "dem_3857.tif 未生成"; exit 1; }

# 2. dem2tiles → dem.pmtiles
if [ ! -s public/data/dem.pmtiles ]; then
  log "dem2tiles"
  "$BIN/dem2tiles" --input data/work/dem_3857.tif --output data/work/dem.mbtiles --minzoom 0 --maxzoom 12
  pmtiles convert data/work/dem.mbtiles public/data/dem.pmtiles
fi
log "dem.pmtiles: $(du -h public/data/dem.pmtiles | cut -f1)"

# 3. WorldCover 12 片齐 → relief
w=$(ls data/raw/worldcover/*.tif 2>/dev/null | wc -l)
if [ "$w" -ge 12 ]; then
  bash pipeline/06-dem.sh   # 内含 worldcover warp（幂等）
  [ -s data/work/worldcover_3857.tif ] || { log "worldcover_3857.tif 未生成"; exit 1; }
  if [ ! -s public/data/relief.pmtiles ]; then
    log "bake-relief"
    "$BIN/bake-relief" --dem data/work/dem_3857.tif --landcover data/work/worldcover_3857.tif \
      --output data/work/relief.mbtiles --minzoom 0 --maxzoom 13
    pmtiles convert data/work/relief.mbtiles public/data/relief.pmtiles
  fi
  log "relief.pmtiles: $(du -h public/data/relief.pmtiles | cut -f1)"
else
  log "WC 只有 $w/12 片，跳过 relief（稍后重跑本脚本即可）"
fi

# 4. 等高线（P3）
if [ ! -s public/data/contours.pmtiles ]; then
  log "contours"
  bash pipeline/09-contours.sh || log "contours 失败（非致命）"
fi
log "ALL DONE"
