// Shared chart scaffolding and pure helpers. DOM and d3 are only touched inside functions.
import { MINUS, fmtPct, fmtPp, fmtPpBare, fmtRatio, fmtNum, fmtLp, fmtMonth } from '../lib/format.js?v=20260912';

// Fallbacks only; tokens.css (SHELL) is authoritative. Dark ramps are listed near-surface first.
const LIGHT = {
  '--c-ndx': '#2a78d6', '--c-spx': '#eb6834', '--c-ust': '#1baf7a', '--c-pos': '#2a78d6', '--c-neg': '#eb6834', '--c-mid': '#f0efec',
  '--ink': '#0b0b0b', '--ink-2': '#52514e', '--muted': '#898781', '--grid': '#e1e0d9', '--axis': '#c3c2b7',
  '--surface': '#fcfcfb', '--page': '#f9f9f7', '--border': 'rgba(11,11,11,.10)',
  '--seq-100': '#cde2fb', '--seq-200': '#9ec5f4', '--seq-300': '#6da7ec', '--seq-400': '#3987e5',
  '--seq-500': '#256abf', '--seq-600': '#184f95', '--seq-700': '#0d366b',
  '--gray-100': '#e1e0d9', '--gray-200': '#a6a49c', '--gray-300': '#898781', '--gray-400': '#6e6c67', '--gray-500': '#52514e',
};
const DARK = {
  ...LIGHT,
  '--c-ndx': '#3987e5', '--c-spx': '#d95926', '--c-ust': '#199e70', '--c-pos': '#3987e5', '--c-neg': '#d95926', '--c-mid': '#504f4b',
  '--ink': '#ffffff', '--ink-2': '#c3c2b7', '--grid': '#2c2c2a', '--axis': '#383835',
  '--surface': '#1a1a19', '--page': '#0d0d0d', '--border': 'rgba(255,255,255,.10)',
  '--seq-100': '#0d366b', '--seq-200': '#184f95', '--seq-300': '#256abf', '--seq-400': '#3987e5',
  '--seq-500': '#6da7ec', '--seq-600': '#9ec5f4', '--seq-700': '#cde2fb',
  '--gray-100': '#383835', '--gray-200': '#54534f', '--gray-300': '#6e6c67', '--gray-400': '#898781', '--gray-500': '#a6a49c',
};
export const TOKEN_NAMES = Object.keys(LIGHT);
export const FALLBACK_TOKENS = { light: LIGHT, dark: DARK };
export const ASSET_COLOR_VARS = ['--c-ndx', '--c-spx', '--c-ust'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---------- colour ---------- */

export function parseColor(str) {
  const s = String(str ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return p.length >= 3 && p.slice(0, 3).every(Number.isFinite) ? { r: p[0], g: p[1], b: p[2], a: isNum(p[3]) ? p[3] : 1 } : null;
}

export function luminance(str) {
  const c = parseColor(str);
  if (!c) return 0;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Order ramp stops from "near surface" (low magnitude) to "far" so either token convention works. */
export const orderRamp = (colors, surface) =>
  colors.map((c, i) => [c, i]).sort((a, b) => contrastRatio(a[0], surface) - contrastRatio(b[0], surface) || a[1] - b[1]).map((d) => d[0]);

/** Text colour (ink or surface) that best clears a fill. */
export const textOn = (fill, t) => (contrastRatio(fill, t['--ink']) >= contrastRatio(fill, t['--surface']) ? t['--ink'] : t['--surface']);

export const prefersDark = () => !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function readTokens(el) {
  const dark = prefersDark();
  const base = dark ? DARK : LIGHT;
  const cs = globalThis.getComputedStyle ? getComputedStyle(el) : null;
  const t = { dark };
  for (const name of TOKEN_NAMES) t[name] = cs?.getPropertyValue(name).trim() || base[name];
  t.seq = orderRamp([100, 200, 300, 400, 500, 600, 700].map((k) => t[`--seq-${k}`]), t['--surface']);
  t.gray = orderRamp([100, 200, 300, 400, 500].map((k) => t[`--gray-${k}`]), t['--surface']);
  t.color = (v) => (typeof v === 'string' && v.startsWith('--') ? t[v] ?? (cs?.getPropertyValue(v).trim() || t['--ink']) : v || t['--ink']);
  return t;
}

/* ---------- formatting for axes and tooltips ---------- */

export const dpForStep = (step, scale = 1) => (step > 0 ? clamp(-Math.floor(Math.log10(step * scale) + 1e-9), 0, 3) : 1);

export function tickFormatter(kind, step = 0) {
  switch (kind) {
    case 'pp': { const dp = dpForStep(step, 100); return (v) => fmtPpBare(v, dp); }
    case 'pct': { const dp = dpForStep(step, 100); return (v) => fmtPct(v, dp); }
    case 'ratio': return (v) => { const dp = [0, 1, 2].find((d) => Math.abs(+v.toFixed(d) - v) < 1e-9) ?? 2; return fmtRatio(v, dp); };
    case 'month': return (v) => String(Math.floor(v / 12));
    default: { const dp = dpForStep(step); return (v) => fmtNum(v, dp); }
  }
}

export function valueFormatter(kind) {
  switch (kind) {
    case 'pp': return (v) => fmtPp(v);
    case 'pct': return (v) => fmtPct(v);
    case 'ratio': return (v) => fmtRatio(v);
    case 'lp': return (v) => fmtLp(v);
    case 'month': return (v) => fmtMonth(v);
    case 'sharpe': case 'num': return (v) => fmtNum(v, 2);
    default: return typeof kind === 'function' ? kind : (v) => fmtNum(v, 2);
  }
}

/* ---------- months and ticks ---------- */

export const monthIndex = (s) => { const m = /^(\d{4})-(\d{2})/.exec(String(s)); return m ? +m[1] * 12 + (+m[2] - 1) : NaN; };
export const monthFromIndex = (i) => `${Math.floor(i / 12)}-${String((((i % 12) + 12) % 12) + 1).padStart(2, '0')}`;
export const addMonths = (s, n) => monthFromIndex(monthIndex(s) + n);

/** January month indices between i0 and i1 with a 1/2/5/10/20-year step giving ≤ maxTicks ticks. */
export function yearTicks(i0, i1, maxTicks = 8) {
  const y0 = Math.ceil(i0 / 12), y1 = Math.floor(i1 / 12);
  for (const step of [1, 2, 5, 10, 20, 50]) {
    const ticks = [];
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) ticks.push(y * 12);
    if (ticks.length <= Math.max(2, maxTicks)) return ticks;
  }
  return [];
}

/** Finest of 1-1.5-2-3-5-7 / 1-2-5 / 1-3 / 1 log ticks that fits maxCount inside [lo, hi]; [] when fewer than two fit. */
export function logTicks(lo, hi, maxCount = 6) {
  if (!(lo > 0) || !(hi > lo)) return [];
  const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
  for (const mults of [[1, 1.5, 2, 3, 5, 7], [1, 2, 5], [1, 3], [1]]) {
    const t = [];
    for (let e = e0; e <= e1; e++) {
      for (const m of mults) {
        const v = +(m * 10 ** e).toPrecision(12);
        if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) t.push(v);
      }
    }
    if (t.length <= maxCount) return t.length >= 2 ? t : [];
  }
  const t = [];
  const every = Math.ceil((e1 - e0 + 1) / maxCount);
  for (let e = e0; e <= e1; e += every) if (10 ** e >= lo && 10 ** e <= hi) t.push(10 ** e);
  return t.length >= 2 ? t : [];
}

/** Index of the value in a sorted numeric array closest to v. */
export function nearestIndex(arr, v) {
  const n = arr?.length ?? 0;
  if (!n) return -1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
  return Math.abs(arr[hi] - v) < Math.abs(arr[lo] - v) ? hi : lo;
}

/** Greedy multi-row label placement: items [{x, width}] → [{row (−1 = hidden), x, left, right}]. */
export function layoutLabels(items, { left = 0, right = Infinity, gap = 6, maxRows = 2 } = {}) {
  const out = new Array(items.length);
  const ends = [];
  const order = items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x);
  for (const i of order) {
    const { x, width } = items[i];
    const cx = right - left >= width ? clamp(x, left + width / 2, right - width / 2) : x;
    const l = cx - width / 2;
    let row = ends.findIndex((end) => l >= end + gap);
    if (row === -1 && ends.length < maxRows) { row = ends.length; ends.push(-Infinity); }
    if (row === -1) { out[i] = { row: -1, x: cx, left: l, right: l + width }; continue; }
    ends[row] = l + width;
    out[i] = { row, x: cx, left: l, right: l + width };
  }
  return out;
}

