#!/usr/bin/env bash
# region-build.sh — 给「区域 A 之外」的附加区域建一整套瓦片
#
# 用法: bash pipeline/region-build.sh <名字> <bbox> <osm.pbf> [--skip=osm,contours,...]
#   例: bash pipeline/region-build.sh sx "110.2195,34.5841,114.5629,40.7450" data/raw/shanxi.osm.pbf
#
# 产物（都带区域前缀，不会覆盖区域 A）:
#   public/data/<名字>-dem.pmtiles      z0-12 terrarium
#   public/data/<名字>-relief.pmtiles   z0-13 户外底色
#   public/data/<名字>-osm.pmtiles      OpenMapTiles
#   public/data/<名字>-hiking.pmtiles   徒步要素
#   public/data/<名字>-contours.pmtiles 等高线
#   public/data/search-extra.json       搜索索引（合并进前端第二个索引文件）
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

NAME="${1:?需要区域名，例如 sx}"
BBOX="${2:?需要 bbox，例如 110.2195,34.5841,114.5629,40.7450}"
PBF="${3:?需要该区域的 osm.pbf}"
SKIP="${4:-}"

IFS=',' read -r MINX MINY MAXX MAXY <<< "$BBOX"
WORK="data/work/$NAME"
OUT="public/data"
RAW_DEM="data/raw/dem"
RAW_WC="data/raw/worldcover"
mkdir -p "$WORK"

say() { echo; echo "════ [$NAME] $* ════"; }

# ── DEM / WorldCover 拼接（只取与该 bbox 相交的瓦片）─────────────────
tiles_for_bbox() {
  python3 - "$1" "$MINX" "$MINY" "$MAXX" "$MAXY" <<'PY'
import math, os, sys
kind, minx, miny, maxx, maxy = sys.argv[1], *map(float, sys.argv[2:6])
if kind == 'dem':
    lat0, lat1 = math.floor(miny), math.ceil(maxy)
    lon0, lon1 = math.floor(minx), math.ceil(maxx)
    for lat in range(lat0, lat1):
        for lon in range(lon0, lon1):
            p = f"data/raw/dem/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
            if os.path.exists(p): print(p)
else:
    lat0, lat1 = int(math.floor(miny/3)*3), int(math.ceil(maxy/3)*3)
    lon0, lon1 = int(math.floor(minx/3)*3), int(math.ceil(maxx/3)*3)
    for lat in range(lat0, lat1, 3):
        for lon in range(lon0, lon1, 3):
            p = f"data/raw/worldcover/ESA_WorldCover_10m_2021_v200_N{lat:02d}E{lon:03d}_Map.tif"
            if os.path.exists(p): print(p)
PY
}

