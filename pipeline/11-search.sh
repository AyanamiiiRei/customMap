#!/usr/bin/env bash
# 11-search.sh — 从 OSM 抽取可搜索要素 → public/data/search.json
#
# 类别：城市/镇/村/片区、山峰、垭口、山屋、营地、观景台、湖泊、河流、步道、道路
# 输出是给前端 ⌘K 搜索用的紧凑 columnar JSON（约 2.7 MB / 4.6 万条）。
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

RAW="data/raw/chuanxi.osm.pbf"
WORK="data/work"
OUT="public/data/search.json"
PY="tools/mambaenv/bin/python"
[ -x "$PY" ] || PY=python3

[ -s "$RAW" ] || { echo "[11] 缺 $RAW（先跑 00-fetch-osm.sh）"; exit 1; }
mkdir -p "$WORK"

echo "[11] 抽取要素"
osmium tags-filter "$RAW" \
  nw/place=city,town,village,hamlet,suburb,quarter,neighbourhood,locality,isolated_dwelling \
  nw/natural=peak,saddle nw/mountain_pass=yes \
  nw/tourism=alpine_hut,wilderness_hut,camp_site,viewpoint \
  w/natural=water r/natural=water w/waterway=river \
  w/highway=motorway,trunk,primary,secondary,path,track,footway \
  nw/historic nw/tourism=museum,attraction,gallery,artwork,zoo,theme_park,information \
  nw/amenity=place_of_worship,university,college \
  nw/building=monastery,temple,church,cathedral,chapel,shrine \
  nw/landuse=religious \
  nw/leisure=nature_reserve,park,garden \
  nw/boundary=protected_area,national_park r/boundary=protected_area,national_park \
  nw/railway=station,halt,tram_stop nw/aeroway=aerodrome \
  nw/landuse=reservoir nw/water=reservoir \
  nw/landuse=winter_sports nw/piste:type \
  -o "$WORK/search.osm.pbf" --overwrite --no-progress

echo "[11] 导出 geojsonseq"
osmium export "$WORK/search.osm.pbf" -f geojsonseq -o "$WORK/search.geojson" --overwrite --no-progress

echo "[11] 建索引"
"$PY" pipeline/11-search-index.py "$WORK/search.geojson" "$OUT"

ls -lh "$OUT"