export const boxesOverlap = (a, b, pad = 2) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮';
export const circled = (i) => CIRCLED[i] ?? String(i + 1);

/* ---------- table downsampling ---------- */

export const januaryIndices = (months) => {
  const idx = [];
  months.forEach((m, i) => { if (String(m).endsWith('-01')) idx.push(i); });
  return idx.length ? idx : months.length ? [0] : [];
};

export const yearEndIndices = (months) => {
  const n = months.length;
  if (!n) return [];
  const set = new Set([0, n - 1]);
  months.forEach((m, i) => { if (String(m).endsWith('-12')) set.add(i); });
  return [...set].sort((a, b) => a - b);
};

export function sampleIndices(n, maxRows) {
  if (n <= maxRows) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (maxRows - 1));
  const idx = [];
  for (let i = 0; i < n - 1; i += step) idx.push(i);
  idx.push(n - 1);
  return idx;
}

export const toArray = (a) => (a == null ? [] : Array.isArray(a) ? a : Array.from(a));

/* ---------- marker shapes ---------- */

export const STROKED_SHAPES = new Set(['ring', 'cross', 'plus']);
export const SHAPE_GLYPH = { star: '★', diamond: '◆', triangle: '▲', square: '■', triangleDown: '▼', ring: '○', cross: '✕', plus: '＋', circle: '●' };

