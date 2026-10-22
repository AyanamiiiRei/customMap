/** 图层分组 → style.json 中的 layer id 前缀/精确匹配 */
export interface LayerGroup {
  key: string;
  label: string;
  match: string[]; // layer id 前缀
  hasOpacity?: boolean;
  /** 图例色块，纯 UI 用 */
  color?: string;
}

export const LAYER_GROUPS: LayerGroup[] = [
  { key: 'terrain', label: '地形 3D', match: [] },          // 特殊处理：setTerrain + exaggeration
  { key: 'relief', label: '晕渲底色', match: ['relief', 'hillshade'], hasOpacity: true, color: '#7fa35c' },
  { key: 'contours', label: '等高线', match: ['contour'], hasOpacity: true, color: '#a8916f' },
  { key: 'trails', label: '徒步线路', match: ['trail-'], hasOpacity: true, color: '#b4552e' },
  { key: 'water', label: '水系', match: ['water'], hasOpacity: true, color: '#a9d3e8' },
  { key: 'roads', label: '道路', match: ['road'], hasOpacity: true, color: '#e8734a' },
  { key: 'rail', label: '铁路', match: ['rail'], hasOpacity: true, color: '#5c5852' },
  { key: 'places', label: '地名', match: ['place-'], hasOpacity: true, color: '#c9ced6' },
  { key: 'peaks', label: '山峰与营地', match: ['peak', 'hut-poi'], hasOpacity: true, color: '#8c8274' },
  { key: 'scenic', label: '景区与保护区', match: ['scenic-'], hasOpacity: true, color: '#8fbf86' },
  { key: 'culture', label: '文化古迹', match: ['culture-'], hasOpacity: true, color: '#b4784a' },
  { key: 'transport', label: '车站与机场', match: ['transport-'], hasOpacity: true, color: '#2e6e8e' },
  { key: 'boundary', label: '行政边界', match: ['boundary'], hasOpacity: true, color: '#8a7a9a' },
];

