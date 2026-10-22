#!/usr/bin/env bash
# 00-fetch-osm.sh — 下载中国区 OSM 数据并裁切到研究区 bbox
# 用法: ./pipeline/00-fetch-osm.sh [bbox]
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

BBOX="${1:-$REGION_BBOX}"
RAW="data/raw"
mkdir -p "$RAW" data/work

URLS=(
  "https://download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf"
  "https://download.geofabrik.de/asia/china-latest.osm.pbf"
)

CHINA="$RAW/china-latest.osm.pbf"
if [ ! -s "$CHINA" ]; then
  ok=0
  for u in "${URLS[@]}"; do
    echo "[00] trying $u"
    if curl -fL --retry 5 --retry-delay 10 -C - -o "$CHINA" "$u"; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "[00] all OSM mirrors failed"; exit 1; }
else
  echo "[00] $CHINA exists, skip download"
fi

# 校验 PBF 完整性（下载不完整时 osmium 会直接报错）
echo "[00] china-latest.osm.pbf size: $(du -h "$CHINA" | cut -f1)"

if [ ! -s "$RAW/chuanxi.osm.pbf" ]; then
  echo "[00] extracting bbox $BBOX"
  osmium extract -b "$BBOX" "$CHINA" -o "$RAW/chuanxi.osm.pbf" \
    --strategy=complete_ways --overwrite
fi
echo "[00] done: $(du -h "$RAW/chuanxi.osm.pbf" | cut -f1)"
