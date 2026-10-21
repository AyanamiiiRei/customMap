#!/usr/bin/env python3
# decode_tile.py — 读 stdin 的 PNG/WebP 瓦片字节，输出 raw RGB 到 stdout（供 check-align.mjs 用）
import sys, io
from PIL import Image
data = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(data)).convert('RGB')
sys.stdout.buffer.write(im.tobytes())
