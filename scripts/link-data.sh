#!/usr/bin/env bash
# link-data.sh — 构建后把大数据目录挂进 dist（避免拷贝 2.5GB）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
ln -sfn ../public/data dist/data
ln -sfn ../public/fonts dist/fonts
# maplibre 按自身 URL 推导 worker 路径（/assets/maplibre-gl-worker.mjs），vite 不会自动带出
cp -f node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs dist/assets/
echo "dist ready (data/fonts linked, worker copied)"
