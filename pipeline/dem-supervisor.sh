#!/usr/bin/env bash
# dem-supervisor.sh — 等首轮下载结束后循环重跑，直到 DEM/WC 瓦片补齐
set -uo pipefail
cd "$(dirname "$0")/.."

wait_pid_done() { while ps -p "$1" >/dev/null 2>&1; do sleep 30; done; }

# 首轮进程（启动时传入）跑完后再进入补齐循环
[ -n "${1:-}" ] && wait_pid_done "$1"

for round in $(seq 1 30); do
  tifs=$(ls data/raw/dem/*.tif 2>/dev/null | wc -l)
  miss=$(ls data/raw/dem/*.missing 2>/dev/null | wc -l)
  echo "[supervisor] round $round: dem tifs=$tifs missing=$miss (need 81)"
  [ $((tifs + miss)) -ge 81 ] && break
  bash pipeline/01-fetch-dem.sh >> logs/01-dem.log 2>&1
done
echo "[supervisor] DEM final: $(ls data/raw/dem/*.tif 2>/dev/null | wc -l) tiles"

for round in $(seq 1 10); do
  tifs=$(ls data/raw/worldcover/*.tif 2>/dev/null | wc -l)
  miss=$(ls data/raw/worldcover/*.missing 2>/dev/null | wc -l)
  echo "[supervisor] round $round: wc tifs=$tifs missing=$miss (need 12)"
  [ $((tifs + miss)) -ge 12 ] && break
  bash pipeline/02-fetch-worldcover.sh >> logs/02-wc.log 2>&1
done
echo "[supervisor] WC final: $(ls data/raw/worldcover/*.tif 2>/dev/null | wc -l) tiles"
