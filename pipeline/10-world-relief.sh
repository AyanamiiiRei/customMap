#!/usr/bin/env bash
# 10-world-relief.sh — 全球粗底：ETOPO 2022 60″ → z0-7 地形底色 + z0-6 粗糙 DEM
#
# 目的：拉到 200km 比例尺（z6）时，整个地球都有地形起伏，而不是一块彩色球。
# 产物：
#   public/data/relief-world.pmtiles   z0-7 全球户外底色（含海洋深度着色）
#   public/data/dem.pmtiles            原有川西 z0-12 瓦片 + 补上全球 z0-6 缺的瓦片
#
# 注意顺序：本脚本会把全球 DEM 瓦片**合并进** data/work/dem.mbtiles（缺哪儿补哪儿，
# 已有的川西瓦片保留）。如果之后重跑了 `06-dem.sh` + `dem2tiles`（会重建 dem.mbtiles），
# 需要再跑一次本脚本。
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

RAW="data/raw/etopo"
WORK="data/work"
TIF="$RAW/etopo60.tif"
RES=1223                 # z7 在赤道是 1222.99 m/px
LC_RES=2446              # 土地覆盖用半分辨率就够（多边形本来就粗），省 3/4 磁盘
EXT="-20037508.34 -20037508.34 20037508.34 20037508.34"
DEM_Z=6                  # 全球 DEM 到 z6；z7 及以上靠父级 overzoom
REL_Z=7                  # 底色到 z7，正好和川西 z5-13 的底色接上

DEM3857="$WORK/world_dem_3857.tif"
LC3857="$WORK/world_landcover_3857.tif"

[ -s "$TIF" ] || { echo "[10] 缺 $TIF"; exit 1; }
mkdir -p "$WORK"

# ── 1. 重投影到 Web Mercator ─────────────────────────────────────────
if [ ! -s "$DEM3857" ]; then
  echo "[10] warp → $DEM3857"
  gdalwarp -t_srs EPSG:3857 -tr $RES $RES -r bilinear -ot Int16 \
    -te $EXT -of COG -co COMPRESS=DEFLATE -co BIGTIFF=YES -co NUM_THREADS=ALL_CPUS \
    -overwrite "$TIF" "$DEM3857"
fi
echo "[10] dem: $(du -h "$DEM3857" | cut -f1)"

# ── 2. 粗略土地覆盖：Natural Earth 的沙漠/苔原多边形 ────────────────
# 全球尺度的 WorldCover 有 20GB+，用不起；z0-7 只要「沙漠是黄的」就够，
# 其余交给高程色带（低地绿、高山褐、雪线白）。
if [ ! -s "$LC3857" ]; then
  SRC="data/raw/ne/ne_50m_geography_regions_polys/ne_50m_geography_regions_polys.shp"
  [ -s "$SRC" ] || { echo "[10] 缺 $SRC（跑 05-world.sh 前会下载 NE）"; exit 1; }
  rm -f "$WORK/world_regions_3857.geojson"
  ogr2ogr -f GeoJSON -overwrite -t_srs EPSG:3857 -nln world_regions "$WORK/world_regions_3857.geojson" "$SRC" \
    -dialect SQLite -sql "SELECT geometry, CASE WHEN featurecla='Desert' THEN 60 ELSE 20 END AS cls
          FROM ne_50m_geography_regions_polys
          WHERE featurecla IN ('Desert','Tundra')"
  gdal_rasterize -l world_regions -a cls -init 0 -a_nodata 0 -ot Byte \
    -tr $LC_RES $LC_RES -te $EXT "$WORK/world_regions_3857.geojson" "$LC3857"
fi
echo "[10] landcover: $(du -h "$LC3857" | cut -f1)"

# ── 3. 全球 DEM 瓦片 ─────────────────────────────────────────────────
if [ ! -s "$WORK/world-dem.mbtiles" ]; then
  echo "[10] dem2tiles z0-$DEM_Z"
  rust/geotiles/target/release/dem2tiles \
    --input "$DEM3857" --output "$WORK/world-dem.mbtiles" \
    --minzoom 0 --maxzoom $DEM_Z 2>&1 | tail -2
fi

# ── 4. 合并进川西的 dem.mbtiles（缺哪儿补哪儿）───────────────────────
echo "[10] merge world DEM into $WORK/dem.mbtiles"
python3 - <<'PY'
import sqlite3, sys
base = sqlite3.connect("data/work/dem.mbtiles")
base.execute("PRAGMA journal_mode=OFF")
base.execute("PRAGMA synchronous=OFF")
world = sqlite3.connect("data/work/world-dem.mbtiles")
have = {(z, x, y) for z, x, y in base.execute("SELECT zoom_level,tile_column,tile_row FROM tiles")}
rows = [(z, x, y, d) for z, x, y, d in world.execute("SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles")]
new = [r for r in rows if (r[0], r[1], r[2]) not in have]
base.executemany("INSERT INTO tiles (zoom_level,tile_column,tile_row,tile_data) VALUES (?,?,?,?)", new)
base.execute("UPDATE metadata SET value='-180,-85.051129,180,85.051129' WHERE name='bounds'")
base.commit()
print(f"  world tiles {len(rows)}, 新增 {len(new)}, 保留川西 {len(have)}")
PY
rm -f public/data/dem.pmtiles
tools/pmtiles convert "$WORK/dem.mbtiles" public/data/dem.pmtiles 2>&1 | tail -1

# ── 5. 全球底色 ──────────────────────────────────────────────────────
echo "[10] bake-relief z0-$REL_Z（全球）"
rust/geotiles/target/release/bake-relief \
  --dem "$DEM3857" --landcover "$LC3857" \
  --output "$WORK/world-relief.mbtiles" --minzoom 0 --maxzoom $REL_Z --format webp --world-palette 2>&1 | tail -2
rm -f public/data/relief-world.pmtiles
tools/pmtiles convert "$WORK/world-relief.mbtiles" public/data/relief-world.pmtiles 2>&1 | tail -1

ls -lh public/data/dem.pmtiles public/data/relief-world.pmtiles
