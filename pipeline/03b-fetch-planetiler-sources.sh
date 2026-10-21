#!/usr/bin/env bash
# 03b-fetch-planetiler-sources.sh — 预下载 planetiler 辅助数据（其内置下载器在本网络会超时）
set -euo pipefail
cd "$(dirname "$0")/.."

bash pipeline/fetch-fast.sh \
  "https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip" \
  data/sources/water-polygons-split-3857.zip 16
bash pipeline/fetch-fast.sh \
  "https://github.com/acalcutt/osm-lakelines/releases/download/v12/lake_centerline.shp.zip" \
  data/sources/lake_centerline.shp.zip 8
bash pipeline/fetch-fast.sh \
  "https://naciscdn.org/naturalearth/packages/natural_earth_vector.sqlite.zip" \
  data/sources/natural_earth_vector.sqlite.zip 8
echo "[03b] sources ready"