export function shapePath(shape, r = 5) {
  const f = (n) => +n.toFixed(2);
  const poly = (pts) => `M${pts.map(([x, y]) => `${f(x)},${f(y)}`).join('L')}Z`;
  switch (shape) {
    case 'star': return poly(Array.from({ length: 10 }, (_, k) => {
      const rad = k % 2 ? r * 0.55 : r * 1.35, a = -Math.PI / 2 + (k * Math.PI) / 5;
      return [rad * Math.cos(a), rad * Math.sin(a)];
    }));
    case 'diamond': return poly([[0, -r * 1.3], [r * 1.05, 0], [0, r * 1.3], [-r * 1.05, 0]]);
    case 'triangle': return poly([[0, -r * 1.25], [r * 1.15, r * 0.8], [-r * 1.15, r * 0.8]]);
    case 'triangleDown': return poly([[0, r * 1.25], [r * 1.15, -r * 0.8], [-r * 1.15, -r * 0.8]]);
    case 'square': { const s = r * 0.9; return poly([[-s, -s], [s, -s], [s, s], [-s, s]]); }
    case 'cross': { const s = r * 0.9; return `M${f(-s)},${f(-s)}L${f(s)},${f(s)}M${f(s)},${f(-s)}L${f(-s)},${f(s)}`; }
    case 'plus': { const s = r * 1.1; return `M${f(-s)},0L${f(s)},0M0,${f(-s)}L0,${f(s)}`; }
    default: return `M${f(r)},0A${f(r)},${f(r)} 0 1,1 ${f(-r)},0A${f(r)},${f(r)} 0 1,1 ${f(r)},0Z`;
  }
}

