/**
 * 附加区域（区域 A 之外单独切的瓦片）。
 *
 * 区域 A = 滇西北 + 川西（96,24.6,105,35），文件就叫 dem/relief/osm/…；
 * 附加区域每个都有自己的 `<前缀>-*.pmtiles`，样式里预先声明了 `<id>-b` 的 source，
 * 运行时按需把区域 A 的图层复制一份指过去（缺文件时 pruneStyle 已经把 source 删了，
 * 复制也就不会发生）。
 *
 * 地形只能有一个 source，所以按当前中心落在哪个区域切换。
 */

export interface ExtraRegion {
  /** 文件前缀，对应 public/data/<prefix>-*.pmtiles */
  prefix: string;
  /** 图层/source 后缀，style 里是 `<sourceId>-b` */
  suffix: string;
  label: string;
  bbox: [number, number, number, number]; // minx, miny, maxx, maxy
}

export const EXTRA_REGIONS: ExtraRegion[] = [
  {
    prefix: 'sx',
    suffix: '-b',
    label: '山西',
    bbox: [110.2195, 34.5841, 114.5629, 40.745],
  },
];

/** 区域 A 的 source 名 → 附加区域对应 source 名 */
export const REGION_SOURCE_PAIRS: Array<[string, string[]]> = [
  ['dem', ['dem-b']],
  ['relief', ['relief-b']],
  ['osm', ['osm-b']],
  ['hiking', ['hiking-b']],
  ['contours', ['contours-b']],
];

export function inRegion(lng: number, lat: number, r: ExtraRegion): boolean {
  const [minx, miny, maxx, maxy] = r.bbox;
  return lng >= minx && lng <= maxx && lat >= miny && lat <= maxy;
}

/** 当前视图中心该用哪个地形 source */
export function pickTerrainSource(center: { lng: number; lat: number }): string {
  for (const r of EXTRA_REGIONS) {
    if (inRegion(center.lng, center.lat, r)) return `dem${r.suffix}`;
  }
  return 'dem';
}
