import type * as maplibregl from 'maplibre-gl';

/** HUD 测到的实时帧率，图形设置面板要读 */
export const perfStats = { fps: 0 };

/**
 * 左下角仪表盘：坐标 / 海拔 / 相机视角高度 / 缩放 / FPS。
 * 逐个写 DOM 文本而不是整块 innerHTML，避免每 250ms 重建节点把鼠标选中打断。
 */
export function installHud(map: maplibregl.Map) {
  const posEl = document.getElementById('hudPos')!;
  const eleEl = document.getElementById('hudEle')!;
  const altEl = document.getElementById('hudAlt')!;
  const zoomEl = document.getElementById('hudZoom')!;
  const fpsEl = document.getElementById('hudFps')!;
  const fpsNum = fpsEl.querySelector('span')!;

  let lngLat: maplibregl.LngLat | null = null;
  // queryTerrainElevation 返回的是「乘过 exaggeration 之后」的高度
  // （官方文档：value returned here is reflective of (multiplied by) that exaggeration value）。
  // 所以这里存原始值，显示时再除以当前夸张度，否则 1.3 倍下成都 494m 会显示成 642m。
  let rawElev: number | null = null;
  let zoom = map.getZoom();
  let fps = 0;
  let frames = 0;
  let last = performance.now();

  map.on('mousemove', (e) => {
    lngLat = e.lngLat;
    const v = map.queryTerrainElevation(e.lngLat);
    // 该点没有已加载的 DEM 瓦片时 MapLibre 返回 0；川西没有海平面地形，
    // 所以把 0 当作「暂无数据」，避免鼠标划到还没加载的区域时显示 0 m。
    rawElev = typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null;
  });
  map.on('zoom', () => { zoom = map.getZoom(); });
  map.on('render', () => {
    frames++;
    const now = performance.now();
    if (now - last >= 1000) {
      fps = frames;
      frames = 0;
      last = now;
    }
  });

  function setValue(el: HTMLElement, text: string, dim: boolean) {
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('dim', dim);
  }

  /**
   * 相机海拔（米，海平面起算）。
   * MapLibre 6 的 Map 上没有公开 getCameraAltitude()，只有内部 transform 有；
   * 而它返回的高度里包含了地形夸张后的地面高度，所以要换算回真实海拔：
   *   真实海拔 = 相机高度_夸张坐标系 − 地面高度_夸张 × (1 − 1/夸张度)
   */
  function cameraAltitude(): number | null {
    const tr = (map as any)._camera?.transform;
    if (!tr || typeof tr.getCameraAltitude !== 'function') return null;
    const a = tr.getCameraAltitude();
    if (!Number.isFinite(a)) return null;
    const ex = map.getTerrain()?.exaggeration ?? 1;
    return a - map.getCenterElevation() * (1 - 1 / (ex > 0 ? ex : 1));
  }

  function fmtLL(ll: maplibregl.LngLat): string {
    const ns = ll.lat >= 0 ? 'N' : 'S';
    const ew = ll.lng >= 0 ? 'E' : 'W';
    return `${Math.abs(ll.lng).toFixed(4)}°${ew} ${Math.abs(ll.lat).toFixed(4)}°${ns}`;
  }

  setInterval(() => {
    perfStats.fps = fps;
    setValue(posEl, lngLat ? fmtLL(lngLat) : '—', !lngLat);

    const ex = map.getTerrain()?.exaggeration ?? 1;
    const elev = rawElev != null ? rawElev / (ex > 0 ? ex : 1) : null;
    const eleOk = elev != null && elev > -100;
    setValue(eleEl, eleOk ? `${elev!.toFixed(0)} m` : '—', !eleOk);

    const alt = cameraAltitude();
    setValue(altEl, alt != null ? `${alt.toFixed(0)} m` : '—', alt == null);

    setValue(zoomEl, `z${zoom.toFixed(1)}`, false);

    if (fpsNum.textContent !== String(fps)) fpsNum.textContent = String(fps);
    fpsEl.classList.toggle('warn', fps > 0 && fps < 40);
    fpsEl.classList.toggle('bad', fps > 0 && fps < 20);
  }, 250);
}
