import type * as maplibregl from 'maplibre-gl';
import { LAYER_GROUPS, type LayerGroup } from '../layers';
import { prefetchState } from '../prefetch';
import { perfStats } from './hud';

const LS_KEY = 'chuanxi-map-state-v2';

type Tab = 'layers' | 'graphics';
type PresetKey = 'saver' | 'balanced' | 'high' | 'custom';
type LodKey = 'low' | 'mid' | 'high';
type RatioKey = 'auto' | '1' | '1.5' | '2';
type AnisoKey = 'off' | 'default' | 'strong';

interface Graphics {
  preset: PresetKey;
  ratio: RatioKey;
  lod: LodKey;
  aniso: AnisoKey;
  prefetch: boolean;
  /** 相机中心高程是否跟随地面。关掉可以消除缩放后 DEM 到货引起的高度跳变 */
  followTerrain: boolean;
}

interface PanelState {
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
  exaggeration: number;
  tab: Tab;
  graphics: Graphics;
}

/** 远处细节：同屏 zoom 级数 / 瓦片倍率。级数调到 3 会在坡面产生分层带。 */
const LOD_PARAMS: Record<LodKey, [number, number]> = {
  low: [1, 1],
  mid: [2, 2],
  high: [3, 5],
};
/** 各向异性过滤生效的俯角阈值：越小越常用、越清晰也越慢 */
const ANISO_PITCH: Record<AnisoKey, number> = { off: 90, default: 20, strong: 0 };
const PRESETS: Record<Exclude<PresetKey, 'custom'>, Omit<Graphics, 'preset'>> = {
  saver: { ratio: '1', lod: 'low', aniso: 'off', prefetch: false, followTerrain: false },
  balanced: { ratio: 'auto', lod: 'mid', aniso: 'default', prefetch: true, followTerrain: false },
  high: { ratio: '2', lod: 'high', aniso: 'strong', prefetch: true, followTerrain: false },
};

const DEFAULT_STATE: PanelState = {
  visible: {},
  opacity: {},
  exaggeration: 1.3,
  tab: 'layers',
  graphics: {
    preset: 'balanced',
    ratio: 'auto',
    lod: 'mid',
    aniso: 'default',
    prefetch: true,
    followTerrain: false,
  },
};

function loadState(): PanelState {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem('chuanxi-map-state-v1');
    if (raw) {
      const s = JSON.parse(raw) as Partial<PanelState>;
      return {
        visible: s.visible ?? {},
        opacity: s.opacity ?? {},
        exaggeration: s.exaggeration ?? 1.3,
        tab: s.tab ?? 'layers',
        graphics: { ...DEFAULT_STATE.graphics, ...(s.graphics ?? {}) },
      };
    }
  } catch { /* ignore */ }
  return {
    ...DEFAULT_STATE,
    visible: { ...DEFAULT_STATE.visible },
    opacity: { ...DEFAULT_STATE.opacity },
    graphics: { ...DEFAULT_STATE.graphics },
  };
}

function saveState(s: PanelState) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

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

function makeSwitch(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el('span', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, el('span', 'track'));
  return wrap;
}

/** 一排互斥按钮 */
function makeSeg<K extends string>(
  items: Array<[K, string]>,
  active: K,
  onPick: (k: K) => void,
): HTMLElement {
  const seg = el('div', 'seg');
  for (const [key, label] of items) {
    const b = el('button', key === active ? 'on' : undefined, label);
    b.type = 'button';
    b.addEventListener('click', () => onPick(key));
    seg.append(b);
  }
  return seg;
}

