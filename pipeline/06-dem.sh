#!/usr/bin/env bash
# 06-dem.sh — DEM COG 拼接 + 重投影到 EPSG:3857 (26m)，产出 data/work/dem_3857.tif
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

BBOX="${1:-96.0,26.0,105.0,35.0}"
IFS=',' read -r MINX MINY MAXX MAXY <<< "$BBOX"

RAW="data/raw/dem"
WORK="data/work"
mkdir -p "$WORK"

ls "$RAW"/*.tif >/dev/null 2>&1 || { echo "[06] no DEM tiles in $RAW"; exit 1; }

if [ ! -s "$WORK/dem_merged.vrt" ]; then
  gdalbuildvrt "$WORK/dem_merged.vrt" "$RAW"/*.tif
fi

if [ ! -s "$WORK/dem_3857.tif" ]; then
  gdalwarp -t_srs EPSG:3857 -tr 26 26 -r cubic -multi -wo NUM_THREADS=ALL_CPUS \
    -te "$MINX" "$MINY" "$MAXX" "$MAXY" -te_srs EPSG:4326 \
    -of COG -co COMPRESS=DEFLATE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=YES \
    -overwrite "$WORK/dem_merged.vrt" "$WORK/dem_3857.tif"
fi
# WorldCover → 同一 3857 网格（最近邻，保类别码），供 bake-relief 使用
WC="data/raw/worldcover"
if ls "$WC"/*.tif >/dev/null 2>&1; then
  if [ ! -s "$WORK/worldcover_merged.vrt" ]; then
    gdalbuildvrt "$WORK/worldcover_merged.vrt" "$WC"/*.tif
  fi
  if [ ! -s "$WORK/worldcover_3857.tif" ]; then
    gdalwarp -t_srs EPSG:3857 -tr 26 26 -r near -multi -wo NUM_THREADS=ALL_CPUS \
      -te "$MINX" "$MINY" "$MAXX" "$MAXY" -te_srs EPSG:4326 \
      -of COG -co COMPRESS=DEFLATE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=YES \
      -overwrite "$WORK/worldcover_merged.vrt" "$WORK/worldcover_3857.tif"
  fi
  echo "[06] worldcover: $(du -h "$WORK/worldcover_3857.tif" | cut -f1)"
fi

echo "[06] done: $(du -h "$WORK/dem_3857.tif" | cut -f1)"
