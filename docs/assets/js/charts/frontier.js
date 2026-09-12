// §3 efficient frontier (μ–σ): beats-SPX region, TE path, tangent line, rule markers; hover snaps to the frontier.
import {
  createChart, baseSvg, axisBottom, axisLeftGrid, tickFormatter, clientPoint, toArray, textWidth, note, legendRow,
  drawShape, boxesOverlap, sampleIndices, nearestIndex, SHAPE_GLYPH, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, fmtNum, fmtWeights } from '../lib/format.js?v=20260912';

let uid = 0;
const REFERENCE = new Set(['cross', 'plus']);
const TE_TICKS = [0.02, 0.04, 0.06];
const valid = (d) => d && isNum(d.mu) && isNum(d.vol);

export function toTable(props) {
  const raw = [];
  for (const mk of (props?.markers ?? []).filter(valid)) raw.push([`${SHAPE_GLYPH[mk.shape] ?? ''} ${mk.label}`.trim(), mk.w ?? null, mk.mu, mk.vol]);
  for (const a of (props?.assets ?? []).filter(valid)) raw.push([a.label, null, a.mu, a.vol]);
  const fr = toArray(props?.frontier).filter(valid);
  for (const i of sampleIndices(fr.length, 11)) raw.push(['有效前沿', fr[i].w ?? null, fr[i].mu, fr[i].vol]);
  return {
    columns: ['点', '纳指/标普/美债', '算术年化收益', '年化波动'],
    rows: raw.map(([label, w, mu, vol]) => [label, w ? fmtWeights(w) : '—', fmtPct(mu, 2), fmtPct(vol, 2)]),
    raw,
  };
}

