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
    if (raw) {
      const s = JSON.parse(raw) as PanelState;
      return { visible: s.visible ?? {}, opacity: s.opacity ?? {}, exaggeration: s.exaggeration ?? 1.3 };
    }
  } catch { /* ignore */ }
  return { visible: {}, opacity: {}, exaggeration: 1.3 };
}

function saveState(s: PanelState) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** 小工具：建一个带 class / 文本 / SVG 的元素 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** iOS 风格开关 */
function makeSwitch(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el('span', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => onChange(input.checked));
  const track = el('span', 'track');
  wrap.append(input, track);
  return wrap;
}

export function installPanel(map: maplibregl.Map) {
  const drawer = document.getElementById('drawer')!;
  const toggle = document.getElementById('drawerToggle') as HTMLButtonElement;
  const state = loadState();

  const isVisible = (g: LayerGroup) => state.visible[g.key] !== false;
  const getOpacity = (g: LayerGroup) => state.opacity[g.key] ?? 1;

  // ── 应用到地图 ────────────────────────────────────────────
  function applyGroup(g: LayerGroup) {
    const vis = isVisible(g) ? 'visible' : 'none';
    const op = getOpacity(g);
    for (const prefix of g.match) {
      for (const layer of map.getStyle().layers) {
        if (!layer.id.startsWith(prefix)) continue;
        map.setLayoutProperty(layer.id, 'visibility', vis);
        if (!g.hasOpacity) continue;
        if (layer.type === 'line') map.setPaintProperty(layer.id, 'line-opacity', op);
        if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-opacity', op);
        if (layer.type === 'raster') map.setPaintProperty(layer.id, 'raster-opacity', op);
        if (layer.type === 'symbol') map.setPaintProperty(layer.id, 'text-opacity', op);
      }
    }
  }

  function applyTerrain(on: boolean, ex: number) {
    if (!map.getSource('dem')) return;
    map.setTerrain(on ? { source: 'dem', exaggeration: ex } : null);
  }

  // ── 抽屉开关 ──────────────────────────────────────────────
  function setDrawer(open: boolean) {
    drawer.classList.toggle('hidden', !open);
    toggle.classList.toggle('on', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  const isOpen = () => !drawer.classList.contains('hidden');

  toggle.addEventListener('click', () => setDrawer(!isOpen()));

  // ── 构建界面 ──────────────────────────────────────────────
  function build() {
    drawer.replaceChildren();

    // 头部
    const head = el('div', 'drawer-head');
    head.append(el('h2', undefined, '图层'));
    head.append(el('span', 'sub', 'H 收起'));
    const close = el('button', 'drawer-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener('click', () => setDrawer(false));
    head.append(close);
    drawer.append(head);

    const body = el('div', 'drawer-body');
    drawer.append(body);

    // 地形卡片
    const terrain = LAYER_GROUPS.find((g) => g.key === 'terrain')!;
    const card = el('div', 'terrain-card');
    const row = el('div', 'row');
    const text = el('div');
    text.append(el('div', 'title', '地形 3D'));
    text.append(el('div', 'hint', '按 T 快速开关'));
    row.append(text);
    row.style.flex = '1';

    const sliderWrap = el('div', 'slider-wrap');
    sliderWrap.classList.toggle('off', !isVisible(terrain));
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1.0';
    slider.max = '2.0';
    slider.step = '0.1';
    slider.value = String(state.exaggeration);
    slider.setAttribute('aria-label', '地形夸张度');
    const meta = el('div', 'slider-meta');
    meta.append(el('span', undefined, '夸张度'));
    const metaVal = el('b');
    metaVal.textContent = `${state.exaggeration.toFixed(1)}×`;
    meta.append(metaVal);
    sliderWrap.append(slider, meta);

    const sw = makeSwitch(isVisible(terrain), (v) => {
      state.visible[terrain.key] = v;
      saveState(state);
      applyTerrain(v, state.exaggeration);
      sliderWrap.classList.toggle('off', !v);
    });
    row.append(sw);
    card.append(row, sliderWrap);
    body.append(card);

    slider.addEventListener('input', () => {
      state.exaggeration = parseFloat(slider.value);
      metaVal.textContent = `${state.exaggeration.toFixed(1)}×`;
      saveState(state);
      if (isVisible(terrain)) applyTerrain(true, state.exaggeration);
    });

    // 其它图层
    body.append(el('div', 'section-label', '叠加图层'));
    for (const g of LAYER_GROUPS) {
      if (g.key === 'terrain') continue;

      const wrap = el('div', 'layer-item');
      const line = el('div', 'layer-row');
      if (!isVisible(g)) line.classList.add('off');

      if (g.color) {
        const dot = el('span', 'swatch');
        dot.style.background = g.color;
        line.append(dot);
      }
      line.append(el('span', 'name', g.label));

      const op = el('div', 'op');
      let opSlider: HTMLInputElement | null = null;
      if (g.hasOpacity) {
        op.classList.toggle('hidden', !isVisible(g));
        opSlider = document.createElement('input');
        opSlider.type = 'range';
        opSlider.min = '0';
        opSlider.max = '1';
        opSlider.step = '0.05';
        opSlider.value = String(getOpacity(g));
        opSlider.setAttribute('aria-label', `${g.label} 透明度`);
        const opLabel = el('span', 'op-label', '透明度');
        const opVal = el('span', 'op-val');
        const syncOp = () => { opVal.textContent = `${Math.round(parseFloat(opSlider!.value) * 100)}%`; };
        syncOp();
        opSlider.addEventListener('input', () => {
          state.opacity[g.key] = parseFloat(opSlider!.value);
          syncOp();
          saveState(state);
          applyGroup(g);
        });
        op.append(opLabel, opSlider, opVal);
      }

      line.append(makeSwitch(isVisible(g), (v) => {
        state.visible[g.key] = v;
        saveState(state);
        applyGroup(g);
        line.classList.toggle('off', !v);
        op.classList.toggle('hidden', !v);
      }));

      wrap.append(line);
      if (opSlider) wrap.append(op);
      body.append(wrap);
    }

    // 底部快捷键
    const foot = el('div', 'drawer-foot');
    const hint = (k: string, label: string) => {
      const frag = el('span');
      const kb = el('kbd', undefined, k);
      frag.append(kb, document.createTextNode(` ${label}`));
      return frag;
    };
    foot.append(hint('T', '地形'), hint('H', '图层'), hint('Esc', '收起'));
    drawer.append(foot);
  }

  function applyAll() {
    for (const g of LAYER_GROUPS) {
      if (g.key === 'terrain') applyTerrain(isVisible(g), state.exaggeration);
      else applyGroup(g);
    }
  }

  // ── 快捷键 ────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'h' || e.key === 'H') setDrawer(!isOpen());
    if (e.key === 'Escape') setDrawer(false);
    if (e.key === 't' || e.key === 'T') {
      const g = LAYER_GROUPS[0];
      state.visible[g.key] = !isVisible(g);
      saveState(state);
      applyTerrain(isVisible(g), state.exaggeration);
      // 抽屉开着就同步一下开关和滑块的可用状态
      if (isOpen()) build();
    }
  });

  map.on('load', () => {
    build();
    applyAll();
  });
}
