#!/usr/bin/env python3
"""merge-search.py — 把 search.json 和各附加区域的 <name>-search.json 合并成 search-extra.json

前端只读两个文件：`/data/search.json`（区域 A）+ `/data/search-extra.json`（其余区域）。
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

OUT = Path("public/data")
BASE = OUT / "search.json"
DEST = OUT / "search-extra.json"
TYPES = None


def main() -> int:
    global TYPES
    base = json.loads(BASE.read_text(encoding="utf-8"))
    TYPES = base["types"]
    names: list[str] = []
    index: dict[str, int] = {}
    recs: list[list[int]] = []

    for path in sorted(glob.glob(str(OUT / "*-search.json"))):
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if d.get("types") != TYPES:
            print(f"  [skip] {path}: types 不一致")
            continue
        local = d["names"]
        mapping = []
        for nm in local:
            idx = index.get(nm)
            if idx is None:
                idx = len(names)
                index[nm] = idx
                names.append(nm)
            mapping.append(idx)
        for lon, lat, t, ele, ni in d["recs"]:
            recs.append([lon, lat, t, ele, mapping[ni]])
        print(f"  [add] {Path(path).name}: {len(d['recs']):,} 条")

    if not recs:
        DEST.unlink(missing_ok=True)
        print("  没有附加区域索引")
        return 0

    recs.sort(key=lambda r: (r[2], len(names[r[4]]), names[r[4]]))
    DEST.write_text(
        json.dumps({"v": 1, "types": TYPES, "names": names, "recs": recs},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  → {DEST} {DEST.stat().st_size/1048576:.2f} MB / {len(recs):,} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
