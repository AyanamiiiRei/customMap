#!/usr/bin/env bash
# 04-hiking.sh — 抽取徒步/山径要素 → hiking.pmtiles
# 保留属性: name, ref, network, highway, sac_scale, trail_visibility, route, tourism, natural
set -euo pipefail
cd "$(dirname "$0")/.."
source pipeline/env.sh

IN="data/raw/chuanxi.osm.pbf"
WORK="data/work"
mkdir -p "$WORK"

[ -s "$IN" ] || { echo "[04] missing $IN"; exit 1; }

if [ ! -s "$WORK/hiking.osm.pbf" ]; then
  osmium tags-filter "$IN" \
    r/route=hiking,foot,mtb w/highway=path,footway,steps,track \
    n/tourism=alpine_hut,wilderness_hut,camp_site n/natural=saddle \
    -o "$WORK/hiking.osm.pbf" --overwrite
fi

if [ ! -s "$WORK/hiking.geojson" ]; then
  osmium export "$WORK/hiking.osm.pbf" -o "$WORK/hiking.geojson" --overwrite \
    -f geojsonseq --geometry-types=linestring,point
fi

# 过滤：只保留带目标属性的要素（去掉 way 成员裸节点）
if [ ! -s "$WORK/hiking.geojsonl" ]; then
  python3 - <<'EOF'
import json
KEEP = {"name","ref","network","highway","sac_scale","trail_visibility","route","tourism","natural"}
with open("data/work/hiking.geojson") as f, open("data/work/hiking.geojsonl","w") as o:
    for line in f:
        line=line.strip()
        if not line: continue
        feat=json.loads(line)
        props={k:v for k,v in (feat.get("properties") or {}).items() if k in KEEP and v not in (None,"")}
        if not props: continue
        feat["properties"]=props
        o.write(json.dumps(feat,ensure_ascii=False,separators=(",",":"))+"\n")
EOF
fi

if [ ! -s public/data/hiking.pmtiles ]; then
  tippecanoe -o "$WORK/hiking.mbtiles" -z14 -Z8 --force --drop-densest-as-needed \
    -L hiking:"$WORK/hiking.geojsonl"
  pmtiles convert "$WORK/hiking.mbtiles" public/data/hiking.pmtiles
fi
echo "[04] done: $(du -h public/data/hiking.pmtiles | cut -f1)"