export function installPanel(map: maplibregl.Map) {
  const drawer = document.getElementById('drawer')!;
  const toggle = document.getElementById('drawerToggle') as HTMLButtonElement;
  const state = loadState();

  const isVisible = (g: LayerGroup) => state.visible[g.key] !== false;
  const getOpacity = (g: LayerGroup) => state.opacity[g.key] ?? 1;

  // ── 图层可见性 / 透明度 ──────────────────────────────────
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

  // ── 图形设置 ─────────────────────────────────────────────
  function effectiveRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    if (state.graphics.ratio === 'auto') return Math.min(dpr, 2);
    return parseFloat(state.graphics.ratio);
  }

  function applyGraphics() {
    const g = state.graphics;
    map.setPixelRatio(effectiveRatio());
    const [levels, ratio] = LOD_PARAMS[g.lod];
    map.setSourceTileLodParams(levels, ratio);
    map.setAnisotropicFilterPitch(ANISO_PITCH[g.aniso]);
    prefetchState.enabled = g.prefetch;
    // 关掉「跟随地面高程」：MapLibre 在静止时每帧都会把相机中心高程重置成
    // 当前 DEM 在该点的值，缩放后新的 DEM 瓦片一到货高程就变，相机高度跟着跳。
    map.setCenterClampedToGround(g.followTerrain);
  }

  // ── 抽屉 ─────────────────────────────────────────────────
  function setDrawer(open: boolean) {
    drawer.classList.toggle('hidden', !open);
    toggle.classList.toggle('on', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  const isOpen = () => !drawer.classList.contains('hidden');
  toggle.addEventListener('click', () => setDrawer(!isOpen()));

  // ── 头部 ─────────────────────────────────────────────────
  function buildHeader() {
    const head = el('div', 'drawer-head');
    head.append(el('h2', undefined, '地图设置'));
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

    const tabs = el('div', 'tabs');
    const items: Array<[Tab, string]> = [['layers', '图层'], ['graphics', '图形']];
    for (const [key, label] of items) {
      const b = el('button', `tab${state.tab === key ? ' on' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        state.tab = key;
        saveState(state);
        build();
      });
      tabs.append(b);
    }
    drawer.append(tabs);
  }

  // ── 图层页 ───────────────────────────────────────────────
  function buildLayers(body: HTMLElement) {
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

    row.append(makeSwitch(isVisible(terrain), (v) => {
      state.visible[terrain.key] = v;
      saveState(state);
      applyTerrain(v, state.exaggeration);
      sliderWrap.classList.toggle('off', !v);
    }));
    card.append(row, sliderWrap);
    body.append(card);

    slider.addEventListener('input', () => {
      state.exaggeration = parseFloat(slider.value);
      metaVal.textContent = `${state.exaggeration.toFixed(1)}×`;
      saveState(state);
      if (isVisible(terrain)) applyTerrain(true, state.exaggeration);
    });

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
  }

  // ── 图形页 ───────────────────────────────────────────────
  function buildGraphics(body: HTMLElement) {
    const g = state.graphics;
    const set = (patch: Partial<Graphics>) => {
      Object.assign(state.graphics, patch, { preset: 'custom' });
      saveState(state);
      applyGraphics();
      build();
    };

    const stats = el('div', 'stats');
    const mk = (k: string) => {
      const card = el('div', 'stat');
      card.append(el('div', 'k', k));
      const v = el('div', 'v', '—');
      card.append(v);
      stats.append(card);
      return v;
    };
    const sFps = mk('FPS');
    const sRatio = mk('分辨率');
    const sZoom = mk('缩放');
    body.append(stats);

    const presetField = el('div', 'field');
    const pl = el('div', 'label');
    pl.append(el('span', undefined, '画质预设'));
    if (g.preset === 'custom') pl.append(el('b', undefined, '自定义'));
    presetField.append(pl);
    presetField.append(makeSeg<PresetKey>(
      [['saver', '省电'], ['balanced', '均衡'], ['high', '高画质']],
      g.preset,
      (k) => {
        if (k === 'custom') return;
        state.graphics = { ...PRESETS[k], preset: k };
        saveState(state);
        applyGraphics();
        build();
      },
    ));
    presetField.append(el('div', 'note', '预设只改下面四项，不影响地形开关与图层可见性。'));
    body.append(presetField);

    const ratioField = el('div', 'field');
    const rl = el('div', 'label');
    rl.append(el('span', undefined, '渲染分辨率'));
    rl.append(el('b', undefined, `${effectiveRatio().toFixed(2)}×`));
    ratioField.append(rl);
    ratioField.append(makeSeg<RatioKey>(
      [['1', '1×'], ['1.5', '1.5×'], ['2', '2×'], ['auto', '自动']],
      g.ratio,
      (k) => set({ ratio: k }),
    ));
    ratioField.append(el('div', 'note',
      '按设备像素比渲染。高分辨率屏上 2× 会让 GPU 负载翻两倍，卡就先降这个。'));
    body.append(ratioField);

    const lodField = el('div', 'field');
    const ll = el('div', 'label');
    ll.append(el('span', undefined, '远处地形细节'));
    const [lv2, lr] = LOD_PARAMS[g.lod];
    ll.append(el('b', undefined, `${lv2} 级 / ${lr}×`));
    lodField.append(ll);
    lodField.append(makeSeg<LodKey>(
      [['low', '省电'], ['mid', '均衡'], ['high', '锐利']],
      g.lod,
      (k) => set({ lod: k }),
    ));
    lodField.append(el('div', 'note',
      '俯视时地平线方向允许的 zoom 级数与瓦片密度。「锐利」在坡面上会出现分层带。'));
    body.append(lodField);

    const anisoField = el('div', 'field');
    const al = el('div', 'label');
    al.append(el('span', undefined, '远景清晰度'));
    anisoField.append(al);
    anisoField.append(makeSeg<AnisoKey>(
      [['off', '关'], ['default', '默认'], ['strong', '强']],
      g.aniso,
      (k) => set({ aniso: k }),
    ));
    anisoField.append(el('div', 'note', '各向异性过滤的俯角阈值，越早生效远处越锐，开销也越大。'));
    body.append(anisoField);

    const camField = el('div', 'field');
    const cl = el('div', 'label');
    cl.append(el('span', undefined, '相机'));
    camField.append(cl);
    const camRow = el('div', 'layer-row');
    camRow.append(el('span', 'name', '跟随地面高程'));
    camRow.append(makeSwitch(g.followTerrain, (v) => set({ followTerrain: v })));
    camField.append(camRow);
    camField.append(el('div', 'note',
      '开启后相机会贴着地面走（更贴近飞行感），但缩放后 DEM 瓦片到货时中心高程会被重置，' +
      '高度会跳一下。关掉则保持恒定高度基准，代价是相机不随地形起伏。'));
    body.append(camField);

    const pfField = el('div', 'field');
    const pfl = el('div', 'label');
    pfl.append(el('span', undefined, '空闲预取瓦片'));
    pfField.append(pfl);
    const pfRow = el('div', 'layer-row');
    pfRow.append(el('span', 'name', '预加载相邻 zoom 级'));
    pfRow.append(makeSwitch(g.prefetch, (v) => set({ prefetch: v })));
    pfField.append(pfRow);
    pfField.append(el('div', 'note', '关掉后缩放更依赖实时加载；磁盘或网络吃紧可以关。'));
    body.append(pfField);

    const tick = () => {
      if (state.tab !== 'graphics' || !body.isConnected) return;
      const fps = perfStats.fps;
      sFps.innerHTML = `${fps}<small>fps</small>`;
      sFps.style.color = fps >= 50 ? '#6fcf8b' : fps >= 30 ? '#f0b45a' : '#ef6b5e';
      sRatio.innerHTML = `${effectiveRatio().toFixed(2)}<small>×</small>`;
      sZoom.textContent = map.getZoom().toFixed(1);
      setTimeout(tick, 500);
    };
    setTimeout(tick, 200);
  }

  // ── 组装 ─────────────────────────────────────────────────
  function build() {
    drawer.replaceChildren();
    buildHeader();
    const body = el('div', 'drawer-body');
    drawer.append(body);
    if (state.tab === 'graphics') buildGraphics(body);
    else buildLayers(body);

    const foot = el('div', 'drawer-foot');
    const hint = (k: string, label: string) => {
      const frag = el('span');
      frag.append(el('kbd', undefined, k), document.createTextNode(` ${label}`));
      return frag;
    };
    foot.append(hint('T', '地形'), hint('H', '设置'), hint('Esc', '收起'));
    drawer.append(foot);
  }

  function applyAll() {
    for (const gg of LAYER_GROUPS) {
      if (gg.key === 'terrain') applyTerrain(isVisible(gg), state.exaggeration);
      else applyGroup(gg);
    }
    applyGraphics();
  }

  // ── 快捷键 ───────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'h' || e.key === 'H') setDrawer(!isOpen());
    if (e.key === 'Escape') setDrawer(false);
    if (e.key === 't' || e.key === 'T') {
      const gg = LAYER_GROUPS[0];
      state.visible[gg.key] = !isVisible(gg);
      saveState(state);
      applyTerrain(isVisible(gg), state.exaggeration);
      if (isOpen()) build();
    }
  });

  map.on('load', () => {
    build();
    applyAll();
  });
}
