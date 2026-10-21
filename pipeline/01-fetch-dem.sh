#!/usr/bin/env bash
# 01-fetch-dem.sh — 下载 Copernicus GLO-30 DEM 瓦片
# 每片 ~43MB，单连接极慢（~6KB/s），故每片内部 8 段并行（fetch-fast），4 片并发
# 用法: ./pipeline/01-fetch-dem.sh [bbox]
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

BBOX="${1:-96.0,26.0,105.0,35.0}"
IFS=',' read -r MINX MINY MAXX MAXY <<< "$BBOX"
RAW="data/raw/dem"
mkdir -p "$RAW"

LAT0=$(python3 -c "import math;print(math.floor(float('$MINY')))")
LAT1=$(python3 -c "import math;print(math.ceil(float('$MAXY')))")
LON0=$(python3 -c "import math;print(math.floor(float('$MINX')))")
LON1=$(python3 -c "import math;print(math.ceil(float('$MAXX')))")

fetch_one() {
  local lat="$1" lon="$2"
  local nlat elon base url out
  nlat=$(printf "N%02d" "$lat")
  elon=$(printf "E%03d" "$lon")
  base="Copernicus_DSM_COG_10_${nlat}_00_${elon}_00_DEM"
  url="https://copernicus-dem-30m.s3.amazonaws.com/${base}/${base}.tif"
  out="$RAW/${base}.tif"
  # 存在则校验大小（上轮可能有半截文件），不符就删了重下
  if [ -s "$out" ]; then
    local want have
    want=$(curl -sIL --max-time 30 "$url" | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
    have=$(stat -c%s "$out")
    if [ -n "$want" ] && [ "$want" = "$have" ]; then return 0; fi
    echo "[resize] $base have=$have want=$want, redownload"
    rm -f "$out"
  fi
  # 先 HEAD 探测：404 再用 GET range 复核一次才认 missing（HEAD 有假 404）
  local code
  code=$(curl -sI -o /dev/null -w "%{http_code}" --max-time 30 "$url" || echo "000")
  if [ "$code" != "200" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 -r 0-0 "$url" || echo "000")
    if [ "$code" = "404" ]; then echo "[miss-404x2] $base"; touch "$out.missing"; return 0; fi
    echo "[probe-$code] $base (skip this round)"; return 0
  fi
  echo "[get] $base"
  bash pipeline/fetch-fast.sh "$url" "$out" 8 || { rm -f "$out"; echo "[fail] $base"; }
}
export -f fetch_one
export RAW

for ((lat=LAT0; lat<LAT1; lat++)); do
  for ((lon=LON0; lon<LON1; lon++)); do
    printf "%s %s\n" "$lat" "$lon"
  done
done | xargs -P 4 -n 2 bash -c 'fetch_one "$@"' _

echo "[01] done. tiles: $(ls "$RAW"/*.tif 2>/dev/null | wc -l), missing: $(ls "$RAW"/*.missing 2>/dev/null | wc -l)"
