import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './ui/ui.css';
import styleJson from './style/style.json';
import { installPanel } from './ui/panel';
import { installHud } from './ui/hud';
import { installPrefetch } from './prefetch';
import { installSearch } from './ui/search';
import { DESTINATIONS, HOME_VIEW } from './destinations';

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

async function main() {
  const raw = JSON.parse(JSON.stringify(styleJson));
  const style = await pruneStyle(raw);

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
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 92 }), 'bottom-right');
  map.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

  map.on('load', () => {
    if (map.getSource('dem')) {
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
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
