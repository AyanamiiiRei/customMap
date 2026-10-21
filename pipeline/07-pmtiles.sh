#!/usr/bin/env bash
# 07-pmtiles.sh — 汇总打包与产物清单
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

echo "=== public/data ==="
du -h public/data/*.pmtiles 2>/dev/null || true
echo "=== total ==="
du -sh public/data 2>/dev/null || true
node tests/check-size.mjs
