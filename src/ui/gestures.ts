import type * as maplibregl from 'maplibre-gl';

/**
 * 抹掉「地形手势结束时的相机回弹」。
 *
 * MapLibre 在地形手势期间会冻结相机高程（拖动时保持等高），手势一结束就用**新采样**的
 * DEM 高程去对账：调 `transform.recalculateZoomAndCenter`，保持相机 3D 位置不动，
 * 反过来重算 center 和 zoom。俯角很陡时，冻结值与新值的差 Δe 会沿视线把中心滑走
 * `Δe · tan(pitch)`（85° 时约 11 倍）——在川西这种落差上就是「地图突然跑到几百公里外」。
 *
 * 官方给的解法：**只在手势窗口内**把 `getCenterClampedToGround()` 遮成 false，
 * 不要动字段本身。因为 v6 里有两个闸口会读它：
 *   · HandlerManager 读 Map 上的同名方法
 *   · Camera._finalizeElevation 读 `map._camera` 上的方法
 * 两个都得遮，且只能在 movestart→moveend 之间遮——静止时还要靠它每帧跟随地形，
 * 永久关掉会让相机「浮」在那里，平移时产生视差漂移（我们之前就是这么干的）。
 */

export function preventTerrainGestureSnap(map: maplibregl.Map) {
  const gates: any[] = [map as any, (map as any)._camera].filter(
    (g) => g && typeof g.getCenterClampedToGround === 'function',
  );
  const saved = new Map<any, () => boolean>();
  let depth = 0;

  const engage = () => {
    if (depth++ > 0) return;
    for (const gate of gates) {
      saved.set(gate, gate.getCenterClampedToGround);
      gate.getCenterClampedToGround = () => false;
    }
  };
  const release = () => {
    if (depth === 0 || --depth > 0) return;
    for (const [gate, fn] of saved) gate.getCenterClampedToGround = fn;
    saved.clear();
  };

  map.on('movestart', engage);
  map.on('moveend', release);
  // 保险：动画被打断时 moveend 可能不来
  map.on('remove', release);
  return release;
}

/**
 * Alt + 左键 = 绕屏幕中心旋转视角（MapLibre 原来 Shift 拖动的行为）。
 *
 * Shift + 左键已经交给 MapLibre 的 `dragRotate: { around: 'pointer' }`，
 * 那个实现是「抓住指针下的地形点旋转，该点保持不动」，还会跟着地形算高程，
 * 所以不自己写。这里只补 Alt 这一路：默认拖动是平移，必须拦下来。
 *
 * Linux 桌面上 Alt+拖动常被窗口管理器抢走，所以 Ctrl/Meta 也作为等价键。
 */

const BEARING_PER_PX = 0.45;
const PITCH_PER_PX = 0.45;

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

/**
 * MapLibre 6.15 把「旋转视角」绑到了 Ctrl+左键 / 右键，Shift+左键变成了框选缩放。
 * 这里直接改两个内部 move-state 判定：
 *   · 旋转：Ctrl 或 Shift + 左键（Shift 用 pointer 锚点模式，见 main.ts 的 dragRotate）
 *   · 平移：排除 Shift / Ctrl / Alt，避免和上面两种拖动打架
 * 拿不到内部字段时静默跳过，最坏退化回默认绑定。
 */
function patchHandlers(map: maplibregl.Map) {
  const patch = (handler: any, check: (e: MouseEvent) => boolean) => {
    if (!handler) return;
    for (const value of Object.values(handler)) {
      const mgr = (value as any)?._moveStateManager;
      if (mgr && typeof mgr.isValidStartEvent === 'function') mgr._correctEvent = check;
    }
  };
  patch((map as any).dragRotate, (e) =>
    (e.button === 0 && (e.ctrlKey || (e.shiftKey && !e.altKey))) || (e.button === 2 && !e.ctrlKey));
  patch((map as any).dragPan, (e) =>
    e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey);
}

export function installGestures(map: maplibregl.Map) {
  preventTerrainGestureSnap(map);
  patchHandlers(map);
  installAltRotate(map);
}

export function installAltRotate(map: maplibregl.Map) {
  const container = map.getCanvasContainer();
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startBearing = 0;
  let startPitch = 0;
  let bearing = 0;
  let pitch = 0;
  let raf = 0;

  const flush = () => {
    raf = 0;
    map.jumpTo({ bearing, pitch });
  };

  const isModifier = (e: PointerEvent | KeyboardEvent) => e.altKey || e.ctrlKey || e.metaKey;

  function onDown(ev: PointerEvent) {
    if (ev.button !== 0 || !isModifier(ev)) return;
    // 拦下 MapLibre 的 dragPan，否则会同时平移
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = ev.clientX;
    startY = ev.clientY;
    startBearing = map.getBearing();
    startPitch = map.getPitch();
    bearing = startBearing;
    pitch = startPitch;
    document.body.classList.add('alt-rotating');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onMove(ev: PointerEvent) {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    bearing = startBearing + dx * BEARING_PER_PX;
    pitch = clamp(startPitch - dy * PITCH_PER_PX, 0, map.getMaxPitch());
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('alt-rotating');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      map.jumpTo({ bearing, pitch });
    }
  }

  container.addEventListener('pointerdown', onDown, { capture: true });
  // 键盘 Alt 也会让部分浏览器切出焦点环，统一在画布上忽略
  container.addEventListener('contextmenu', (ev) => {
    if (isModifier(ev as unknown as PointerEvent)) ev.preventDefault();
  });
}
