#!/usr/bin/env bash
# 05-world.sh — Natural Earth 1:50m → world.pmtiles (z0-z6)
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

RAW="data/raw/ne"
WORK="data/work/ne"
mkdir -p "$RAW" "$WORK"

BASE="https://naturalearth.s3.amazonaws.com"
SETS=(
  "50m_physical/ne_50m_land"
  "50m_physical/ne_50m_ocean"
  "50m_physical/ne_50m_lakes"
  "50m_physical/ne_50m_rivers_lake_centerlines"
  "50m_cultural/ne_50m_admin_0_countries"
)

for s in "${SETS[@]}"; do
  name=$(basename "$s")
  if [ ! -s "$RAW/$name.zip" ]; then
    curl -fL --retry 5 -o "$RAW/$name.zip" "$BASE/$s.zip"
  fi
  unzip -o -q "$RAW/$name.zip" -d "$RAW/$name"
done

shp2json() {
  local name="$1"
  if [ ! -s "$WORK/$name.json" ]; then
    ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$WORK/$name.json" "$RAW/$name/$name.shp"
  fi
}
for s in "${SETS[@]}"; do shp2json "$(basename "$s")"; done

if [ ! -s public/data/world.pmtiles ]; then
  tippecanoe -o "$WORK/world.mbtiles" -Z0 -z6 --no-tile-size-limit --force \
    -L land:"$WORK/ne_50m_land.json" \
    -L ocean:"$WORK/ne_50m_ocean.json" \
    -L lakes:"$WORK/ne_50m_lakes.json" \
    -L rivers:"$WORK/ne_50m_rivers_lake_centerlines.json" \
    -L countries:"$WORK/ne_50m_admin_0_countries.json"
  pmtiles convert "$WORK/world.mbtiles" public/data/world.pmtiles
fi
echo "[05] done: $(du -h public/data/world.pmtiles | cut -f1)"
