import * as maplibregl from 'maplibre-gl';
import { DESTINATIONS } from '../destinations';

/**
 * 地点搜索（⌘K 命令面板）。
 *
 * 索引是离线生成的 `public/data/search.json`（columnar），首次打开面板才加载。
 * 匹配顺序：名称完全相等 → 名称前缀 → 名称子串 → 拼音前缀 → 拼音子串 → 首字母，
 * 再叠加类别权重和「离当前视图中心多远」的惩罚。
 */

interface Entry {
  name: string;
  lon: number;
  lat: number;
  type: string;
  ele: number;
  py: string;
  pyi: string;
}

/** 搜索结果的落点缩放：统一 z13（再近就只剩一片坡了） */
const SEARCH_ZOOM = 13;

/** 类型 → 落点俯角（山峰/营地这些给点立体感，村镇保持平视） */
const PITCH: Record<string, number> = {
  city: 0,
  town: 0,
  village: 0,
  hamlet: 0,
  district: 0,
  peak: 55,
  saddle: 55,
  hut: 55,
  camp: 55,
  viewpoint: 55,
  lake: 30,
  river: 0,
  trail: 30,
  road: 0,
  heritage: 20,
  worship: 20,
  attraction: 25,
  reserve: 30,
  reservoir: 20,
  station: 0,
  airport: 0,
  ski: 30,
};

const TYPE_LABEL: Record<string, string> = {
  city: '城市',
  town: '镇',
  village: '村',
  hamlet: '村庄',
  district: '片区',
  peak: '山峰',
  saddle: '垭口',
  hut: '山屋',
  camp: '营地',
  viewpoint: '观景台',
  lake: '湖泊',
  river: '河流',
  trail: '步道',
  road: '道路',
  heritage: '古迹',
  worship: '寺院',
  attraction: '景点',
  reserve: '景区',
  reservoir: '水库',
  station: '车站',
  airport: '机场',
  ski: '滑雪场',
};

const TYPE_BONUS: Record<string, number> = {
  city: 80, town: 70, village: 55, hamlet: 40, district: 35,
  peak: 75, saddle: 65, hut: 70, camp: 65, viewpoint: 50,
  lake: 60, river: 30, trail: 55, road: 45,
  heritage: 55, worship: 58, attraction: 66, reserve: 66,
  reservoir: 34, station: 62, airport: 78, ski: 64,
};

const ICONS: Record<string, string> = {
  place: '<circle cx="12" cy="12" r="3.2"/>',
  peak: '<path d="m3 18 6-9 3.5 5 2.5-3 6 7z"/>',
  saddle: '<path d="m2 18 5-6 3 3 2-2.5 3 3 4-5"/><path d="M2 18h20"/>',
  hut: '<path d="M4 19V11l8-5 8 5v8"/><path d="M9 19v-5h6v5"/>',
  camp: '<path d="m12 5 7 14H5L12 5Z"/><path d="M12 12v7"/>',
  viewpoint: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.4"/>',
  water: '<path d="M12 3s5.5 6.2 5.5 10a5.5 5.5 0 0 1-11 0C6.5 9.2 12 3 12 3Z"/>',
  heritage: '<path d="M4 20h16"/><path d="M6 20V10l6-4 6 4v10"/><path d="M10 20v-5h4v5"/>',
  worship: '<path d="M12 3 5 8h14L12 3Z"/><path d="M4 12h16"/><path d="M8 12v8M16 12v8"/><path d="M4 20h16"/>',
  attraction: '<path d="m12 3 2.4 6.1L21 11l-6.6 1.9L12 19l-2.4-6.1L3 11l6.6-1.9L12 3Z"/>',
  reserve: '<path d="M12 3 7 11h3l-3 5h10l-3-5h3L12 3Z"/><path d="M12 16v5"/>',
  station: '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 9h14"/><path d="M9 20l2-4M15 20l-2-4M3 20h18"/>',
  airport: '<path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v4l2.5 2v1.5L12 19l-4 1.5V19l2.5-2v-4l-7 2v-2l7-4V3.5Z"/>',
  ski: '<path d="M3 20 14 7"/><path d="M9 20h11"/><circle cx="7.5" cy="6.5" r="2.2"/><path d="m10 11 3 2 3-1"/>',
  trail: '<path d="M4 20c4-2 3-6 7-8s3-6 7-8" stroke-dasharray="3 3"/>',
  road: '<path d="M7 21 9 3M17 21 15 3"/><path d="M12 6v2M12 12v2M12 18v2"/>',
};

