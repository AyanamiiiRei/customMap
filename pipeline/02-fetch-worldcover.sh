#!/usr/bin/env bash
# 02-fetch-worldcover.sh — 下载 ESA WorldCover 10m v2021（3°×3° 网格，SW 角命名）
# 每片 ~104MB，片内 8 段并行，2 片并发
# 用法: ./pipeline/02-fetch-worldcover.sh [bbox]
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

BBOX="${1:-$REGION_BBOX}"
IFS=',' read -r MINX MINY MAXX MAXY <<< "$BBOX"
RAW="data/raw/worldcover"
mkdir -p "$RAW"

LAT0=$(python3 -c "import math;print(int(math.floor(float('$MINY')/3)*3))")
LAT1=$(python3 -c "import math;print(int(math.ceil(float('$MAXY')/3)*3))")
LON0=$(python3 -c "import math;print(int(math.floor(float('$MINX')/3)*3))")
LON1=$(python3 -c "import math;print(int(math.ceil(float('$MAXX')/3)*3))")

fetch_one() {
  local lat="$1" lon="$2"
  local nlat elon base url out
  nlat=$(printf "N%02d" "$lat")
  elon=$(printf "E%03d" "$lon")
  base="ESA_WorldCover_10m_2021_v200_${nlat}${elon}_Map"
  url="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/${base}.tif"
  out="$RAW/${base}.tif"
  if [ -s "$out" ]; then
    local want have
    want=$(curl -sIL --max-time 30 "$url" | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
    have=$(stat -c%s "$out")
    if [ -n "$want" ] && [ "$want" = "$have" ]; then return 0; fi
    echo "[resize] $base have=$have want=$want, redownload"
    rm -f "$out"
  fi
  local code
  code=$(curl -sI -o /dev/null -w "%{http_code}" --max-time 30 "$url" || echo "000")
  # 本区域全陆地，HEAD 404 实测多为假（S3 限流误判），一律留到下轮重试
  if [ "$code" != "200" ]; then echo "[probe-$code] $base (skip this round)"; return 0; fi
  echo "[get] $base"
  bash pipeline/fetch-fast.sh "$url" "$out" 8 || { rm -f "$out"; echo "[fail] $base"; }
}
export -f fetch_one
export RAW

for ((lat=LAT0; lat<LAT1; lat+=3)); do
  for ((lon=LON0; lon<LON1; lon+=3)); do
    printf "%s %s\n" "$lat" "$lon"
  done
done | xargs -P 2 -n 2 bash -c 'fetch_one "$@"' _

echo "[02] done. tiles: $(ls "$RAW"/*.tif 2>/dev/null | wc -l), missing: $(ls "$RAW"/*.missing 2>/dev/null | wc -l)"
