#!/usr/bin/env bash
# dem-chain.sh — DEM 下载齐 → gdalwarp → dem2tiles → dem.pmtiles → bake-relief（WC 齐后）→ relief.pmtiles
set -uo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh
export GDAL_HOME="$PWD/tools/mambaenv"
export PATH="$HOME/.local/rust-1.99.1/bin:$PATH"
BIN=rust/geotiles/target/release

log() { echo "[chain $(date +%H:%M:%S)] $*"; }

# 1. 等 DEM 81 片齐；出现 missing 标记时先清掉重跑一轮（HEAD 假 404 的历史教训）
for round in $(seq 1 200); do
  t=$(ls data/raw/dem/*.tif 2>/dev/null | wc -l)
  m=$(ls data/raw/dem/*.missing 2>/dev/null | wc -l)
  log "dem tiles: $t + missing $m / 81 (round $round)"
  [ "$t" -ge 81 ] && break
  if [ $((t + m)) -ge 81 ] && [ "$m" -gt 0 ]; then
    log "clearing $m missing markers and re-fetching"
    rm -f data/raw/dem/*.missing
    bash pipeline/01-fetch-dem.sh >> logs/01-dem.log 2>&1 || true
  fi
  # 没有下载进程在跑时补启动一轮
  if ! pgrep -f "fetch-dem" >/dev/null; then
    log "no fetcher alive, starting another round"
    bash pipeline/01-fetch-dem.sh >> logs/01-dem.log 2>&1 || true
  fi
  sleep 60
done
log "DEM complete, warping"
bash pipeline/06-dem.sh

# 2. dem2tiles → dem.pmtiles
log "dem2tiles"
"$BIN/dem2tiles" --input data/work/dem_3857.tif --output data/work/dem.mbtiles --minzoom 0 --maxzoom 12
pmtiles convert data/work/dem.mbtiles public/data/dem.pmtiles
log "dem.pmtiles: $(du -h public/data/dem.pmtiles | cut -f1)"

# 3. 等 WorldCover 齐 → bake relief（P2）
for round in $(seq 1 60); do
  t=$(ls data/raw/worldcover/*.tif 2>/dev/null | wc -l)
  log "wc tiles: $t / 12 (round $round)"
  [ "$t" -ge 12 ] && break
  rm -f data/raw/worldcover/*.missing
  if ! pgrep -f "fetch-worldcover" >/dev/null; then
    log "no wc fetcher alive, starting another round"
    bash pipeline/02-fetch-worldcover.sh >> logs/02-wc2.log 2>&1 || true
  fi
  sleep 60
done
# 06 脚本后半段已 warp worldcover（dem_3857 存在时跳过 dem warp）
bash pipeline/06-dem.sh
log "bake-relief"
"$BIN/bake-relief" --dem data/work/dem_3857.tif --landcover data/work/worldcover_3857.tif --output data/work/relief.mbtiles --minzoom 0 --maxzoom 13
pmtiles convert data/work/relief.mbtiles public/data/relief.pmtiles
log "relief.pmtiles: $(du -h public/data/relief.pmtiles | cut -f1)"

# 4. 等高线（P3，顺带）
log "contours"
bash pipeline/09-contours.sh || log "contours failed (non-fatal)"
log "ALL DONE"
