import type * as maplibregl from 'maplibre-gl';
import { LAYER_GROUPS, type LayerGroup } from '../layers';

const LS_KEY = 'chuanxi-map-state-v1';

interface PanelState {
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
  exaggeration: number;
}

function loadState(): PanelState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { visible: {}, opacity: {}, exaggeration: 1.3 };
}

function saveState(s: PanelState) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function installPanel(map: maplibregl.Map) {
  const drawer = document.getElementById('drawer')!;
  const toggle = document.getElementById('drawerToggle')!;
  const state = loadState();

  const isVisible = (g: LayerGroup) => state.visible[g.key] !== false;
  const getOpacity = (g: LayerGroup) => state.opacity[g.key] ?? 1;

  function applyGroup(g: LayerGroup) {
    const vis = isVisible(g) ? 'visible' : 'none';
    for (const prefix of g.match) {
      for (const layer of map.getStyle().layers) {
        if (!layer.id.startsWith(prefix)) continue;
        map.setLayoutProperty(layer.id, 'visibility', vis);
        const op = getOpacity(g);
        if (g.hasOpacity) {
          if (layer.type === 'line') map.setPaintProperty(layer.id, 'line-opacity', op);
          if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-opacity', op);
          if (layer.type === 'raster') map.setPaintProperty(layer.id, 'raster-opacity', op);
          if (layer.type === 'symbol') map.setPaintProperty(layer.id, 'text-opacity', op);
        }
      }
    }
  }

  function applyTerrain(on: boolean, ex: number) {
    if (!map.getSource('dem')) return;
    map.setTerrain(on ? { source: 'dem', exaggeration: ex } : null);
  }

  function build() {
    drawer.innerHTML = '<h3>图层</h3>';
    for (const g of LAYER_GROUPS) {
      const h = document.createElement('h3');
      drawer.appendChild(h); // 分组标题留空占位，保持扁平列表
      h.remove();

      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isVisible(g);
      cb.onchange = () => {
        state.visible[g.key] = cb.checked;
        saveState(state);
        if (g.key === 'terrain') applyTerrain(cb.checked, state.exaggeration);
        else applyGroup(g);
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(g.label));
      drawer.appendChild(label);

      if (g.key === 'terrain') {
        const row = document.createElement('div');
        row.className = 'slider-row';
        const val = document.createElement('div');
        val.className = 'val';
        val.textContent = `夸张度 ${state.exaggeration.toFixed(1)}`;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1.0'; slider.max = '2.0'; slider.step = '0.1';
        slider.value = String(state.exaggeration);
        slider.oninput = () => {
          state.exaggeration = parseFloat(slider.value);
          val.textContent = `夸张度 ${state.exaggeration.toFixed(1)}`;
          saveState(state);
          if (isVisible(g)) applyTerrain(true, state.exaggeration);
        };
        row.appendChild(slider);
        row.appendChild(val);
        drawer.appendChild(row);
      } else if (g.hasOpacity) {
        const row = document.createElement('div');
        row.className = 'slider-row';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = '1'; slider.step = '0.05';
        slider.value = String(getOpacity(g));
        slider.oninput = () => {
          state.opacity[g.key] = parseFloat(slider.value);
          saveState(state);
          applyGroup(g);
        };
        row.appendChild(slider);
        drawer.appendChild(row);
      }
    }
  }

  function applyAll() {
    for (const g of LAYER_GROUPS) {
      if (g.key === 'terrain') applyTerrain(isVisible(g), state.exaggeration);
      else applyGroup(g);
    }
  }

  toggle.onclick = () => drawer.classList.toggle('hidden');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') drawer.classList.toggle('hidden');
    if (e.key === 'Escape') drawer.classList.add('hidden');
    if (e.key === 't' || e.key === 'T') {
      const g = LAYER_GROUPS[0];
      state.visible[g.key] = !isVisible(g);
      saveState(state);
      applyTerrain(isVisible(g), state.exaggeration);
      const cb = drawer.querySelector('input[type=checkbox]') as HTMLInputElement | null;
      if (cb) cb.checked = isVisible(g);
    }
  });

  map.on('load', () => {
    build();
    applyAll();
  });
}
