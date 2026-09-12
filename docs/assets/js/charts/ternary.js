// §3 ternary surface: canvas heat (blue above 标普500, gray below), SPX-equal contours, markers, pin + 设为自定义.
import {
  createChart, baseSvg, clientPoint, toArray, textWidth, note, legendRow, drawShape, boxesOverlap, layoutLabels,
  SHAPE_GLYPH, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, fmtNum, fmtWeights } from '../lib/format.js?v=20260912';

let uid = 0;
const REFERENCE = new Set(['cross', 'plus']);
const METRIC_LABEL = { sharpe: '夏普比率', cagr: '年化复合收益' };
const metricFormat = (metric, table = false) => (metric === 'cagr' ? (v) => fmtPct(v, table ? 2 : 1) : (v) => fmtNum(v, 2));

/* ---------- pure geometry ---------- */

/** Vertices: A = 纳指100 (top), B = 标普500 (bottom-left), C = 10年美债 (bottom-right). */
export function triangle(side, left = 0, top = 0) {
  const h = (side * Math.sqrt(3)) / 2;
  return { side, h, A: [left + side / 2, top], B: [left, top + h], C: [left + side, top + h] };
}

export const toXY = (w, g) => [w[0] * g.A[0] + w[1] * g.B[0] + w[2] * g.C[0], w[0] * g.A[1] + w[1] * g.B[1] + w[2] * g.C[1]];

export function toWeights(x, y, g) {
  const [ax, ay] = g.A, [bx, by] = g.B, [cx, cy] = g.C;
  const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
  return [a, b, 1 - a - b];
}

