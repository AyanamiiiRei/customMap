#!/usr/bin/env bash
# 09-contours.sh — 等高线（Phase 3 可选）：Rust contours → 4 层 geojsonl → tippecanoe → tile-join → pmtiles
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

WORK="data/work"
BIN="rust/geotiles/target/release/contours"
mkdir -p "$WORK/contours"

[ -s "$WORK/dem_3857.tif" ] || { echo "[09] missing $WORK/dem_3857.tif"; exit 1; }
[ -x "$BIN" ] || { echo "[09] missing $BIN (cargo build --release)"; exit 1; }

# 分层间隔: z9-11→500m, z12-13→200m, z14→100m, z15→50m
if ! ls "$WORK"/contours/contours-z9.geojsonl >/dev/null 2>&1; then
  "$BIN" --dem "$WORK/dem_3857.tif" --output "$WORK/contours/contours.geojsonl" --bbox "$REGION_BBOX"
fi

tippecanoe -o "$WORK/contours/c-z9.mbtiles"  -z11 -Z9  --force --no-feature-limit --simplify-only-low-zooms -L contours:"$WORK/contours/contours-z9.geojsonl"
tippecanoe -o "$WORK/contours/c-z12.mbtiles" -z13 -Z12 --force --no-feature-limit -L contours:"$WORK/contours/contours-z12.geojsonl"
tippecanoe -o "$WORK/contours/c-z14.mbtiles" -z14 -Z14 --force --no-feature-limit -L contours:"$WORK/contours/contours-z14.geojsonl"
# 注: z15(50m) 全域等高线体积失控(>1.4GB)，按体量控制砍掉；z14(100m) 覆盖最详细层级
tile-join -o "$WORK/contours.mbtiles" --force \
  "$WORK/contours/c-z9.mbtiles" "$WORK/contours/c-z12.mbtiles" \
  "$WORK/contours/c-z14.mbtiles"

pmtiles convert "$WORK/contours.mbtiles" public/data/contours.pmtiles
echo "[09] done: $(du -h public/data/contours.pmtiles | cut -f1)"
