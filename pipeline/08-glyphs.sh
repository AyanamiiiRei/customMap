#!/usr/bin/env bash
# 08-glyphs.sh — 生成 Noto Sans SC 字体字形 PBF（0-65535，每 256 一段）
# 流程: 下载可变字体 → fonttools instancer 实例化 400/700 → fontnik build-glyphs
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

FONTS_DIR="data/raw/fonts"
mkdir -p "$FONTS_DIR" tools/gen-glyphs

VAR="$FONTS_DIR/NotoSansSC.ttf"
REG="$FONTS_DIR/NotoSansSC-Regular.ttf"
BOLD="$FONTS_DIR/NotoSansSC-Bold.ttf"

[ -s "$VAR" ] || bash pipeline/fetch-fast.sh \
  "https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf" "$VAR" 8

# 实例化静态字重（fonttools 在 mamba 环境里）
[ -s "$REG" ]  || fonttools varLib.instancer "$VAR" wght=400 -o "$REG"
[ -s "$BOLD" ] || fonttools varLib.instancer "$VAR" wght=700 -o "$BOLD"

if [ ! -d tools/gen-glyphs/node_modules/fontnik ]; then
  (cd tools/gen-glyphs && npm init -y >/dev/null && npm i --no-audit --no-fund fontnik)
fi

BUILD="tools/gen-glyphs/node_modules/fontnik/bin/build-glyphs"
for pair in "NotoSansSC-Regular:$REG" "NotoSansSC-Bold:$BOLD"; do
  name="${pair%%:*}"; file="${pair##*:}"
  if [ ! -s "public/fonts/$name/0-255.pbf" ]; then
    mkdir -p "public/fonts/$name"
    node "$BUILD" "$file" "public/fonts/$name"
  fi
done
echo "[08] glyphs done: $(ls public/fonts/NotoSansSC-Regular | wc -l) + $(ls public/fonts/NotoSansSC-Bold | wc -l) ranges"
