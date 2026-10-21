/** 图层分组 → style.json 中的 layer id 前缀/精确匹配 */
export interface LayerGroup {
  key: string;
  label: string;
  match: string[]; // layer id 前缀
  hasOpacity?: boolean;
}

export const LAYER_GROUPS: LayerGroup[] = [
  { key: 'terrain', label: '地形 3D', match: [] },          // 特殊处理：setTerrain + exaggeration
  { key: 'relief', label: '晕渲底色', match: ['relief', 'hillshade'], hasOpacity: true },
  { key: 'contours', label: '等高线', match: ['contour'], hasOpacity: true },
  { key: 'trails', label: '徒步线路', match: ['trail-'], hasOpacity: true },
  { key: 'water', label: '水系', match: ['water'], hasOpacity: true },
  { key: 'roads', label: '道路', match: ['road'], hasOpacity: true },
  { key: 'places', label: '地名', match: ['place-'], hasOpacity: true },
  { key: 'peaks', label: '山峰与营地', match: ['peak', 'hut-poi'], hasOpacity: true },
  { key: 'boundary', label: '行政边界', match: ['boundary'], hasOpacity: true },
];