function iconFor(type: string): string {
  let key = 'place';
  if (type === 'peak') key = 'peak';
  else if (type === 'saddle') key = 'saddle';
  else if (type === 'hut') key = 'hut';
  else if (type === 'camp') key = 'camp';
  else if (type === 'viewpoint') key = 'viewpoint';
  else if (type === 'lake' || type === 'river' || type === 'reservoir') key = 'water';
  else if (type === 'heritage') key = 'heritage';
  else if (type === 'worship') key = 'worship';
  else if (type === 'attraction') key = 'attraction';
  else if (type === 'reserve') key = 'reserve';
  else if (type === 'station') key = 'station';
  else if (type === 'airport') key = 'airport';
  else if (type === 'ski') key = 'ski';
  else if (type === 'trail') key = 'trail';
  else if (type === 'road') key = 'road';
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key]}</svg>`
  );
}

/** 粗略的经纬度距离（km），只用于排序惩罚 */
function distanceKm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const dx = (aLon - bLon) * 111.32 * Math.cos((aLat * Math.PI) / 180);
  const dy = (aLat - bLat) * 110.57;
  return Math.hypot(dx, dy);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const RECENT_KEY = 'chuanxi-search-recent';

export function installSearch(map: maplibregl.Map) {
  let entries: Entry[] | null = null;
  let loading: Promise<Entry[]> | null = null;
  let marker: maplibregl.Marker | null = null;
  let results: Entry[] = [];
  let active = -1;
  let composing = false;

  // ── DOM ──────────────────────────────────────────────────
  const layer = el('div', 'search-layer hidden');
  const panel = el('div', 'search-panel glass');
  const row = el('div', 'search-row');
  row.innerHTML =
    '<svg class="search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'searchInput';
  input.placeholder = '搜索地点、山峰、营地…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const escHint = el('kbd', 'search-esc', 'esc');
  row.append(input, escHint);

  const list = el('div', 'search-results');
  const foot = el('div', 'search-foot');
  foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 前往</span>';

  panel.append(row, list, foot);
  layer.append(panel);
  document.body.append(layer);

  const btn = document.getElementById('searchBtn');
  btn?.addEventListener('click', () => toggle(true));

  // ── 索引 ──────────────────────────────────────────────────
  /** 主索引 + 附加区域索引（区域 B/C… 由 region-build.sh 生成），后者可能不存在 */
  const INDEX_FILES = ['/data/search.json', '/data/search-extra.json'];

  function parseIndex(d: any): Entry[] {
    const names: string[] = d.names ?? [];
    const types: string[] = d.types ?? [];
    const py: string[] = d.py ?? [];
    const pyi: string[] = d.pyi ?? [];
    const recs = d.recs ?? [];
    const out: Entry[] = new Array(recs.length);
    recs.forEach((r: number[], i: number) => {
      out[i] = {
        lon: r[0],
        lat: r[1],
        type: types[r[2]] ?? 'place',
        ele: r[3],
        name: names[r[4]] ?? '',
        py: py[r[4]] ?? '',
        pyi: pyi[r[4]] ?? '',
      };
    });
    return out;
  }

  function loadIndex(): Promise<Entry[]> {
    if (entries) return Promise.resolve(entries);
    if (loading) return loading;
    // no-store：索引会随数据重建，浏览器缓存住的旧版本会让新类型搜不到
    loading = Promise.all(
      INDEX_FILES.map((f) =>
        fetch(f, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    )
      .then((parts) => {
        const all = parts.filter(Boolean).flatMap((d) => parseIndex(d));
        if (!all.length) throw new Error('索引为空');
        entries = all;
        return all;
      })
      .catch((e) => {
        console.warn('[search] 索引不可用：', e);
        btn?.remove();
        throw e;
      });
    return loading;
  }

  // ── 查询 ──────────────────────────────────────────────────
  /**
   * 子序列匹配：query 的字符按顺序出现在目标串里，中间允许夹别的字。
   * 「色达五明佛学院」就是这么命中「色达喇荣五明佛学院」的——
   * 名字中间多了个「喇荣」，子串匹配断了，子序列还能连上。
   * 间隙越多分越低，避免太散的匹配排前面。
   */
  function subseq(hay: string, needle: string, base: number): number {
    if (!hay) return 0;
    let cursor = 0;
    let gaps = 0;
    let last = -1;
    for (const ch of needle) {
      const idx = hay.indexOf(ch, cursor);
      if (idx < 0) return 0;
      if (last >= 0) gaps += idx - last - 1;
      last = idx;
      cursor = idx + 1;
    }
    if (gaps > needle.length * 2 + 2) return 0;
    return Math.max(140, base - gaps * 6);
  }

  function scoreOf(e: Entry, q: string): number {
    const name = e.name.toLowerCase();
    const py = e.py;
    const pyi = e.pyi;
    let s = 0;
    if (name === q) s = 1000;
    else if (name.startsWith(q)) s = 820;
    else if (name.includes(q)) s = 620;
    else if (py && py === q) s = 700;
    else if (pyi && pyi === q) s = 680;
    else if (py && py.startsWith(q)) s = 520;
    else if (pyi && pyi.startsWith(q)) s = 500;
    else if (py && py.includes(q)) s = 380;
    else if (q.length >= 3) {
      // 名字里夹了别的字 / 打了部分拼音：退一步做子序列匹配
      s = Math.max(subseq(name, q, 330), subseq(py, q, 300), subseq(pyi, q, 290));
    } else if (q.length > 1) {
      return 0;
    }
    return s;
  }

  function search(qRaw: string): Entry[] {
    if (!entries) return [];
    const q = qRaw.trim().toLowerCase();
    if (!q) return [];
    const c = map.getCenter();
    const hits: Array<{ e: Entry; s: number }> = [];
    for (const e of entries) {
      const base = scoreOf(e, q);
      if (base <= 0) continue;
      const km = distanceKm(e.lon, e.lat, c.lng, c.lat);
      const s = base + (TYPE_BONUS[e.type] ?? 20) - Math.min(70, km / 12);
      hits.push({ e, s });
    }
    hits.sort((a, b) => b.s - a.s);
    return hits.slice(0, 8).map((h) => h.e);
  }

  // ── 渲染 ──────────────────────────────────────────────────
  function recent(): string[] {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  function pushRecent(name: string) {
    const list0 = [name, ...recent().filter((n) => n !== name)].slice(0, 5);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list0)); } catch { /* ignore */ }
  }

  function meta(e: Entry): string {
    const label = TYPE_LABEL[e.type] ?? '地点';
    return e.ele > -9999 ? `${label} · ${e.ele} m` : label;
  }

  function renderEmpty() {
    list.replaceChildren();
    active = -1;

    const rec = recent();
    const groups: Array<[string, Array<{ name: string; sub: string; go: () => void }>]> = [];

    groups.push(['推荐', DESTINATIONS.map((d) => ({
      name: d.name,
      sub: d.sub,
      go: () => {
        close();
        map.flyTo({ center: d.center, zoom: d.zoom, pitch: 60, duration: 2600 });
      },
    }))]);

    if (rec.length) {
      groups.push(['最近', rec.map((n) => ({
        name: n,
        sub: '',
        go: () => { input.value = n; runSearch(); input.focus(); },
      }))]);
    }

    for (const [title, items] of groups) {
      const h = el('div', 'search-group', title);
      list.append(h);
      for (const it of items) {
        const rowEl = el('button', 'search-item');
        rowEl.type = 'button';
        rowEl.innerHTML =
          `<span class="si-ico">${iconFor('peak')}</span>` +
          `<span class="si-name">${it.name}</span>` +
          `<span class="si-meta">${it.sub}</span>`;
        rowEl.addEventListener('click', it.go);
        list.append(rowEl);
      }
    }
  }

  function renderResults() {
    list.replaceChildren();
    active = results.length ? 0 : -1;

    if (!results.length) {
      list.append(el('div', 'search-empty', '没有匹配的地点，换个写法试试'));
      return;
    }
    results.forEach((e, i) => {
      const rowEl = el('button', 'search-item' + (i === active ? ' on' : ''));
      rowEl.type = 'button';
      rowEl.innerHTML =
        `<span class="si-ico">${iconFor(e.type)}</span>` +
        `<span class="si-name">${e.name}</span>` +
        `<span class="si-meta">${meta(e)}</span>`;
      rowEl.addEventListener('click', () => choose(e));
      rowEl.addEventListener('mousemove', () => setActive(i));
      list.append(rowEl);
    });
  }

  function setActive(i: number) {
    if (i === active) return;
    active = i;
    [...list.querySelectorAll('.search-item')].forEach((n, k) => {
      n.classList.toggle('on', k === i);
    });
    const cur = list.querySelectorAll('.search-item')[i];
    cur?.scrollIntoView({ block: 'nearest' });
  }

  function runSearch() {
    const q = input.value;
    if (!q.trim()) { renderEmpty(); return; }
    if (!entries) { list.replaceChildren(el('div', 'search-empty', '索引加载中…')); return; }
    results = search(q);
    renderResults();
  }

  // ── 选择 ──────────────────────────────────────────────────
  function choose(e: Entry) {
    close();
    pushRecent(e.name);

    if (marker) { marker.remove(); marker = null; }
    const pin = el('div', 'search-pin');
    pin.innerHTML = '<span></span>';
    marker = new maplibregl.Marker({ element: pin, anchor: 'bottom' })
      .setLngLat([e.lon, e.lat])
      .setPopup(
        new maplibregl.Popup({ offset: 26, closeButton: false, className: 'search-popup' })
          .setHTML(
            `<b>${e.name}</b><span>${meta(e)}</span>`,
          ),
      )
      .addTo(map);
    marker.togglePopup();

    map.flyTo({
      center: [e.lon, e.lat],
      zoom: SEARCH_ZOOM,
      pitch: PITCH[e.type] ?? 0,
      duration: 1800,
    });
  }

  // ── 开关 ──────────────────────────────────────────────────
  function open() {
    layer.classList.remove('hidden');
    document.body.classList.add('search-open');
    btn?.classList.add('on');
    input.value = '';
    renderEmpty();
    input.focus();
    void loadIndex().then(() => { if (!input.value.trim()) renderEmpty(); }).catch(() => close());
  }

  function close() {
    layer.classList.add('hidden');
    document.body.classList.remove('search-open');
    btn?.classList.remove('on');
    input.blur();
  }

  function toggle(force?: boolean) {
    const shouldOpen = force ?? layer.classList.contains('hidden');
    if (shouldOpen) open(); else close();
  }

  // ── 事件 ──────────────────────────────────────────────────
  input.addEventListener('input', () => {
    if (composing) return;
    runSearch();
  });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; runSearch(); });

  input.addEventListener('keydown', (ev) => {
    if (composing) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!results.length) return;
      const dir = ev.key === 'ArrowDown' ? 1 : -1;
      setActive((active + dir + results.length) % results.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const pick = results[active];
      if (pick) choose(pick);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });

  layer.addEventListener('mousedown', (ev) => {
    if (ev.target === layer) close();
  });

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      toggle(true);
      return;
    }
    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      toggle(true);
    }
  });

  // 地图被拖动时收掉结果面板，避免遮住操作
  map.on('movestart', () => {
    if (!layer.classList.contains('hidden')) close();
  });

  (window as any).__search = { open, close, isOpen: () => !layer.classList.contains('hidden') };
}
