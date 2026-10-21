#!/usr/bin/env bash
# 03-osm-to-pmtiles.sh — planetiler (OpenMapTiles profile) → osm.pmtiles
# 用法: ./pipeline/03-osm-to-pmtiles.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

IN="data/raw/chuanxi.osm.pbf"
WORK="data/work"
mkdir -p "$WORK"

if [ ! -s tools/planetiler.jar ]; then
  echo "[03] downloading planetiler"
  bash pipeline/fetch-fast.sh \
    "https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar" \
    tools/planetiler.jar 8
fi

[ -s "$IN" ] || { echo "[03] missing $IN"; exit 1; }

# planetiler 辅助数据需预先就位（其自带下载器在本网络超时）：
#   data/sources/water-polygons-split-3857.zip   (osmdata.openstreetmap.de)
#   data/sources/lake_centerline.shp.zip         (github acalcutt/osm-lakelines v12)
#   data/sources/natural_earth_vector.sqlite.zip (naciscdn.org)
for f in water-polygons-split-3857.zip lake_centerline.shp.zip natural_earth_vector.sqlite.zip; do
  [ -s "data/sources/$f" ] || { echo "[03] missing data/sources/$f"; exit 1; }
done

if [ ! -s "$WORK/osm.mbtiles" ]; then
  java -Xmx24g -jar tools/planetiler.jar \
    --osm-path="$IN" \
    --output="$WORK/osm.mbtiles" --force \
    --bounds=96.0,26.0,105.0,35.0
fi

if [ ! -s public/data/osm.pmtiles ]; then
  pmtiles convert "$WORK/osm.mbtiles" public/data/osm.pmtiles
fi
echo "[03] done: $(du -h public/data/osm.pmtiles | cut -f1)"