if [[ ",$SKIP," != *",dem,"* ]]; then
  say "DEM 拼接（26m / EPSG:3857）"
  if [ ! -s "$WORK/dem_3857.tif" ]; then
    tiles_for_bbox dem > "$WORK/dem_tiles.txt"
    wc -l < "$WORK/dem_tiles.txt" | xargs echo "  DEM 瓦片数:"
    gdalbuildvrt -q "$WORK/dem_merged.vrt" $(cat "$WORK/dem_tiles.txt")
    gdalwarp -t_srs EPSG:3857 -tr 26 26 -r cubic -multi -wo NUM_THREADS=ALL_CPUS \
      -te "$MINX" "$MINY" "$MAXX" "$MAXY" -te_srs EPSG:4326 \
      -of COG -co COMPRESS=DEFLATE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=YES \
      -overwrite "$WORK/dem_merged.vrt" "$WORK/dem_3857.tif"
  fi
  echo "  dem_3857: $(du -h "$WORK/dem_3857.tif" | cut -f1)"

  say "dem.pmtiles（z0-12）"
  rust/geotiles/target/release/dem2tiles \
    --input "$WORK/dem_3857.tif" --output "$WORK/dem.mbtiles" --minzoom 0 --maxzoom 12
  rm -f "$OUT/$NAME-dem.pmtiles"
  tools/pmtiles convert "$WORK/dem.mbtiles" "$OUT/$NAME-dem.pmtiles" 2>&1 | tail -1

  say "relief.pmtiles（z0-13）"
  if [ ! -s "$WORK/worldcover_3857.tif" ]; then
    tiles_for_bbox wc > "$WORK/wc_tiles.txt"
    wc -l < "$WORK/wc_tiles.txt" | xargs echo "  WorldCover 瓦片数:"
    gdalbuildvrt -q "$WORK/wc_merged.vrt" $(cat "$WORK/wc_tiles.txt")
    gdalwarp -t_srs EPSG:3857 -tr 26 26 -r near -multi -wo NUM_THREADS=ALL_CPUS \
      -te "$MINX" "$MINY" "$MAXX" "$MAXY" -te_srs EPSG:4326 \
      -of COG -co COMPRESS=DEFLATE -co NUM_THREADS=ALL_CPUS -co BIGTIFF=YES \
      -overwrite "$WORK/wc_merged.vrt" "$WORK/worldcover_3857.tif"
  fi
  rust/geotiles/target/release/bake-relief \
    --dem "$WORK/dem_3857.tif" --landcover "$WORK/worldcover_3857.tif" \
    --output "$WORK/relief.mbtiles" --minzoom 0 --maxzoom 13 --format webp --feather-meters 60000
  rm -f "$OUT/$NAME-relief.pmtiles"
  tools/pmtiles convert "$WORK/relief.mbtiles" "$OUT/$NAME-relief.pmtiles" 2>&1 | tail -1
fi

# ── OSM → pmtiles ───────────────────────────────────────────────────
if [[ ",$SKIP," != *",osm,"* ]]; then
  say "osm.pmtiles（planetiler）"
  [ -s tools/planetiler.jar ] || bash pipeline/fetch-fast.sh \
    "https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar" tools/planetiler.jar 8
  for f in water-polygons-split-3857.zip lake_centerline.shp.zip natural_earth_vector.sqlite.zip; do
    [ -s "data/sources/$f" ] || { echo "缺 data/sources/$f"; exit 1; }
  done
  if [ ! -s "$WORK/osm.mbtiles" ]; then
    java -Xmx24g -jar tools/planetiler.jar \
      --osm-path="$PBF" --output="$WORK/osm.mbtiles" --force --bounds="$BBOX"
  fi
  rm -f "$OUT/$NAME-osm.pmtiles"
  tools/pmtiles convert "$WORK/osm.mbtiles" "$OUT/$NAME-osm.pmtiles" 2>&1 | tail -1
fi

# ── 徒步要素 ────────────────────────────────────────────────────────
if [[ ",$SKIP," != *",hiking,"* ]]; then
  say "hiking.pmtiles"
  if [ ! -s "$WORK/hiking.osm.pbf" ]; then
    osmium tags-filter "$PBF" \
      r/route=hiking,foot,mtb w/highway=path,footway,steps,track \
      n/tourism=alpine_hut,wilderness_hut,camp_site n/natural=saddle \
      -o "$WORK/hiking.osm.pbf" --overwrite --no-progress
  fi
  if [ ! -s "$WORK/hiking.geojsonl" ]; then
    osmium export "$WORK/hiking.osm.pbf" -o "$WORK/hiking.geojson" --overwrite \
      -f geojsonseq --geometry-types=linestring,point --no-progress
    python3 - "$WORK/hiking.geojson" "$WORK/hiking.geojsonl" <<'EOF'
import json, sys
KEEP = {"name","ref","network","highway","sac_scale","trail_visibility","route","tourism","natural"}
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as f, open(dst, 'w', encoding='utf-8') as o:
    for line in f:
        line = line.strip()
        if not line: continue
        try: feat = json.loads(line)
        except Exception: continue
        props = {k: v for k, v in (feat.get("properties") or {}).items() if k in KEEP and v not in (None, "")}
        if not props: continue
        feat["properties"] = props
        o.write(json.dumps(feat, ensure_ascii=False, separators=(",", ":")) + "\n")
