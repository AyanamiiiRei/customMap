import * as maplibregl from 'maplibre-gl';

/**
 * 右下角视图控件：一个圆形「视角旋钮」+ 缩放 + 全屏。
 *
 * 旋钮把 MapLibre 那个又小又偏的指北针替掉了：
 *   · 横向拖动 = 转方位角，纵向拖动 = 调俯角
 *   · 单击（没有拖动）= 回正（正北 + 水平）
 *   · 拖动时旁边浮出实时读数（方位 / 俯角）
 */

const DEG_PER_PX = 0.42; // 横向灵敏度
const PITCH_PER_PX = 0.36; // 纵向灵敏度

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

export function installViewControls(map: maplibregl.Map) {
  // ── 容器 ──────────────────────────────────────────────────
  const cluster = document.createElement('div');
  cluster.className = 'ctrl-cluster';

  // 旋钮
  const knob = document.createElement('div');
  knob.className = 'view-knob';
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', '视角：拖动旋转，点击回正');
  knob.tabIndex = 0;
  knob.title = '拖动旋转视角，单击回正';
  knob.innerHTML = `
    <svg class="knob-ring" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="24.5" class="ring-bg"/>
      <circle cx="26" cy="26" r="24.5" class="ring-pitch" stroke-dasharray="0 999"/>
      ${[0, 45, 90, 135, 180, 225, 270, 315]
        .map((a) => {
          const major = a % 90 === 0;
          const r1 = major ? 19 : 21.5;
          const rad = ((a - 90) * Math.PI) / 180;
          const x1 = 26 + Math.cos(rad) * r1;
          const y1 = 26 + Math.sin(rad) * r1;
          const x2 = 26 + Math.cos(rad) * 23.5;
          const y2 = 26 + Math.sin(rad) * 23.5;
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="tick${major ? ' major' : ''}"/>`;
        })
        .join('')}
    </svg>
    <div class="knob-needle" aria-hidden="true">
      <svg viewBox="0 0 14 30">
        <path d="M7 1 12 15 7 12.6 2 15Z" class="needle-n"/>
        <path d="M7 29 2 15 7 17.4 12 15Z" class="needle-s"/>
      </svg>
    </div>
  `;

  const readout = document.createElement('div');
  readout.className = 'knob-readout';

  // 缩放 + 全屏
  const zoomBox = document.createElement('div');
  zoomBox.className = 'ctrl-stack';
  const mkBtn = (label: string, title: string, svg: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctrl-btn';
    b.title = title;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    return b;
  };
  const zoomIn = mkBtn('放大', '放大', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>');
  const zoomOut = mkBtn('缩小', '缩小', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 12h14"/></svg>');
  zoomIn.addEventListener('click', () => map.zoomIn({ duration: 220 }));
  zoomOut.addEventListener('click', () => map.zoomOut({ duration: 220 }));
  zoomBox.append(zoomIn, zoomOut);

  const fullBox = document.createElement('div');
  fullBox.className = 'ctrl-stack';
  const fs = mkBtn('全屏', '全屏', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>');
  fs.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  });
  fullBox.append(fs);

  knob.append(readout);
  const column = document.createElement('div');
  column.className = 'ctrl-column';
  column.append(zoomBox, fullBox);
  cluster.append(knob, column);
  document.body.append(cluster);

  // ── 状态同步 ──────────────────────────────────────────────
  const needle = knob.querySelector<HTMLElement>('.knob-needle')!;
  const pitchArc = knob.querySelector<SVGCircleElement>('.ring-pitch')!;
  const R = 24.5;
  const CIRC = 2 * Math.PI * R;

  function compassLabel(b: number): string {
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return dirs[Math.round(((b % 360) + 360) % 360 / 45) % 8];
  }

  function sync() {
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    needle.style.transform = `rotate(${-bearing}deg)`;
    // 俯角用外圈的一段弧表示（从正上方顺时针填充）
    const frac = clamp(pitch / map.getMaxPitch(), 0, 1);
    pitchArc.style.strokeDasharray = `${(CIRC * frac).toFixed(1)} ${CIRC.toFixed(1)}`;
    pitchArc.style.transform = 'rotate(-90deg)';
    pitchArc.style.transformOrigin = '26px 26px';
    knob.setAttribute('aria-valuetext', `方位 ${Math.round(bearing)}°，俯角 ${Math.round(pitch)}°`);
  }

  map.on('rotate', sync);
  map.on('pitch', sync);
  map.on('load', sync);
  sync();

  // ── 拖动旋转 ──────────────────────────────────────────────
  let dragging = false;
  let moved = 0;
  let startX = 0;
  let startY = 0;
  let startBearing = 0;
  let startPitch = 0;
  let raf = 0;

  function flush() {
    raf = 0;
    map.jumpTo({ bearing: bearingNow, pitch: pitchNow });
  }
  let bearingNow = 0;
  let pitchNow = 0;

  knob.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    knob.setPointerCapture(ev.pointerId);
    dragging = true;
    moved = 0;
    startX = ev.clientX;
    startY = ev.clientY;
    startBearing = map.getBearing();
    startPitch = map.getPitch();
    bearingNow = startBearing;
    pitchNow = startPitch;
    knob.classList.add('active');
  });

  knob.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    bearingNow = ((startBearing + dx * DEG_PER_PX) % 360 + 360) % 360;
    pitchNow = clamp(startPitch - dy * PITCH_PER_PX, 0, map.getMaxPitch());
    if (!raf) raf = requestAnimationFrame(flush);
    readout.classList.add('on');
    readout.textContent = `${compassLabel(bearingNow)} ${Math.round(bearingNow)}° · 俯角 ${Math.round(pitchNow)}°`;
  });

  function endDrag(ev: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    knob.classList.remove('active');
    readout.classList.remove('on');
    try { knob.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    if (moved < 4) {
      // 单击 = 回正
      map.easeTo({ bearing: 0, pitch: 0, duration: 620 });
    }
  }
  knob.addEventListener('pointerup', endDrag);
  knob.addEventListener('pointercancel', endDrag);

  knob.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 15 : 5;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); map.setBearing(map.getBearing() - step); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); map.setBearing(map.getBearing() + step); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); map.setPitch(clamp(map.getPitch() + step, 0, map.getMaxPitch())); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); map.setPitch(clamp(map.getPitch() - step, 0, map.getMaxPitch())); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); map.easeTo({ bearing: 0, pitch: 0, duration: 620 }); }
  });
}