/** Point on a TE path at tracking error k (linear in k between path points), or null outside the path. */
export function tePoint(path, k) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (k >= a.k && k <= b.k && b.k > a.k) {
      const f = (k - a.k) / (b.k - a.k);
      return { k, vol: a.vol + f * (b.vol - a.vol), mu: a.mu + f * (b.mu - a.mu) };
    }
  }
  return null;
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusState = null;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const fr = toArray(props.frontier).filter(valid);
    const assets = (props.assets ?? []).filter(valid);
    const markers = (props.markers ?? []).filter(valid);
    const tePath = toArray(props.tePath).filter(valid);
    const tangent = valid(props.tangent) && isNum(props.tangent.c) ? props.tangent : null;
    if (fr.length < 2 && !assets.length) { note(root, props.emptyText ?? '暂无有效前沿', 'ip-chart__empty'); return; }

    const narrow = width < 560;
    const height = narrow ? 330 : 400;
    const all = [...fr, ...assets, ...markers, ...tePath];
    let muLo = d3.min(all, (d) => d.mu), muHi = d3.max(all, (d) => d.mu);
    if (tangent) muLo = Math.min(muLo, tangent.c);
    const pad = (muHi - muLo) * 0.06 || 0.01;
    const y = d3.scaleLinear().domain([muLo - pad, muHi + pad]).nice(narrow ? 5 : 6);
    const yTicks = y.ticks(narrow ? 5 : 6);
    const tfy = tickFormatter('pct', yTicks[1] - yTicks[0]);
    const x = d3.scaleLinear().domain([0, d3.max(all, (d) => d.vol) * 1.06]).nice(narrow ? 4 : 6);
    const xTicks = x.ticks(narrow ? 4 : 6);
    const m = { top: 26, right: 16, bottom: 46, left: Math.max(...yTicks.map((v) => textWidth(tfy(v), 11))) + 12 };
    const p = { x0: m.left, x1: Math.max(m.left + 1, width - m.right), y0: m.top, y1: Math.max(m.top + 1, height - m.bottom) };
    x.range([p.x0, p.x1]);
    y.range([p.y1, p.y0]);
    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('touch-action', 'pan-y');
    const clipId = `ip-fr-${++uid}`;
    svg.append('defs').append('clipPath').attr('id', clipId).append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', p.x1 - p.x0).attr('height', p.y1 - p.y0);
    svg.append('text').attr('x', 0).attr('y', 12).attr('font-size', 11).attr('fill', t['--ink-2']).text(props.yLabel ?? '算术年化收益（月均×12）');
    svg.append('text').attr('x', (p.x0 + p.x1) / 2).attr('y', height - 6).attr('text-anchor', 'middle').attr('fill', t['--ink-2']).text(props.xLabel ?? '年化波动');

    const boxes = [];
    const region = props.region;
    if (region && isNum(region.volMax) && isNum(region.muMin)) {
      const rx1 = clamp(x(region.volMax), p.x0, p.x1), ry = clamp(y(region.muMin), p.y0, p.y1);
      svg.append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', rx1 - p.x0).attr('height', ry - p.y0).attr('fill', t['--grid']).attr('fill-opacity', 0.6);
      if (region.label) {
        const text = svg.append('text').attr('x', p.x0 + 6).attr('y', p.y0 + 15).attr('font-size', 11).attr('fill', t['--ink-2']);
        const parts = textWidth(region.label, 11) + 12 <= rx1 - p.x0 ? [region.label] : region.label.split(/\s+(?=且)/);
        parts.forEach((s, i) => text.append('tspan').attr('x', p.x0 + 6).attr('dy', i ? 14 : 0).text(s));
        boxes.push({ x: p.x0, y: p.y0, w: Math.max(...parts.map((s) => textWidth(s, 11))) + 12, h: 8 + parts.length * 14 });
      }
    }
    axisLeftGrid(svg, y, yTicks, tfy, { x: p.x0, x1: p.x1, tokens: t });
    axisBottom(svg, x, xTicks, tickFormatter('pct', xTicks[1] - xTicks[0]), { y: p.y1, x0: p.x0, x1: p.x1, tokens: t });

    const plot = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const line = d3.line().x((d) => x(d.vol)).y((d) => y(d.mu));
    plot.append('path').attr('d', line(fr)).attr('fill', 'none').attr('stroke', t['--ink-2']).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
    if (tangent) {
      const slope = (tangent.mu - tangent.c) / tangent.vol, v1 = x.domain()[1];
      plot.append('path').attr('d', line([{ vol: 0, mu: tangent.c }, { vol: v1, mu: tangent.c + slope * v1 }]))
        .attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5).attr('stroke-dasharray', '6 4');
      const cy = y(tangent.c);
      svg.append('circle').attr('cx', p.x0).attr('cy', cy).attr('r', 3.5).attr('fill', t['--ink']).attr('stroke', t['--surface']).attr('stroke-width', 2);
      const label = `截距 ${fmtPct(tangent.c)}`;
      const ty = cy + 16 < p.y1 ? cy + 16 : cy - 8;
      svg.append('text').attr('x', p.x0 + 7).attr('y', ty).attr('font-size', 11).attr('fill', t['--ink'])
        .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(label);
      boxes.push({ x: p.x0 + 7, y: ty - 11, w: textWidth(label, 11), h: 13 });
    }
    if (tePath.length >= 2) {
      plot.append('path').attr('d', line(tePath)).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1);
    }

    // Markers closer than 4px are drawn once (active first); the tooltip lists every rule at that point.
    const drawn = [];
    for (const mk of [...markers].sort((a, b) => Number(!!b.active) - Number(!!a.active))) {
      const hit = drawn.find((o) => Math.hypot(x(o.vol) - x(mk.vol), y(o.mu) - y(mk.mu)) < 4);
      if (hit) hit.aliases.push(mk); else drawn.push({ ...mk, aliases: [], src: mk });
    }

    // Obstacle boxes include the marker's surface ring and the active halo.
    const ownBox = (d, half) => ({ x: x(d.vol) - half, y: y(d.mu) - half, w: 2 * half, h: 2 * half });
    const markerBoxes = new Map([...drawn.map((d) => [d, ownBox(d, d.active ? 17 : 9)]), ...assets.map((d) => [d, ownBox(d, 7)])]);
    boxes.push(...markerBoxes.values());
    const tePts = tePath.length >= 2 ? TE_TICKS.map((k) => ({ k, pt: tePoint(tePath, k) })).filter((d) => d.pt) : [];
    for (const { pt } of tePts) boxes.push({ x: x(pt.vol) - 3, y: y(pt.mu) - 3, w: 6, h: 6 });

    // Label placement: 8 directions ordered away from nearby markers, growing offsets; beyond 12px a leader line.
    const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const labelLayer = svg.append('g');
    const placeLabel = (d, text, { size = 11, own = null, offsets = [8, 22, 38, 56] } = {}) => {
      const px = x(d.vol), py = y(d.mu);
      const w = textWidth(text, size), h = size + 3;
      let ax = 0, ay = 0;
      for (const b of markerBoxes.values()) {
        if (b === own) continue;
        const dx = b.x + b.w / 2 - px, dy = b.y + b.h / 2 - py, r = Math.hypot(dx, dy);
        if (r > 0 && r < 90) { ax -= dx / r; ay -= dy / r; }
      }
      const dirs = DIRS.map(([ux, uy], i) => ({ ux, uy, score: (ux * ax + uy * ay) / Math.hypot(ux, uy) - i * 1e-3 })).sort((a, b) => b.score - a.score);
      for (const off of offsets) {
        for (const { ux, uy } of dirs) {
          const n = Math.hypot(ux, uy);
          const cx = px + (ux / n) * off, cy = py + (uy / n) * off;
          const box = { x: ux > 0 ? cx : ux < 0 ? cx - w : cx - w / 2, y: uy > 0 ? cy : uy < 0 ? cy - h : cy - h / 2, w, h };
          if (box.x < p.x0 + 2 || box.x + w > p.x1 - 2 || box.y < p.y0 || box.y + h > p.y1 - 2) continue;
          if (boxes.some((b) => b !== own && boxesOverlap(b, box))) continue;
          boxes.push(box);
          if (off > 12) {
            labelLayer.append('line').attr('x1', px + (ux / n) * 6).attr('y1', py + (uy / n) * 6)
              .attr('x2', clamp(px, box.x, box.x + w)).attr('y2', clamp(py, box.y, box.y + h)).attr('stroke', t['--ink-2']).attr('stroke-width', 1);
          }
          labelLayer.append('text').attr('x', box.x).attr('y', box.y + h - 3).attr('font-size', size).attr('fill', t['--ink'])
            .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(text);
          return true;
        }
      }
      return false;
    };

    const layer = svg.append('g');
    for (const { pt } of tePts) {
      layer.append('circle').attr('cx', x(pt.vol)).attr('cy', y(pt.mu)).attr('r', 2.5).attr('fill', t['--ink']).attr('stroke', t['--surface']).attr('stroke-width', 1.5);
    }
    const ordered = [...drawn].sort((a, b) => Number(!!a.active) - Number(!!b.active));
    for (const mk of ordered) {
      drawShape(layer, { shape: mk.shape, r: 5, color: REFERENCE.has(mk.shape) ? t['--ink-2'] : t['--ink'], surface: t['--surface'], active: !!mk.active })
        .attr('transform', `translate(${x(mk.vol)},${y(mk.mu)})`);
    }
    // Assets sit above rule markers: 标普500 is the reference every rule is read against.
    for (const a of assets) {
      layer.append('circle').attr('cx', x(a.vol)).attr('cy', y(a.mu)).attr('r', 5).attr('fill', t.color(a.colorVar)).attr('stroke', t['--surface']).attr('stroke-width', 2);
    }
    for (const a of assets) placeLabel(a, a.label, { size: 12, own: markerBoxes.get(a) });
    for (const mk of drawn) if (REFERENCE.has(mk.shape)) placeLabel(mk, mk.label, { own: markerBoxes.get(mk) });
    for (const { k, pt } of tePts) placeLabel(pt, `${Math.round(k * 100)}%`, { size: 10, offsets: [6] });

    if (props.legend !== false) {
      // a merged marker keeps one legend entry that names the rules drawn underneath it
      const hosts = new Map(drawn.map((d) => [d.src, d]));
      const items = markers.filter((mk) => hosts.has(mk)).map((mk) => {
        const hidden = hosts.get(mk).aliases;
        return { kind: 'shape', shape: mk.shape, color: REFERENCE.has(mk.shape) ? t['--ink-2'] : t['--ink'],
          label: hidden.length ? `${mk.label}（与 ${hidden.map((a) => `${SHAPE_GLYPH[a.shape] ?? ''}${a.label}`).join('、')} 重叠）` : mk.label };
      });
      if (tePath.length >= 2) items.push({ kind: 'line', color: t['--ink'], label: '跟踪误差路径（点：2% / 4% / 6%）' });
      if (tangent) items.push({ kind: 'dash', color: t['--ink'], label: tangent.label ?? `切线（截距 ${fmtPct(tangent.c)}）` });
      if (items.length) legendRow(root, items, t['--surface']);
    }

    // Interaction: markers/assets within 16px win; otherwise the crosshair snaps to the frontier by volatility.
    const items = [...drawn.map((d) => ({ d, kind: 'marker' })), ...assets.map((d) => ({ d, kind: 'asset' }))];
    const frVols = fr.map((d) => d.vol);
    const focus = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    const ring = focus.append('circle').attr('r', 9).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5);
    const hideFocus = () => { focus.style('display', 'none'); tooltip.hide(root); };
    const glyphLabel = (m) => `${SHAPE_GLYPH[m.shape] ?? ''} ${m.label}`.trim();
    const rowsFor = (d) => [
      ...(d.w ? [{ value: fmtWeights(d.w), label: d.aliases?.length ? glyphLabel(d) : '纳指 / 标普 / 美债' }] : []),
      ...(d.aliases ?? []).filter((m) => m.w).map((m) => ({ value: fmtWeights(m.w), label: glyphLabel(m) })),
      { value: fmtPct(d.mu), label: '算术年化收益' },
      { value: fmtPct(d.vol), label: '年化波动' },
      ...(isNum(d.cagr) ? [{ value: fmtPct(d.cagr), label: '年化复合收益' }] : []),
      ...(isNum(d.sharpe) ? [{ value: fmtNum(d.sharpe, 2), label: '夏普比率' }] : []),
    ];
    const showAt = (state) => {
      focusState = state;
      const d = state.kind === 'frontier' ? fr[state.i] : items[state.i]?.d;
      if (!d) { hideFocus(); return; }
      const px = x(d.vol), py = y(d.mu);
      focus.style('display', null);
      ring.attr('cx', px).attr('cy', py);
      const c = clientPoint(svg.node(), px, py);
      const heading = state.kind === 'frontier' ? '有效前沿' : [d, ...(d.aliases ?? [])].map(glyphLabel).join(' · ');
      tooltip.show({ x: c.x, y: c.y, owner: root, title: heading, rows: rowsFor(d) });
    };
    svg.append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', p.x1 - p.x0).attr('height', p.y1 - p.y0).attr('fill', 'transparent')
      .on('pointermove pointerdown', (e) => {
        const [px, py] = d3.pointer(e);
        let best = -1, bestD = 16 * 16;
        items.forEach((it, i) => { const dd = (x(it.d.vol) - px) ** 2 + (y(it.d.mu) - py) ** 2; if (dd <= bestD) { bestD = dd; best = i; } });
        if (best >= 0) showAt({ kind: 'item', i: best });
        else if (fr.length) showAt({ kind: 'frontier', i: nearestIndex(frVols, x.invert(px)) });
      })
      .on('pointerleave', hideFocus);
    svg.on('focus', () => showAt(focusState ?? (items.length ? { kind: 'item', i: Math.max(0, items.findIndex((it) => it.d.active)) } : { kind: 'frontier', i: 0 })))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        const s = focusState ?? { kind: 'frontier', i: 0 };
        let next = null;
        if (e.key === 'Escape') { hideFocus(); return; }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && fr.length) {
          const base = s.kind === 'frontier' ? s.i : nearestIndex(frVols, items[s.i]?.d.vol ?? 0);
          next = { kind: 'frontier', i: clamp(base + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, fr.length - 1) };
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && items.length) {
          const base = s.kind === 'item' ? s.i : -1;
          next = { kind: 'item', i: (base + (e.key === 'ArrowDown' ? 1 : items.length - 1 + (base < 0 ? 1 : 0))) % items.length };
        }
        if (!next) return;
        e.preventDefault();
        showAt(next);
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