EOF
  fi
  tippecanoe -o "$WORK/hiking.mbtiles" -z14 -Z8 --force --drop-densest-as-needed \
    -L hiking:"$WORK/hiking.geojsonl" 2>&1 | tail -2
  rm -f "$OUT/$NAME-hiking.pmtiles"
  tools/pmtiles convert "$WORK/hiking.mbtiles" "$OUT/$NAME-hiking.pmtiles" 2>&1 | tail -1
fi

# ── 等高线 ──────────────────────────────────────────────────────────
if [[ ",$SKIP," != *",contours,"* ]]; then
  say "contours.pmtiles"
  mkdir -p "$WORK/contours"
  if [ ! -s "$WORK/contours/contours-z9.geojsonl" ]; then
    rust/geotiles/target/release/contours \
      --dem "$WORK/dem_3857.tif" --output "$WORK/contours/contours.geojsonl" --bbox "$BBOX"
  fi
  tippecanoe -o "$WORK/contours/c-z9.mbtiles"  -z11 -Z9  --force --no-feature-limit \
    --simplify-only-low-zooms -L contours:"$WORK/contours/contours-z9.geojsonl" 2>&1 | tail -1
  tippecanoe -o "$WORK/contours/c-z12.mbtiles" -z13 -Z12 --force --no-feature-limit \
    -L contours:"$WORK/contours/contours-z12.geojsonl" 2>&1 | tail -1
  tippecanoe -o "$WORK/contours/c-z14.mbtiles" -z14 -Z14 --force --no-feature-limit \
    -L contours:"$WORK/contours/contours-z14.geojsonl" 2>&1 | tail -1
  tile-join -o "$WORK/contours.mbtiles" --force \
    "$WORK/contours/c-z9.mbtiles" "$WORK/contours/c-z12.mbtiles" "$WORK/contours/c-z14.mbtiles" 2>&1 | tail -1
  rm -f "$OUT/$NAME-contours.pmtiles"
  tools/pmtiles convert "$WORK/contours.mbtiles" "$OUT/$NAME-contours.pmtiles" 2>&1 | tail -1
fi

# ── 搜索索引 ────────────────────────────────────────────────────────
if [[ ",$SKIP," != *",search,"* ]]; then
  say "搜索索引"
  osmium tags-filter "$PBF" \
    nw/place=city,town,village,hamlet,suburb,quarter,neighbourhood,locality,isolated_dwelling \
    nw/natural=peak,saddle nw/mountain_pass=yes \
    nw/tourism=alpine_hut,wilderness_hut,camp_site,viewpoint \
    w/natural=water r/natural=water w/waterway=river \
    w/highway=motorway,trunk,primary,secondary,path,track,footway \
    nw/historic nw/tourism=museum,attraction,gallery,artwork,zoo,theme_park,information \
    nw/amenity=place_of_worship,university,college \
    nw/building=monastery,temple,church,cathedral,chapel,shrine \
    nw/landuse=religious nw/leisure=nature_reserve,park,garden \
    nw/boundary=protected_area,national_park r/boundary=protected_area,national_park \
    nw/railway=station,halt,tram_stop nw/aeroway=aerodrome \
    nw/landuse=reservoir nw/water=reservoir \
    nw/landuse=winter_sports w/piste:type \
    -o "$WORK/search.osm.pbf" --overwrite --no-progress
  osmium export "$WORK/search.osm.pbf" -f geojsonseq -o "$WORK/search.geojson" \
    --overwrite --no-progress
  REGION_BBOX="$BBOX" tools/mambaenv/bin/python pipeline/11-search-index.py \
    "$WORK/search.geojson" "$OUT/$NAME-search.json" | tail -3
  # 所有区域索引合并成一个附加索引，前端只多读一个文件
  tools/mambaenv/bin/python pipeline/merge-search.py
fi

say "完成"
ls -lh "$OUT/$NAME"-*.pmtiles 2>/dev/null || true
