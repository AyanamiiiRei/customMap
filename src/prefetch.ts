/**
 * prefetch.ts — 把「下一级/下两级」的瓦片提前拉进 HTTP 缓存。
 *
 * 为什么需要：MapLibre 只请求当前视口覆盖到的那一级瓦片。缩放的瞬间它才去要上一级，
 * 于是「松手之后才变清楚」——LOD 切换发生在手势结束、瓦片到位之后。
 * 这里在空闲时用 PMTiles 客户端先把 z+1 / z+2 的瓦片字节取回来，
 * 浏览器 HTTP 缓存（配合服务器 Cache-Control: immutable）会留住它们；
 * 真正缩放时 MapLibre 拿到的是缓存命中，切换就在手势过程中完成了。
 *
 * 只有字节进缓存，不占 GPU 纹理；纹理仍由 MapLibre 的 maxTileCacheSize 控制。
 */
import type * as maplibregl from 'maplibre-gl';
import { FetchSource, PMTiles } from 'pmtiles';

interface WarmSpec {
  /** style.json 里的 source id，仅用于日志 */
  id: string;
  url: string;
  maxzoom: number;
  /** 向未来预热几级（放大时要的子级） */
  ahead: number;
  /** 向过去预热几级（缩小时要的父级） */
  behind: number;
  /** 单次预取上限，防止一次塞几千个请求 */
  budget: number;
}

const SPECS: WarmSpec[] = [
  // 地形与底色是「闪」的主要来源：每张都要解码一张 256×256 的 PNG/WebP。
  // 缩小时需要的是父级（z-1/-2），放大时需要子级（z+1/+2），两个方向都要预热，
  // 否则「缩小」永远比「放大」卡——父级从来没人提前下过。
  { id: 'dem', url: '/data/dem.pmtiles', maxzoom: 12, ahead: 2, behind: 2, budget: 400 },
  { id: 'relief', url: '/data/relief.pmtiles', maxzoom: 13, ahead: 2, behind: 2, budget: 400 },
  { id: 'osm', url: '/data/osm.pmtiles', maxzoom: 14, ahead: 1, behind: 1, budget: 400 },
  { id: 'contours', url: '/data/contours.pmtiles', maxzoom: 14, ahead: 1, behind: 1, budget: 240 },
  { id: 'hiking', url: '/data/hiking.pmtiles', maxzoom: 14, ahead: 1, behind: 1, budget: 160 },
];

// 后台预取只占 4 条连接，绝不和前台抢
const CONCURRENCY = 4;

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

interface Job {
  spec: WarmSpec;
  z: number;
  x: number;
  y: number;
}

export function installPrefetch(map: maplibregl.Map) {
  const enabled = !/[?&]prefetch=0/.test(location.search);
  if (!enabled) return;

  const archives = new Map<string, PMTiles>();
  const headersReady = new Map<string, Promise<unknown>>();
  const warmed = new Set<string>();
  let queue: Job[] = [];
  let running = 0;
  let timer: number | undefined;
  // 手势期间一律停手：只剩已经在途的最多 4 条请求，
  // 其余连接全部让给 MapLibre 自己，避免预取把关键瓦片挤到后面。
  let paused = false;

  function archive(spec: WarmSpec): PMTiles {
    let a = archives.get(spec.url);
    if (!a) {
      a = new PMTiles(new FetchSource(spec.url));
      archives.set(spec.url, a);
    }
    return a;
  }

  function ready(spec: WarmSpec): Promise<unknown> {
    let p = headersReady.get(spec.url);
    if (!p) {
      p = archive(spec).getHeader().catch(() => null);
      headersReady.set(spec.url, p);
    }
    return p;
  }

  function pump() {
    if (paused) return;
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift()!;
      running++;
      void archive(job.spec)
        .getZxy(job.z, job.x, job.y)
        .catch(() => undefined)
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  function collect(override?: { ahead: number; behind: number }) {
    const b = map.getBounds();
    const zNow = Math.min(Math.round(map.getZoom()), 20);
    const next: Job[] = [];

    for (const spec of SPECS) {
      const ahead = override ? Math.min(spec.ahead, override.ahead) + (override.ahead > spec.ahead ? 1 : 0) : spec.ahead;
      const behind = override ? Math.min(spec.behind, override.behind) : spec.behind;
      const deltas: number[] = [0];
      for (let k = 1; k <= Math.max(ahead, behind); k++) {
        if (k <= ahead) deltas.push(k);
        if (k <= behind) deltas.push(-k);
      }
      for (const dz of deltas) {
        const z = zNow + dz;
        if (z < 0 || z > spec.maxzoom) continue;
        const n = 2 ** z;
        const x0 = Math.max(0, Math.min(n - 1, lonToTileX(b.getWest(), z)));
        const x1 = Math.max(0, Math.min(n - 1, lonToTileX(b.getEast(), z)));
        const y0 = Math.max(0, Math.min(n - 1, latToTileY(b.getNorth(), z)));
        const y1 = Math.max(0, Math.min(n - 1, latToTileY(b.getSouth(), z)));
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (w <= 0 || h <= 0 || w * h > spec.budget) {
          // 视口过大（比如球体视角）时这一级没有意义，跳过
          continue;
        }
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = `${spec.id}/${z}/${x}/${y}`;
            if (warmed.has(key)) continue;
            // 已经由 MapLibre 请求过的当前级不必再预取，缓存里已经有了
            if (dz === 0) {
              warmed.add(key);
              continue;
            }
            warmed.add(key);
            next.push({ spec, z, x, y });
          }
        }
      }
    }
    if (warmed.size > 60000) warmed.clear();
    return next;
  }

  function schedule(delay = 300) {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      if (document.hidden) return;
      void Promise.all(SPECS.map(ready)).then(() => {
        queue = queue.concat(collect());
        pump();
      });
    }, delay);
  }

  map.on('load', () => schedule(50));
  map.on('idle', () => { paused = false; schedule(250); });
  map.on('moveend', () => { paused = false; schedule(200); });
  map.on('zoomend', () => { paused = false; schedule(200); });
  // 任何相机运动开始 → 立刻让路
  map.on('movestart', () => { paused = true; });

  // 注意：不要在 zoom 过程中抢瓦片。
  // 浏览器对同一 host 只有 6 条 HTTP/1.1 连接，预取一开抢就会挤掉 MapLibre
  // 真正要用的那几张，实测反而把手势后的收敛时间从 84ms 拖到 164ms。
  // 预取只在「没人用网络」的时候跑（load / idle / moveend / zoomend），
  // 缩放过程中的连续性靠 map 的 cancelPendingTileRequestsWhileZooming: false。

  (window as any).__prefetch = {
    pending: () => queue.length + running,
    warmed: () => warmed.size,
  };
}
