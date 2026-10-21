#!/usr/bin/env bash
# 01b-fetch-dem-rev.sh — 反向顺序补下 DEM（与 01 正向实例并行，靠已有文件去重）
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh
RAW="data/raw/dem"

fetch_one() {
  local lat="$1" lon="$2"
  local nlat elon base url out
  nlat=$(printf "N%02d" "$lat"); elon=$(printf "E%03d" "$lon")
  base="Copernicus_DSM_COG_10_${nlat}_00_${elon}_00_DEM"
  url="https://copernicus-dem-30m.s3.amazonaws.com/${base}/${base}.tif"
  out="$RAW/${base}.tif"
  # 已完整或正在下载（.parts 存在）则跳过
  if [ -s "$out" ]; then
    local want have
    want=$(curl -sIL --max-time 30 "$url" | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
    have=$(stat -c%s "$out")
    [ -n "$want" ] && [ "$want" = "$have" ] && return 0
  fi
  [ -d "${out}.parts" ] && return 0
  [ -f "${out}.missing" ] && return 0
  # HEAD 偶发假 404：再用 GET range 复核一次才认 missing；其他异常留到下轮
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

for ((lat=34; lat>=26; lat--)); do
  for ((lon=104; lon>=96; lon--)); do
    printf "%s %s\n" "$lat" "$lon"
  done
done | xargs -P 4 -n 2 bash -c 'fetch_one "$@"' _
echo "[01b] pass done"
