import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './ui/ui.css';
import styleJson from './style/style.json';
import { installPanel } from './ui/panel';
import { installHud } from './ui/hud';
import { installPrefetch } from './prefetch';
import { installSearch } from './ui/search';
import { installViewControls } from './ui/viewknob';
import { installGestures } from './ui/gestures';
import { DESTINATIONS, HOME_VIEW } from './destinations';
import { EXTRA_SUFFIXES, pickTerrainSource } from './regions';

maplibregl.addProtocol('pmtiles', new Protocol().tile);
// 提前把 worker / 字形等运行时资源建好，避免第一次交互时才初始化
maplibregl.prewarm();

const PIN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m3 18 6-9 3.5 5 2.5-3 6 7z"/></svg>';

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

/** 数据文件缺失时，从 style 中剔除对应 source 与引用它的 layer，避免控制台刷错 */
async function pruneStyle(style: any): Promise<any> {
  const sources: Record<string, any> = style.sources;
  const alive: Record<string, boolean> = {};
  await Promise.all(
    Object.entries(sources).map(async ([id, src]: [string, any]) => {
      if (typeof src.url === 'string' && src.url.startsWith('pmtiles://')) {
        const path = src.url.replace('pmtiles://', '');
        alive[id] = await exists(path);
        if (!alive[id]) console.warn(`[style] 数据缺失，跳过 source: ${id} (${path})`);
      } else {
        alive[id] = true;
      }
    }),
  );
  style.sources = Object.fromEntries(Object.entries(sources).filter(([id]) => alive[id]));
  style.layers = style.layers.filter((l: any) => !l.source || alive[l.source]);
  if (!alive['dem']) delete style.terrain;
  return style;
}

/**
 * 附加区域：把区域 A 的每个图层按区域复制一份，source 指向 `<id><suffix>`。
 * 缺文件的 source 已经在 pruneStyle 里被删掉，所以没数据的区域不会产生任何图层。
 */
function expandRegions(style: any): any {
  const REGION_SOURCES = ['dem', 'relief', 'osm', 'hiking', 'contours'];
  const swap = new Map<string, string[]>();
  for (const id of REGION_SOURCES) {
    if (!style.sources[id]) continue;
    const twins = EXTRA_SUFFIXES.map((sx) => `${id}${sx}`).filter((t) => style.sources[t]);
    if (twins.length) swap.set(id, twins);
  }
  if (!swap.size) return style;

  const out: any[] = [];
  for (const layer of style.layers) {
    out.push(layer);
    const twins = layer.source ? swap.get(layer.source) : undefined;
    if (!twins) continue;
    for (const twin of twins) {
      out.push({ ...structuredClone(layer), id: `${layer.id}${twin}`, source: twin });
    }
  }
  style.layers = out;
  return style;
}

async function main() {
  const raw = JSON.parse(JSON.stringify(styleJson));
  const style = expandRegions(await pruneStyle(raw));

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: [101.8, 31.0],
    // 先给一个能看到球体的初始视角，再往里推
    zoom: 2.6,
    pitch: 0,
    maxPitch: 85,
    maxZoom: 18,
    minZoom: 1,
    hash: true,
    // ── 性能：为「缩放时不闪、LOD 在手势内完成切换」服务 ──────────────
    // 每个 source 的瓦片缓存上限（默认按视口动态估，太小）
    maxTileCacheSize: 900,
    // 跨几个 zoom 级别保留瓦片：默认 5，放大时旧级别的瓦片会被过早丢弃
    maxTileCacheZoomLevels: 8,
    // 本地数据不会过期，别为了 revalidate 再跑一趟
    refreshExpiredTiles: false,
    // 缩放过程中不取消仍在途的旧级别瓦片请求：
    // 默认 true 会在放大时把上一级没下完的瓦片全砍掉，细节只能等停了才出现
    cancelPendingTileRequestsWhileZooming: false,
    // 0：不做淡入。120ms 的 alpha 动画在大量瓦片同时进出时会被看成「闪」，
    // 而地形 drape 本身每帧都在重画，淡入反而是噪点。
    fadeDuration: 0,
    // Shift + 左键 = 抓住指针下的那个点旋转地球（该点钉在屏幕上不动），
    // 而不是绕屏幕中心转视角。MapLibre 自带 pointer 模式，还会跟地形算高程。
    // Alt + 左键的绕中心旋转在 src/ui/gestures.ts 里自己接。
    dragRotate: { around: 'pointer' },
    // Shift 被拿去做「抓点旋转」，框选缩放让路
    boxZoom: false,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 92 }), 'bottom-left');

  map.on('load', () => {
    if (map.getSource('dem')) {
      map.setTerrain({ source: pickTerrainSource(map.getCenter()), exaggeration: 1.3 });
    }
    map.setLight({ anchor: 'viewport', position: [1.5, 90, 80] });
    // LOD / 渲染分辨率 / 各向异性过滤由「图形」设置页统一施加（src/ui/panel.ts），
    // 这里不再写死，免得和用户选择打架。
    (window as any).__mapLoaded = true;
  });
  map.on('idle', () => { (window as any).__mapIdle = true; });
  // 调试/量测用：控制台和 headless 脚本需要拿到 map 实例
  (window as any).__map = map;

  map.on('error', (e) => {
    // PMTiles 404 之类的噪声不刷屏
    if (!/404|tile/i.test(String(e.error?.message ?? ''))) console.error(e.error);
  });

  installHud(map);
  installPanel(map);
  installPrefetch(map);
  installDestinations(map);
  installSearch(map);
  installViewControls(map);
  installGestures(map);
}

function installDestinations(map: maplibregl.Map) {
  const bar = document.getElementById('dest')!;
  for (const d of DESTINATIONS) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.title = `${d.name} · ${d.sub}`;
    btn.innerHTML = `${PIN_ICON}<span>${d.name}</span><em>${d.sub}</em>`;
    btn.onclick = () =>
      map.flyTo({ center: d.center, zoom: d.zoom, pitch: 60, duration: 4000 });
    bar.appendChild(btn);
  }

  document.getElementById('homeBtn')!.addEventListener('click', () => {
    map.flyTo({ ...HOME_VIEW, pitch: 0, bearing: 0, duration: 1800 });
  });
}

main();
