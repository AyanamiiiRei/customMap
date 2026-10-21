import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import styleJson from './style/style.json';
import { installPanel } from './ui/panel';
import { installHud } from './ui/hud';

maplibregl.addProtocol('pmtiles', new Protocol().tile);

const DESTINATIONS: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: '贡嘎山', center: [101.88, 29.6], zoom: 14 },
  { name: '四姑娘山', center: [102.9, 31.1], zoom: 14 },
  { name: '稻城亚丁', center: [100.3, 28.45], zoom: 14 },
];

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
    maxTileCacheSize: 800,
    fadeDuration: 0,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

  map.on('load', () => {
    if (map.getSource('dem')) {
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
    }
    map.setLight({ anchor: 'viewport', position: [1.5, 90, 80] });
    (window as any).__mapLoaded = true;
  });
  map.on('idle', () => { (window as any).__mapIdle = true; });

  map.on('error', (e) => {
    // PMTiles 404 之类的噪声不刷屏
    if (!/404|tile/i.test(String(e.error?.message ?? ''))) console.error(e.error);
  });

  installHud(map);
  installPanel(map);
  installDestinations(map);
}

function installDestinations(map: maplibregl.Map) {
  const bar = document.getElementById('dest')!;
  for (const d of DESTINATIONS) {
    const btn = document.createElement('button');
    btn.textContent = d.name;
    btn.onclick = () =>
      map.flyTo({ center: d.center, zoom: d.zoom, pitch: 60, duration: 4000 });
    bar.appendChild(btn);
  }
}

main();
