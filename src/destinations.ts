/** 全站共享的视角常量，main.ts 与搜索面板都从这里取，避免循环依赖 */
export const HOME_VIEW = {
  center: [101.8, 31.0] as [number, number],
  zoom: 2.6,
};

export interface Destination {
  name: string;
  sub: string;
  center: [number, number];
  zoom: number;
}

export const DESTINATIONS: Destination[] = [
  { name: '贡嘎山', sub: '7556 m', center: [101.88, 29.6], zoom: 14 },
  { name: '四姑娘山', sub: '6250 m', center: [102.9, 31.1], zoom: 14 },
  { name: '稻城亚丁', sub: '6032 m', center: [100.3, 28.45], zoom: 14 },
  { name: '大理', sub: '洱海', center: [100.19, 25.7], zoom: 12 },
  { name: '太原', sub: '山西', center: [112.55, 37.87], zoom: 10 },
  { name: '重庆', sub: '川东', center: [106.55, 29.56], zoom: 11 },
];