/** Nearest lattice point as integer percents (multiples of stepPct) summing to 100. */
export function snapWeights(w, stepPct = 1) {
  const units = Math.round(100 / stepPct);
  const v = w.map((x) => Math.max(0, isNum(x) ? x : 0));
  const tot = v.reduce((s, x) => s + x, 0) || 1;
  const raw = v.map((x) => (x / tot) * units);
  const out = raw.map((x) => Math.floor(x + 1e-9));
  const order = raw.map((x, i) => [x - out[i], i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let k = 0, rest = units - out.reduce((s, x) => s + x, 0); rest > 0; k++, rest--) out[order[k % 3][1]] += 1;
  return out.map((x) => x * stepPct);
}

/** (i, j) percent → lattice index lookup (−1 when absent). */
export function latticeLookup(iArr, jArr) {
  const lut = new Int32Array(101 * 101).fill(-1);
  const n = Math.min(iArr?.length ?? 0, jArr?.length ?? 0);
  for (let k = 0; k < n; k++) lut[iArr[k] * 101 + jArr[k]] = k;
  return lut;
}

/** Marching triangles on the percent lattice → polylines of [ndxPct, spxPct] points at `level`. */
export function contourLines(lut, values, level, stepPct = 1) {
  const N = Math.round(100 / stepPct);
  const val = (a, b) => { const k = lut[a * stepPct * 101 + b * stepPct]; return k >= 0 ? values[k] : NaN; };
  const segs = [];
  const cross = (p, q) => {
    const [s, e] = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
    const f = (level - s[2]) / (e[2] - s[2]);
    return [(s[0] + f * (e[0] - s[0])) * stepPct, (s[1] + f * (e[1] - s[1])) * stepPct];
  };
  const tri = (p) => {
    if (p.some((v) => !isNum(v[2]))) return;
    const up = p.map((v) => v[2] >= level);
    const nUp = up.filter(Boolean).length;
    if (nUp === 0 || nUp === 3) return;
    const pts = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) if (up[a] !== up[b]) pts.push(cross(p[a], p[b]));
    if (pts.length === 2) segs.push(pts);
  };
  for (let a = 0; a < N; a++) {
    for (let b = 0; a + b < N; b++) {
      tri([[a, b, val(a, b)], [a + 1, b, val(a + 1, b)], [a, b + 1, val(a, b + 1)]]);
      if (a + b < N - 1) tri([[a + 1, b, val(a + 1, b)], [a, b + 1, val(a, b + 1)], [a + 1, b + 1, val(a + 1, b + 1)]]);
    }
  }
  // Chain segments sharing endpoints.
  const key = (pt) => `${pt[0].toFixed(6)},${pt[1].toFixed(6)}`;
  const ends = new Map();
  segs.forEach((s, i) => { for (const pt of s) { const k = key(pt); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const extend = (line, fromEnd) => {
    for (;;) {
      const tip = fromEnd ? line[line.length - 1] : line[0];
      const next = (ends.get(key(tip)) ?? []).find((i) => !used[i]);
      if (next == null) return;
      used[next] = 1;
      const [p, q] = segs[next];
      const other = key(p) === key(tip) ? q : p;
      if (fromEnd) line.push(other); else line.unshift(other);
    }
  };
  segs.forEach((s, i) => {
    if (used[i]) return;
    used[i] = 1;
    const line = [s[0], s[1]];
    extend(line, true);
    extend(line, false);
    lines.push(line);
  });
  return lines;
}

const percentToW = (pct) => [pct[0] / 100, pct[1] / 100, (100 - pct[0] - pct[1]) / 100];

export function toTable(props) {
  const lut = latticeLookup(toArray(props?.i), toArray(props?.j));
  const values = toArray(props?.values);
  const metric = props?.metric ?? 'sharpe';
  const extra = (props?.contours ?? []).filter((c) => c.metric && c.metric !== metric);
  const fmt = metricFormat(metric, true);
  const raw = [];
  for (let a = 0; a <= 100; a += 10) {
    for (let b = 0; a + b <= 100; b += 10) {
      const k = lut[a * 101 + b];
      raw.push(['', a, b, 100 - a - b, k >= 0 ? values[k] : null, ...extra.map((c) => (k >= 0 ? toArray(c.values)[k] : null))]);
    }
  }
  const step = Math.max(1, Math.round((props?.step ?? 0.01) * 100));
  for (const mk of props?.markers ?? []) {
    if (!mk.w) continue;
    const [a, b, c] = snapWeights(mk.w, step);
    const k = lut[a * 101 + b];
    raw.push([`${SHAPE_GLYPH[mk.shape] ?? ''} ${mk.label}`.trim(), a, b, c, k >= 0 ? values[k] : null, ...extra.map((cc) => (k >= 0 ? toArray(cc.values)[k] : null))]);
  }
  return {
    columns: ['点', '纳指', '标普', '美债', METRIC_LABEL[metric] ?? metric, ...extra.map((c) => METRIC_LABEL[c.metric] ?? c.label)],
    rows: raw.map(([label, a, b, c, v, ...ev]) => [label || '网格', `${a}%`, `${b}%`, `${c}%`, fmt(v), ...ev.map((x, i) => metricFormat(extra[i].metric, true)(x))]),
    raw,
  };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let pinned = null; // integer percents [ndx, spx, ust]
  let cursor = null; // keyboard position, integer percents
  let lastPinnedProp = null;
  let applying = false; // 设为自定义 closes the pin without reporting onPin(null)
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const iArr = toArray(props.i), jArr = toArray(props.j), values = props.values ?? [];
    const n = Math.min(iArr.length, jArr.length, values.length);
    if (n < 3) { note(root, props.emptyText ?? '暂无组合网格', 'ip-chart__empty'); return; }
    const stepPct = Math.max(1, Math.round((props.step ?? 0.01) * 100));
    const lut = latticeLookup(iArr, jArr);
    const metric = props.metric ?? 'sharpe';
    const fmt = metricFormat(metric);
    const spx = props.spxValue;

    const side = clamp(width - 24, 0, 520);
    if (side < 120) { note(root, '区域过窄', 'ip-chart__empty'); return; }
    const left = (width - side) / 2, top = 26;
    const g = triangle(side, left, top);
    const legendY = top + g.h + 48;
    const height = legendY + 52;
    root.style.position = 'relative';

    // Colour scale: sequential blue over [spx, max], gray ramp over [min, spx].
    let vMin = Infinity, vMax = -Infinity;
    for (let k = 0; k < n; k++) { const v = values[k]; if (isNum(v)) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); } }
    const ref = isNum(spx) ? clamp(spx, vMin, vMax) : (vMin + vMax) / 2;
    const blue = d3.piecewise(d3.interpolateLab, t.seq);
    const gray = d3.piecewise(d3.interpolateLab, t.gray.slice(0, 3));
    const colorOf = (v) => (v >= ref ? blue(vMax > ref ? (v - ref) / (vMax - ref) : 0) : gray(ref > vMin ? (ref - v) / (ref - vMin) : 0));

    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const canvas = root.ownerDocument.createElement('canvas');
    const cw = Math.ceil(side * dpr), ch = Math.ceil(g.h * dpr);
    canvas.width = cw;
    canvas.height = ch;
    Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${side}px`, height: `${g.h}px` });
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const lutRGB = new Uint8ClampedArray(n * 3);
      for (let k = 0; k < n; k++) {
        const c = d3.rgb(isNum(values[k]) ? colorOf(values[k]) : t['--surface']);
        lutRGB[k * 3] = c.r; lutRGB[k * 3 + 1] = c.g; lutRGB[k * 3 + 2] = c.b;
      }
      const img = ctx.createImageData(cw, ch);
      const units = 100 / stepPct;
      for (let py = 0; py < ch; py++) {
        const yy = top + (py + 0.5) / dpr;
        const f = (yy - top) / g.h;
        const xl = Math.floor((g.A[0] + f * (g.B[0] - g.A[0]) - left) * dpr), xr = Math.ceil((g.A[0] + f * (g.C[0] - g.A[0]) - left) * dpr);
        for (let px = Math.max(0, xl); px < Math.min(cw, xr); px++) {
          const w = toWeights(left + (px + 0.5) / dpr, yy, g);
          let a = Math.round(clamp(w[0], 0, 1) * units), b = Math.round(clamp(w[1], 0, 1) * units);
          if (a + b > units) { if (w[0] * units - Math.floor(w[0] * units) < w[1] * units - Math.floor(w[1] * units)) a--; else b--; }
          const k = lut[a * stepPct * 101 + b * stepPct];
          if (k < 0) continue;
          const o = (py * cw + px) * 4;
          img.data[o] = lutRGB[k * 3]; img.data[o + 1] = lutRGB[k * 3 + 1]; img.data[o + 2] = lutRGB[k * 3 + 2]; img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('position', 'relative').style('touch-action', 'none');
    const pathOf = (pts) => `M${pts.map((pt) => toXY(pt, g).map((v) => v.toFixed(1)).join(',')).join('L')}`;
    const gridG = svg.append('g').attr('stroke', t['--surface']).attr('stroke-opacity', 0.55).attr('stroke-width', 1).attr('pointer-events', 'none');
    for (let q = 1; q < 10; q++) {
      const f = q / 10;
      gridG.append('path').attr('d', pathOf([[f, 1 - f, 0], [f, 0, 1 - f]]));
      gridG.append('path').attr('d', pathOf([[1 - f, f, 0], [0, f, 1 - f]]));
      gridG.append('path').attr('d', pathOf([[1 - f, 0, f], [0, 1 - f, f]]));
    }
    svg.append('path').attr('d', `${pathOf([[1, 0, 0], [0, 1, 0], [0, 0, 1]])}Z`).attr('fill', 'none').attr('stroke', t['--axis']);
    svg.append('text').attr('x', g.A[0]).attr('y', top - 9).attr('text-anchor', 'middle').attr('font-weight', 600).attr('fill', t['--ink']).text('纳指100');
    svg.append('text').attr('x', g.B[0]).attr('y', g.B[1] + 18).attr('text-anchor', 'start').attr('font-weight', 600).attr('fill', t['--ink']).text('标普500');
    svg.append('text').attr('x', g.C[0]).attr('y', g.C[1] + 18).attr('text-anchor', 'end').attr('font-weight', 600).attr('fill', t['--ink']).text('10年美债');

    const boxes = [
      { x: g.A[0] - 30, y: top - 22, w: 60, h: 16 },
      { x: g.B[0], y: g.B[1] + 4, w: 60, h: 16 },
      { x: g.C[0] - 70, y: g.C[1] + 4, w: 70, h: 16 },
    ];
    const markers = (props.markers ?? []).filter((mk) => Array.isArray(mk.w) && mk.w.every(isNum));
    // Markers closer than 6px are drawn once (active first); the legend names the ones underneath.
    const drawn = [];
    for (const mk of [...markers].sort((a, b) => Number(!!b.active) - Number(!!a.active))) {
      const [mx, my] = toXY(mk.w, g);
      const hit = drawn.find((d) => Math.hypot(d.x - mx, d.y - my) < 6);
      if (hit) hit.aliases.push(mk); else drawn.push({ mk, x: mx, y: my, aliases: [] });
    }
    for (const d of drawn) boxes.push({ x: d.x - 9, y: d.y - 9, w: 18, h: 18 });

    // Contours (ink) with inline labels placed on the longest chain away from markers and other labels.
    const contourG = svg.append('g').attr('pointer-events', 'none');
    for (const c of props.contours ?? []) {
      const cv = c.values ?? [];
      if (!isNum(c.level)) continue;
      const lines = contourLines(lut, cv, c.level, stepPct).map((ln) => ln.map((pt) => percentToW(pt)));
      for (const ln of lines) {
        contourG.append('path').attr('d', pathOf(ln)).attr('fill', 'none').attr('stroke', t['--surface']).attr('stroke-width', 4).attr('stroke-opacity', 0.7);
        contourG.append('path').attr('d', pathOf(ln)).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5)
          .attr('stroke-dasharray', c.dashed ? '6 4' : null).attr('stroke-linejoin', 'round');
      }
      const longest = lines.map((ln) => ln.map((pt) => toXY(pt, g))).sort((a, b) => b.length - a.length)[0];
      if (!longest || !c.label) continue;
      const lw = textWidth(c.label, 11), lh = 13;
      const slot = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88].flatMap((frac) => [-8, 17].map((dy) => [frac, dy])).find(([frac, dy]) => {
        const [px, py] = longest[Math.floor(frac * (longest.length - 1))];
        const box = { x: px - lw / 2 - 2, y: py + dy - lh + 2, w: lw + 4, h: lh };
        const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + lh], [box.x + box.w, box.y + lh]];
        return corners.every(([qx, qy]) => toWeights(qx, qy, g).every((v) => v >= 0.005)) && !boxes.some((b) => boxesOverlap(b, box));
      });
      if (!slot) continue;
      const [px, py] = longest[Math.floor(slot[0] * (longest.length - 1))];
      boxes.push({ x: px - lw / 2 - 2, y: py + slot[1] - lh + 2, w: lw + 4, h: lh });
      contourG.append('text').attr('x', px).attr('y', py + slot[1]).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', t['--ink'])
        .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(c.label);
    }

    const markerG = svg.append('g').attr('pointer-events', 'none');
    for (const { mk, x: mx, y: my } of [...drawn].reverse()) {
      drawShape(markerG, { shape: mk.shape, r: 5, color: REFERENCE.has(mk.shape) ? t['--ink-2'] : t['--ink'], surface: t['--surface'], active: !!mk.active })
        .attr('transform', `translate(${mx},${my})`);
    }

    // Legend: gray (below 标普500) → blue (above), numeric ticks + 标普500 tick.
    const lgW = Math.min(320, side), lgX = left;
    const gradId = `ip-tern-grad-${++uid}`;
    const grad = svg.append('defs').append('linearGradient').attr('id', gradId);
    const span = vMax - vMin || 1, refOff = (ref - vMin) / span;
    for (let s = 0; s <= 8; s++) grad.append('stop').attr('offset', refOff * (s / 8)).attr('stop-color', colorOf(vMin + (ref - vMin) * (s / 8)));
    for (let s = 0; s <= 8; s++) grad.append('stop').attr('offset', refOff + (1 - refOff) * (s / 8)).attr('stop-color', colorOf(ref + (vMax - ref) * (s / 8)));
    svg.append('text').attr('x', lgX).attr('y', legendY - 6).attr('font-size', 11).attr('fill', t['--ink-2']).text(METRIC_LABEL[metric] ?? metric);
    svg.append('rect').attr('x', lgX).attr('y', legendY).attr('width', lgW).attr('height', 10).attr('rx', 2).attr('fill', `url(#${gradId})`);
    const lx = (v) => lgX + ((v - vMin) / span) * lgW;
    const ticks = [{ v: vMin, text: fmt(vMin) }, { v: vMax, text: fmt(vMax) }];
    if (isNum(spx)) ticks.push({ v: ref, text: `标普500 ${fmt(spx)}`, strong: true });
    const placed = layoutLabels(ticks.map((tk) => ({ x: lx(tk.v), width: textWidth(tk.text, 11) })), { left: 0, right: width, gap: 6, maxRows: 2 });
    ticks.forEach((tk, k) => {
      if (placed[k].row < 0) return;
      svg.append('line').attr('x1', lx(tk.v)).attr('x2', lx(tk.v)).attr('y1', legendY - 2).attr('y2', legendY + 14 + placed[k].row * 13).attr('stroke', tk.strong ? t['--ink'] : t['--ink-2']);
      svg.append('text').attr('class', 'ip-tick').attr('x', placed[k].x).attr('y', legendY + 25 + placed[k].row * 13).attr('text-anchor', 'middle')
        .attr('fill', tk.strong ? t['--ink'] : t['--ink-2']).text(tk.text);
    });
    if (props.legend !== false && drawn.length) {
      const hosts = new Map(drawn.map((d) => [d.mk, d]));
      legendRow(root, markers.filter((mk) => hosts.has(mk)).map((mk) => {
        const hidden = hosts.get(mk).aliases;
        return { kind: 'shape', shape: mk.shape, color: REFERENCE.has(mk.shape) ? t['--ink-2'] : t['--ink'],
          label: hidden.length ? `${mk.label}（与 ${hidden.map((a) => `${SHAPE_GLYPH[a.shape] ?? ''}${a.label}`).join('、')} 重叠）` : mk.label };
      }), t['--surface']);
    }

    // Hover ring, pin ring, tooltip content.
    const hoverRing = svg.append('circle').attr('r', 6).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5).attr('pointer-events', 'none').style('display', 'none');
    const pinG = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    pinG.append('circle').attr('r', 8).attr('fill', 'none').attr('stroke', t['--surface']).attr('stroke-width', 4);
    pinG.append('circle').attr('r', 8).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 2);
    pinG.append('circle').attr('r', 2).attr('fill', t['--ink']);
    const extra = (props.contours ?? []).filter((c) => c.metric && c.metric !== metric);
    const rowsAt = (k) => [
      { value: fmt(values[k]), label: `${METRIC_LABEL[metric] ?? metric}${isNum(spx) ? `（标普500 ${fmt(spx)}）` : ''}` },
      ...extra.map((c) => ({ value: metricFormat(c.metric)(toArray(c.values)[k]), label: METRIC_LABEL[c.metric] ?? c.label })),
    ];
    const lookupPct = (pct) => lut[pct[0] * 101 + pct[1]];

    const setPin = (pct, { announce = true } = {}) => {
      pinned = pct;
      if (!pct) { pinG.style('display', 'none'); return; }
      const w = percentToW(pct);
      const [px, py] = toXY(w, g);
      pinG.style('display', null).attr('transform', `translate(${px},${py})`);
      const k = lookupPct(pct);
      if (k < 0) return;
      if (announce) props.onPin?.(w);
      const c = clientPoint(svg.node(), px, py);
      tooltip.show({
        x: c.x, y: c.y, owner: root, pin: true, title: fmtWeights(w), rows: rowsAt(k),
        actions: typeof props.onApply === 'function' ? [{ label: '设为自定义', onClick: () => { applying = true; props.onApply(w); tooltip.unpin(root); } }] : [],
        onUnpin: () => { pinned = null; pinG.style('display', 'none'); if (!applying) props.onPin?.(null); applying = false; },
      });
    };
    const propPin = Array.isArray(props.pinned) ? snapWeights(props.pinned, stepPct) : null;
    if (propPin && String(propPin) !== String(lastPinnedProp)) { lastPinnedProp = propPin; pinned = propPin; }
    if (pinned && tooltip.isPinned(root)) setPin(pinned, { announce: false });
    else if (pinned) { const [px, py] = toXY(percentToW(pinned), g); pinG.style('display', null).attr('transform', `translate(${px},${py})`); }

    const pctFromPointer = (e) => {
      const [px, py] = d3.pointer(e, svg.node());
      const w = toWeights(px, py, g);
      if (w.some((v) => v < -0.04)) return null;
      return snapWeights(w, stepPct);
    };
    const hover = (e) => {
      const pct = pctFromPointer(e);
      const k = pct ? lookupPct(pct) : -1;
      if (k < 0) { hoverRing.style('display', 'none'); tooltip.hide(root); return; }
      const [px, py] = toXY(percentToW(pct), g);
      hoverRing.style('display', null).attr('cx', px).attr('cy', py);
      const c = clientPoint(svg.node(), px, py);
      tooltip.show({ x: c.x, y: c.y, owner: root, title: fmtWeights(percentToW(pct)), rows: rowsAt(k) });
    };
    svg.append('path').attr('d', `${pathOf([[1, 0, 0], [0, 1, 0], [0, 0, 1]])}Z`).attr('fill', 'transparent').attr('stroke', 'transparent').attr('stroke-width', 16)
      .style('cursor', 'crosshair')
      .on('pointermove', (e) => { if (e.pointerType === 'mouse') hover(e); })
      .on('pointerleave', () => { hoverRing.style('display', 'none'); tooltip.hide(root); })
      .on('click', (e) => { const pct = pctFromPointer(e); if (pct && lookupPct(pct) >= 0) { hoverRing.style('display', 'none'); setPin(pct); } });

    // Keyboard: focus shows the point under a cursor (the active rule marker at first) as a plain tooltip; arrows move it
    // 1pp (Shift 5pp); Enter pins it with 设为自定义 and a second Enter applies. Blur to another element or Escape drops it,
    // so a keyboard pass never leaves a pinned tooltip that blocks other charts.
    const startPin = () => snapWeights((markers.find((mk) => mk.active) ?? markers[0])?.w ?? [1 / 3, 1 / 3, 1 / 3], stepPct);
    const showCursor = (pct) => {
      cursor = pct;
      const k = lookupPct(pct);
      const [px, py] = toXY(percentToW(pct), g);
      hoverRing.style('display', null).attr('cx', px).attr('cy', py);
      if (k < 0) { tooltip.hide(root); return; }
      const c = clientPoint(svg.node(), px, py);
      tooltip.show({ x: c.x, y: c.y, owner: root, title: fmtWeights(percentToW(pct)), rows: [...rowsAt(k), { value: 'Enter', label: '固定此点，可设为自定义' }] });
    };
    const keyboardFocus = () => { try { return svg.node().matches(':focus-visible'); } catch { return true; } };
    svg.on('focus', () => {
      if (!keyboardFocus() || tooltip.isPinned(root)) return; // a click pins on its own
      showCursor(cursor ?? pinned ?? startPin());
    })
      .on('blur', (e) => {
        hoverRing.style('display', 'none');
        if (!tooltip.isPinned(root)) { tooltip.hide(root); return; }
        // focus moving elsewhere drops the pin; a click that focuses nothing (Safari buttons) leaves it to the tooltip
        const next = e.relatedTarget;
        if (next && !root.ownerDocument.getElementById('chart-tooltip')?.contains(next)) tooltip.unpin(root);
      })
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hoverRing.style('display', 'none'); if (tooltip.isPinned(root)) tooltip.unpin(root); else tooltip.hide(root); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (pinned && tooltip.isPinned(root)) { applying = true; props.onApply?.(percentToW(pinned)); tooltip.unpin(root); return; }
          hoverRing.style('display', 'none');
          setPin(cursor ?? startPin());
          return;
        }
        const d = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [1, 1], ArrowRight: [1, -1] }[e.key];
        if (!d) return;
        e.preventDefault();
        const cur = [...(cursor ?? pinned ?? startPin())];
        const step = stepPct * (e.shiftKey ? 5 : 1);
        const [asset, sign] = d;
        const other = asset === 0 ? 1 : 0;
        if (sign > 0) {
          const give = Math.min(step, cur[2] > 0 ? cur[2] : cur[other]);
          cur[asset] += give;
          if (cur[2] >= give) cur[2] -= give; else cur[other] -= give;
        } else {
          const give = Math.min(step, cur[asset]);
          cur[asset] -= give;
          cur[2] += give;
        }
        if (tooltip.isPinned(root)) tooltip.unpin(root);
        showCursor(cur);
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
