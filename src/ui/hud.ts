import type * as maplibregl from 'maplibre-gl';

/** 左上角信息条：经纬度 + 海拔（queryTerrainElevation）+ zoom + FPS */
export function installHud(map: maplibregl.Map) {
  const hud = document.getElementById('hud')!;

  let lngLat: maplibregl.LngLat | null = null;
  let elev: number | null = null;
  let zoom = map.getZoom();
  let fps = 0;
  let frames = 0;
  let last = performance.now();

  map.on('mousemove', (e) => {
    lngLat = e.lngLat;
    elev = map.queryTerrainElevation(e.lngLat);
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
    const ele = elev != null && elev > -100 ? `${elev.toFixed(0)} m` : '—';
    hud.innerHTML =
      `经纬度 ${pos}\n海拔   ${ele}\n缩放   z${zoom.toFixed(1)}\n` +
      `<span class="fps">FPS    ${fps}</span>`;
  }, 250);
}
