#!/usr/bin/env bash
# fetch-fast.sh — 分段并行下载（用于单连接限速的镜像）
# 用法: fetch-fast.sh <url> <out> [nseg]
set -euo pipefail
URL="$1"; OUT="$2"; NSEG="${3:-32}"

SIZE=$(curl -sIL --max-time 60 "$URL" | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
[ -n "$SIZE" ] || { echo "no content-length, fallback to plain curl"; exec curl -fL --retry 5 -C - -o "$OUT" "$URL"; }
echo "size=$SIZE segments=$NSEG"

CHUNK=$(( (SIZE + NSEG - 1) / NSEG ))
TMPD="${OUT}.parts"
mkdir -p "$TMPD"

seq 0 $((NSEG-1)) | xargs -P "$NSEG" -I{} bash -c '
  i={}
  start=$((i * '"$CHUNK"'))
  end=$((start + '"$CHUNK"' - 1))
  [ "$end" -ge '"$SIZE"' ] && end=$(('"$SIZE"' - 1))
  [ "$start" -gt "$end" ] && exit 0
  f="'"$TMPD"'/part_$(printf %04d $i)"
  want=$((end - start + 1))
  have=0; [ -f "$f" ] && have=$(stat -c%s "$f")
  [ "$have" = "$want" ] && exit 0
  # 低速熔断：连续 20s 低于 20KB/s 就断，重试换新连接（对抗长连接限流衰减）
  curl -sfL --retry 10 --retry-delay 3 --retry-all-errors \
    --speed-limit 20480 --speed-time 20 \
    -r "${start}-${end}" -o "$f" "'"$URL"'"
'

# 校验并合并
total=0
for f in "$TMPD"/part_*; do s=$(stat -c%s "$f"); total=$((total+s)); done
if [ "$total" != "$SIZE" ]; then
  echo "INCOMPLETE: $total != $SIZE, rerun to resume"; exit 1
fi
cat "$TMPD"/part_* > "$OUT"
rm -rf "$TMPD"
echo "done: $OUT ($SIZE bytes)"