/** Draw a marker into a d3 selection: 2px surface ring, optional 1.5× size + halo when active. */
export function drawShape(sel, { shape = 'circle', r = 5, color, surface, active = false }) {
  const g = sel.append('g').attr('class', 'ip-marker');
  const rr = active ? r * 1.5 : r;
  if (active) g.append('circle').attr('r', rr * 1.35 + 4).attr('fill', 'none').attr('stroke', color).attr('stroke-opacity', 0.3).attr('stroke-width', 3);
  const d = shapePath(shape, rr);
  if (STROKED_SHAPES.has(shape)) {
    g.append('path').attr('d', d).attr('fill', shape === 'ring' ? surface : 'none').attr('stroke', surface).attr('stroke-width', 6).attr('stroke-linecap', 'round');
    g.append('path').attr('d', d).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('stroke-linecap', 'round');
  } else {
    g.append('path').attr('d', d).attr('fill', color).attr('stroke', surface).attr('stroke-width', 4)
      .attr('stroke-linejoin', 'round').attr('paint-order', 'stroke');
  }
  return g;
}

/* ---------- DOM helpers (browser only) ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

const STYLE = `
:where(.ip-chart){position:relative;min-width:0;max-width:100%;color:var(--ink)}
:where(.ip-chart svg){display:block;max-width:100%;overflow:visible;font-family:inherit;font-size:12px;-webkit-tap-highlight-color:transparent}
:where(.ip-chart svg:focus){outline:none}
:where(.ip-chart svg:focus-visible){outline:2px solid var(--c-ndx);outline-offset:2px;border-radius:4px}
:where(.ip-chart canvas){display:block;position:absolute;pointer-events:none}
:where(.ip-chart .ip-tick){font-size:11px;font-variant-numeric:tabular-nums}
:where(.ip-legend){display:flex;flex-wrap:wrap;gap:4px 14px;margin:8px 0 0;padding:0;list-style:none;font-size:12px;line-height:1.5;color:var(--ink)}
:where(.ip-legend li){display:inline-flex;align-items:center;gap:6px;min-height:20px}
:where(.ip-legend svg){display:block;flex:none;overflow:visible}
:where(.ip-chart__note){margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--ink-2)}
:where(.ip-chart__empty){padding:20px 0;font-size:13px;color:var(--ink-2)}
:where(#chart-tooltip){position:fixed;left:0;top:0;z-index:1000;max-width:min(300px,calc(100vw - 16px));padding:8px 10px;border-radius:8px;background:var(--surface,#fcfcfb);color:var(--ink,#0b0b0b);border:1px solid var(--border,rgba(11,11,11,.1));box-shadow:0 6px 20px rgba(0,0,0,.16);font-size:12px;line-height:1.45;pointer-events:none}
:where(#chart-tooltip[hidden]){display:none}
:where(#chart-tooltip[data-pinned]){pointer-events:auto}
:where(#chart-tooltip .ip-tt__title){margin-bottom:4px;font-weight:600}
:where(#chart-tooltip .ip-tt__row){display:flex;align-items:center;gap:6px;white-space:nowrap}
:where(#chart-tooltip .ip-tt__value){font-weight:600;font-variant-numeric:tabular-nums}
:where(#chart-tooltip .ip-tt__label){color:var(--ink-2,#52514e)}
:where(#chart-tooltip .ip-tt__actions){display:flex;gap:8px;margin-top:8px}
:where(#chart-tooltip button){min-height:32px;padding:4px 12px;border-radius:6px;border:1px solid var(--border,rgba(11,11,11,.1));background:var(--page,#f9f9f7);color:inherit;font:inherit;cursor:pointer}
@media (pointer:coarse){:where(#chart-tooltip button){min-height:44px}}
:where(.ip-barcell){display:flex;flex-direction:column;align-items:stretch;gap:3px;min-width:56px}
:where(.ip-barcell__num){text-align:right;font-variant-numeric:tabular-nums}
:where(.ip-barcell__track){position:relative;display:block;height:4px}
:where(.ip-barcell__bar){position:absolute;top:0;height:4px;border-radius:1px}
:where(.ip-barcell__zero){position:absolute;top:-2px;width:1px;height:8px;background:var(--axis,#c3c2b7)}
`;

export function ensureStyles(doc = globalThis.document) {
  if (!doc || doc.querySelector('style[data-ip-charts]')) return;
  const s = doc.createElement('style');
  s.setAttribute('data-ip-charts', '');
  s.textContent = STYLE;
  doc.head.appendChild(s);
}

let measureCtx = null;
/** Rendered text width in px (canvas measure in the browser, rough estimate elsewhere). */
export function textWidth(text, px = 12, weight = 400) {
  const s = String(text ?? '');
  const doc = globalThis.document;
  if (doc) {
    measureCtx ??= doc.createElement('canvas').getContext('2d');
    if (measureCtx) {
      const family = globalThis.getComputedStyle?.(doc.body).fontFamily || 'system-ui, sans-serif';
      measureCtx.font = `${weight} ${px}px ${family}`;
      return Math.ceil(measureCtx.measureText(s).width);
    }
  }
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? px : px * 0.6;
  return Math.ceil(w);
}

