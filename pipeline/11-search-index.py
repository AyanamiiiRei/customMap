#!/usr/bin/env python3
"""11-search-index.py — OSM geojsonseq → 前端搜索索引

用法: python3 pipeline/11-search-index.py <in.geojsonseq> <out.json>

输入是 `osmium export -f geojsonseq` 的输出（属性即原始 OSM 标签）。
输出是 columnar JSON：

    { "v":1, "bbox":[...], "types":[...],
      "names":[...], "py":[...], "pyi":[...],
      "recs":[[lon, lat, typeIdx, ele, nameIdx], ...] }

拼音用 pypinyin；没装就只写中文/英文匹配字段。
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

_env = os.environ.get("REGION_BBOX", "96.0,24.6,105.0,35.0")
BBOX = tuple(float(v) for v in _env.split(","))
LON_MIN, LAT_MIN, LON_MAX, LAT_MAX = BBOX

TYPES = [
    "city", "town", "village", "hamlet", "district",
    "peak", "saddle", "hut", "camp", "viewpoint",
    "lake", "river", "trail", "road",
    "heritage", "worship", "attraction", "reserve", "reservoir", "station", "airport",
    "ski",
]
TYPE_IDX = {t: i for i, t in enumerate(TYPES)}

PLACE_MAP = {
    "city": "city",
    "town": "town",
    "village": "village",
    "hamlet": "hamlet",
    "suburb": "district",
    "quarter": "district",
    "neighbourhood": "district",
    "locality": "district",
    "isolated_dwelling": "hamlet",
}

ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary"}
TRAIL_CLASSES = {"path", "footway", "track", "steps"}
# 线状要素按「名称」去重：一条国道在 OSM 里是上百个 way，按坐标去重会刷屏
LINE_TYPES = {"road", "river", "trail"}

try:
    from pypinyin import lazy_pinyin  # type: ignore
except Exception:  # pragma: no cover - 可选依赖
    lazy_pinyin = None


def has_han(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def pinyin_pair(name: str) -> tuple[str, str]:
    """返回 (全拼无空格, 首字母)。非中文名退化为小写原文。"""
    if not lazy_pinyin or not has_han(name):
        lowered = "".join(ch.lower() for ch in name if ch.isalnum())
        return lowered, lowered[:8]
    syllables = [s for s in lazy_pinyin(name) if s and s.isalnum()]
    full = "".join(syllables).lower()
    initials = "".join(s[0] for s in syllables if s)
    return full, initials


def pick_name(props: dict) -> str | None:
    for key in ("name:zh", "name", "name:en", "name:zh-Hans", "ref"):
        v = props.get(key)
        if v:
            v = str(v).strip()
            if v:
                return v
    return None


def classify(props: dict) -> str | None:
    place = props.get("place")
    if place in PLACE_MAP:
        return PLACE_MAP[place]
    if props.get("natural") == "peak":
        return "peak"
    if props.get("natural") == "saddle" or props.get("mountain_pass") == "yes":
        return "saddle"
    tourism = props.get("tourism")
    if tourism in ("alpine_hut", "wilderness_hut"):
        return "hut"
    if tourism == "camp_site":
        return "camp"
    if tourism == "viewpoint":
        return "viewpoint"
    route = props.get("route")
    if route in ("hiking", "foot", "mtb"):
        return "trail"
    if props.get("landuse") == "winter_sports" or props.get("piste:type"):
        return "ski"
    if props.get("landuse") == "religious" or props.get("amenity") in ("university", "college"):
        return "worship"
    if props.get("historic"):
        return "heritage"
    if props.get("tourism") in ("museum", "gallery", "artwork", "zoo", "theme_park"):
        return "heritage"
    if props.get("amenity") == "place_of_worship":
        return "worship"
    if props.get("building") in ("monastery", "temple", "church", "cathedral", "chapel", "shrine"):
        return "worship"
    if props.get("tourism") in ("attraction", "information"):
        return "attraction"
    if props.get("leisure") in ("nature_reserve", "park", "garden"):
        return "reserve"
    if props.get("boundary") in ("protected_area", "national_park"):
        return "reserve"
    if props.get("water") == "reservoir" or props.get("landuse") == "reservoir":
        return "reservoir"
    if props.get("railway") in ("station", "halt", "tram_stop"):
        return "station"
    if props.get("aeroway") == "aerodrome":
        return "airport"
    if props.get("natural") == "water":
        return "lake"
    if props.get("waterway") == "river":
        return "river"
    if props.get("highway") in ROAD_CLASSES:
        return "road"
    if props.get("highway") in TRAIL_CLASSES:
        return "trail"
    return None


def rep_point(geom: dict) -> tuple[float, float] | None:
    """点取自身；线/面取包围盒中心。"""
    if not geom:
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None
    if gtype == "Point":
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError, IndexError):
            return None
        return lon, lat

    xs: list[float] = []
    ys: list[float] = []

    def walk(node):
        if isinstance(node, (list, tuple)):
            if len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
                xs.append(float(node[0]))
                ys.append(float(node[1]))
            else:
                for child in node:
                    walk(child)

    walk(coords)
    if not xs:
        return None
    return (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0


def parse_ele(props: dict) -> int:
    raw = props.get("ele")
    if not raw:
        return -9999
    try:
        return int(round(float(str(raw).split()[0].replace(",", "."))))
    except (TypeError, ValueError):
        return -9999


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    seen: set[tuple] = set()
    names: list[str] = []
    name_idx: dict[str, int] = {}
    recs: list[list] = []
    stats: dict[str, int] = {}
    dropped = {"no_name": 0, "no_type": 0, "out_of_bbox": 0, "dup": 0, "no_geom": 0}

    with src.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feat.get("properties") or {}
            ftype = classify(props)
            if not ftype:
                dropped["no_type"] += 1
                continue
            name = pick_name(props)
            if not name:
                dropped["no_name"] += 1
                continue
            # 名字里带「滑雪」的统一归到 ski，避免同一类雪场显示成景点/景区/滑雪场三种
            if "滑雪" in name and ftype in ("attraction", "reserve", "heritage"):
                ftype = "ski"
            pt = rep_point(feat.get("geometry") or {})
            if not pt:
                dropped["no_geom"] += 1
                continue
            lon, lat = pt
            if not (LON_MIN <= lon <= LON_MAX and LAT_MIN <= lat <= LAT_MAX):
                dropped["out_of_bbox"] += 1
                continue
            key = (ftype, name) if ftype in LINE_TYPES else (ftype, name, round(lon, 3), round(lat, 3))
            if key in seen:
                dropped["dup"] += 1
                continue
            seen.add(key)

            idx = name_idx.get(name)
            if idx is None:
                idx = len(names)
                name_idx[name] = idx
                names.append(name)
            recs.append([round(lon, 4), round(lat, 4), TYPE_IDX[ftype], parse_ele(props), idx])
            stats[ftype] = stats.get(ftype, 0) + 1

    # 稳定排序：类别权重（TYPES 顺序）→ 名称长度 → 名称
    recs.sort(key=lambda r: (r[2], len(names[r[4]]), names[r[4]]))

    py: list[str] = []
    pyi: list[str] = []
    cache: dict[str, tuple[str, str]] = {}
    if lazy_pinyin:
        for nm in names:
            pair = cache.get(nm)
            if pair is None:
                pair = pinyin_pair(nm)
                cache[nm] = pair
            py.append(pair[0])
            pyi.append(pair[1])

    out = {
        "v": 1,
        "bbox": list(BBOX),
        "types": TYPES,
        "names": names,
        "recs": recs,
    }
    if lazy_pinyin:
        out["py"] = py
        out["pyi"] = pyi

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size = dst.stat().st_size
    print(f"[search] {len(recs):,} 条 / {len(names):,} 个不同名称 → {dst} ({size/1048576:.2f} MB)")
    print(f"[search] 分类: " + ", ".join(f"{k}={v:,}" for k, v in sorted(stats.items(), key=lambda kv: -kv[1])))
    print(f"[search] 丢弃: " + ", ".join(f"{k}={v:,}" for k, v in dropped.items()))
    if not lazy_pinyin:
        print("[search] 未安装 pypinyin，跳过拼音字段")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
