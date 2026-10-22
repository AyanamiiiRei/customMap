import type * as maplibregl from 'maplibre-gl';

/** 左上角信息条：经纬度 + 海拔（queryTerrainElevation）+ zoom + FPS */
export function installHud(map: maplibregl.Map) {
  const hud = document.getElementById('hud')!;

  let lngLat: maplibregl.LngLat | null = null;
  // queryTerrainElevation 返回的是「乘过 exaggeration 之后」的高度
  // （官方文档：value returned here will be reflective of (multiplied by) that exaggeration value）。
  // 所以这里存原始值，显示时再除以当前的夸张度，否则 1.3 倍下成都 494m 会显示成 642m。
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

  function fmt(ll: maplibregl.LngLat): string {
    const ns = ll.lat >= 0 ? 'N' : 'S';
    const ew = ll.lng >= 0 ? 'E' : 'W';
    return `${Math.abs(ll.lng).toFixed(4)}°${ew}  ${Math.abs(ll.lat).toFixed(4)}°${ns}`;
  }

  setInterval(() => {
    const pos = lngLat ? fmt(lngLat) : '—';
    const ex = map.getTerrain()?.exaggeration ?? 1;
    const elev = rawElev != null ? rawElev / (ex > 0 ? ex : 1) : null;
    const ele = elev != null && elev > -100 ? `${elev.toFixed(0)} m` : '—';
    hud.innerHTML =
      `经纬度 ${pos}\n海拔   ${ele}\n缩放   z${zoom.toFixed(1)}\n` +
      `<span class="fps">FPS    ${fps}</span>`;
  }, 250);
}