export function keySwatch(doc, { kind = 'line', color, shape, surface = 'transparent' }) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  const el = (tag, attrs) => { const n = doc.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.appendChild(n); return n; };
  if (kind === 'rect') el('rect', { x: 2, y: 1, width: 11, height: 10, rx: 2, fill: color });
  else if (kind === 'shape') {
    const stroked = STROKED_SHAPES.has(shape);
    el('path', { d: shapePath(shape, 3.6), transform: 'translate(8 6)', fill: stroked ? (shape === 'ring' ? surface : 'none') : color, stroke: stroked ? color : 'none', 'stroke-width': stroked ? 1.6 : 0, 'stroke-linecap': 'round' });
  } else el('line', { x1: 1, x2: 15, y1: 6, y2: 6, stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', ...(kind === 'dash' ? { 'stroke-dasharray': '4 3' } : {}) });
  return svg;
}

/** HTML legend row: items [{label, color, kind:'line'|'dash'|'rect'|'shape', shape}]. */
export function legendRow(parent, items, surface) {
  const doc = parent.ownerDocument;
  const ul = doc.createElement('ul');
  ul.className = 'ip-legend';
  for (const it of items) {
    const li = doc.createElement('li');
    li.appendChild(keySwatch(doc, { ...it, surface }));
    const span = doc.createElement('span');
    span.textContent = it.label;
    li.appendChild(span);
    ul.appendChild(li);
  }
  parent.appendChild(ul);
  return ul;
}

export function note(parent, text, className = 'ip-chart__note') {
  const p = parent.ownerDocument.createElement('p');
  p.className = className;
  p.textContent = text;
  parent.appendChild(p);
  return p;
}

/** Create the base SVG (explicit pixel size, no viewBox scaling so pointer maths stays 1:1). */
export function baseSvg(d3, root, { width, height, title, ariaLabel, focusable = true }) {
  const svg = d3.select(root).append('svg')
    .attr('width', Math.max(0, width)).attr('height', Math.max(0, height))
    .attr('role', 'img').attr('aria-label', ariaLabel || title || '');
  if (focusable) svg.attr('tabindex', 0);
  if (title) svg.append('title').text(title);
  return svg;
}

/** Hairline axis text/lines drawn by hand (no d3-axis domain paths). */
export function axisBottom(g, scale, ticks, fmt, { y, x0, x1, tokens, gridTop = null }) {
  const t = g.append('g').attr('class', 'ip-axis');
  if (gridTop != null) {
    t.selectAll('line.grid').data(ticks).join('line').attr('class', 'grid')
      .attr('x1', (d) => scale(d)).attr('x2', (d) => scale(d)).attr('y1', gridTop).attr('y2', y)
      .attr('stroke', tokens['--grid']).attr('stroke-width', 1).attr('shape-rendering', 'crispEdges');
  }
  t.append('line').attr('x1', x0).attr('x2', x1).attr('y1', y + 0.5).attr('y2', y + 0.5).attr('stroke', tokens['--axis']);
  t.selectAll('text').data(ticks).join('text').attr('class', 'ip-tick')
    .attr('x', (d) => scale(d)).attr('y', y + 16).attr('text-anchor', 'middle').attr('fill', tokens['--ink-2']).text(fmt);
  return t;
}

export function axisLeftGrid(g, scale, ticks, fmt, { x, x1, tokens, grid = true }) {
  const t = g.append('g').attr('class', 'ip-axis');
  if (grid) {
    t.selectAll('line').data(ticks).join('line').attr('x1', x).attr('x2', x1)
      .attr('y1', (d) => Math.round(scale(d)) + 0.5).attr('y2', (d) => Math.round(scale(d)) + 0.5)
      .attr('stroke', tokens['--grid']).attr('stroke-width', 1);
  }
  t.selectAll('text').data(ticks).join('text').attr('class', 'ip-tick')
    .attr('x', x - 6).attr('y', (d) => scale(d)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('fill', tokens['--ink-2']).text(fmt);
  return t;
}

/** Client coordinates of an SVG-local point (for tooltip placement). */
export function clientPoint(svgNode, x, y) {
  const r = svgNode.getBoundingClientRect();
  return { x: r.left + x, y: r.top + y };
}

/** Arrow/Home/End/Page navigation → next index, or null when the key is not handled. */
export function stepIndex(key, i, n, { page = 12, shift = false } = {}) {
  if (n <= 0) return null;
  const step = shift ? page : 1;
  const c = (v) => clamp(v, 0, n - 1);
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return c(i + step);
    case 'ArrowLeft': case 'ArrowDown': return c(i - step);
    case 'PageUp': return c(i + page);
    case 'PageDown': return c(i - page);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/**
 * Chart scaffold: owns the root element, ResizeObserver, colour-scheme listener and key-based redraw skipping.
 * draw({root, width, props, tokens, d3, title, ariaLabel}) must fully rebuild root's children.
 */
export function createChart(el, { title = '', ariaLabel = '' } = {}, draw, { onDestroy } = {}) {
  const doc = el.ownerDocument;
  ensureStyles(doc);
  const root = doc.createElement('div');
  root.className = 'ip-chart';
  el.appendChild(root);
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  let props = null, drawn = null, raf = 0, alive = true;

  const render = (force) => {
    if (!alive || !props) return;
    const width = Math.max(0, Math.floor(root.getBoundingClientRect().width));
    const sig = { key: props.key, width, dark: !!mq?.matches };
    if (width < 1) { drawn = null; return; }
    if (!force && drawn && sig.key != null && sig.key === drawn.key && sig.width === drawn.width && sig.dark === drawn.dark) return;
    drawn = sig;
    try {
      draw({ root, width, props, tokens: readTokens(root), d3: globalThis.d3, title, ariaLabel });
    } catch (err) {
      console.error('[charts]', title, err);
      root.replaceChildren();
      note(root, '图表暂时无法显示', 'ip-chart__empty');
    }
  };
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => render(false)); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  ro?.observe(root);
  const onScheme = () => render(true);
  mq?.addEventListener?.('change', onScheme);

  return {
    root,
    update(next) { props = next; render(false); },
    redraw() { render(true); },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mq?.removeEventListener?.('change', onScheme);
      onDestroy?.();
      root.remove();
    },
  };
}

export { MINUS };
