// §1 relative wealth / §4 walk-forward relative line: log or linear, neutral regime bands, direct end labels.
import {
  createChart, baseSvg, axisBottom, axisLeftGrid, yearTicks, monthIndex, tickFormatter, valueFormatter, logTicks,
  nearestIndex, clientPoint, stepIndex, yearEndIndices, toArray, textWidth, note, legendRow, layoutLabels, circled,
  boxesOverlap, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, fmtRatio } from '../lib/format.js?v=20260912';

const tableFormat = (props) => (props?.yFormat === 'pct' ? (v) => fmtPct(v, 2) : (v) => fmtRatio(v, 2));

export function toTable(props) {
  const x = toArray(props?.x);
  const series = (props?.series ?? []).map((s) => ({ label: s.label, v: toArray(s.values) }));
  const fmt = tableFormat(props);
  const raw = yearEndIndices(x).map((i) => [x[i], ...series.map((s) => s.v[i] ?? null)]);
  return { columns: ['月份', ...series.map((s) => s.label)], rows: raw.map(([m, ...vs]) => [m, ...vs.map(fmt)]), raw };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const x = toArray(props.x);
    const n = x.length;
    const series = (props.series ?? []).map((s) => ({ ...s, v: toArray(s.values), color: t.color(s.colorVar ?? '--ink') }));
    const log = props.yScale === 'log';
    const ok = (v) => isNum(v) && (!log || v > 0);
    const all = series.flatMap((s) => s.v.slice(0, n).filter(ok));
    if (n < 2 || all.length < 2) { note(root, props.emptyText ?? '数据不足', 'ip-chart__empty'); return; }

    const mi = x.map(monthIndex);
    const narrow = width < 560;
    const height = props.height ?? (narrow ? 240 : 300);
    const bands = props.bands ?? [];
    let lo = d3.min(all), hi = d3.max(all);
    if (ok(props.baseline)) { lo = Math.min(lo, props.baseline); hi = Math.max(hi, props.baseline); }
    let y, ticks, tf;
    if (log) {
      const pad = Math.max(1.02, (hi / lo) ** 0.04);
      y = d3.scaleLog().domain([lo / pad, hi * pad]);
      ticks = logTicks(lo / pad, hi * pad, narrow ? 5 : 7);
      if (ticks.length < 2) ticks = y.ticks(4);
      tf = tickFormatter('ratio');
    } else {
      if (lo === hi) { lo -= 0.01; hi += 0.01; }
      y = d3.scaleLinear().domain([lo, hi]).nice(narrow ? 4 : 6);
      ticks = y.ticks(narrow ? 4 : 6);
      tf = tickFormatter(props.yFormat ?? 'pct', ticks[1] - ticks[0]);
    }
    const m = {
      top: bands.length ? 24 : 12, right: 12, bottom: props.xTitle ? 46 : 28,
      left: Math.max(...ticks.map((v) => textWidth(tf(v), 11))) + 12, ...props.margins,
    };
    const p = { x0: m.left, x1: Math.max(m.left + 1, width - m.right), y0: m.top, y1: Math.max(m.top + 1, height - m.bottom) };
    y.range([p.y1, p.y0]);
    const xs = d3.scaleLinear().domain([mi[0], mi[n - 1]]).range([p.x0, p.x1]);
    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('touch-action', 'pan-y');

    // Regime bands: alternating neutral washes; full label when it fits, else a circled key number.
    const bandBoxes = bands.map((b, k) => {
      const bx0 = xs(clamp(monthIndex(b.from), mi[0], mi[n - 1])), bx1 = xs(clamp(monthIndex(b.to), mi[0], mi[n - 1]));
      return { ...b, k, bx0, bx1, i0: monthIndex(b.from), i1: monthIndex(b.to) };
    }).filter((b) => b.bx1 - b.bx0 > 0);
    for (const b of bandBoxes) {
      if (b.k % 2 === 0) svg.append('rect').attr('x', b.bx0).attr('y', p.y0).attr('width', b.bx1 - b.bx0).attr('height', p.y1 - p.y0).attr('fill', t['--grid']).attr('fill-opacity', 0.4);
    }
    const bandLabels = bandBoxes.map((b) => {
      const wFull = textWidth(b.label, 11), span = b.bx1 - b.bx0;
      const full = span >= Math.max(48, wFull + 6);
      const text = full ? b.label : circled(b.k);
      return { b, text, full, x: (b.bx0 + b.bx1) / 2, width: full ? wFull : textWidth(text, 11) };
    });
    const placed = layoutLabels(bandLabels, { left: p.x0, right: width, gap: 3, maxRows: 1 });
    const keyItems = [];
    bandLabels.forEach((l, i) => {
      if (placed[i].row < 0) return;
      svg.append('text').attr('x', placed[i].x).attr('y', p.y0 - 8).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', t['--ink-2']).text(l.text);
      if (!l.full) keyItems.push(`${l.text} ${l.b.label}`);
    });

    axisLeftGrid(svg, y, ticks, tf, { x: p.x0, x1: p.x1, tokens: t });
    axisBottom(svg, xs, yearTicks(mi[0], mi[n - 1], Math.floor((p.x1 - p.x0) / 56)), tickFormatter('month'), { y: p.y1, x0: p.x0, x1: p.x1, tokens: t });
    if (props.xTitle) svg.append('text').attr('x', (p.x0 + p.x1) / 2).attr('y', height - 6).attr('text-anchor', 'middle').attr('fill', t['--ink-2']).text(props.xTitle);
    if (ok(props.baseline)) {
      const by = Math.round(y(props.baseline)) + 0.5;
      svg.append('line').attr('x1', p.x0).attr('x2', p.x1).attr('y1', by).attr('y2', by).attr('stroke', t['--axis']);
    }

    const idx = d3.range(n);
    const ordered = [...series].sort((a, b) => Number(!!a.emphasis) - Number(!!b.emphasis));
    for (const s of ordered) {
      svg.append('path').attr('d', d3.line().defined((i) => ok(s.v[i])).x((i) => xs(mi[i])).y((i) => y(s.v[i]))(idx))
        .attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
    }

    // Direct end labels (emphasis first); a colliding label flips below its line, else it is dropped.
    const fmt = log ? valueFormatter('ratio') : valueFormatter(props.yFormat ?? 'pct');
    const boxes = [];
    for (const s of [...ordered].reverse()) {
      const last = [...idx].reverse().find((i) => ok(s.v[i]));
      if (last == null) continue;
      // A single series is named by the title; long names fall back to the value (legend carries identity).
      const full = `${s.label} ${fmt(s.v[last])}`;
      const text = series.length === 1 || textWidth(full, 12) > (p.x1 - p.x0) * 0.45 ? fmt(s.v[last]) : full;
      const w = textWidth(text, 12), ly = y(s.v[last]);
      const lx = Math.min(xs(mi[last]), p.x1);
      for (const dy of [-9, 17]) {
        const box = { x: lx - w, y: ly + dy - 12, w, h: 14 };
        if (box.y < p.y0 || box.y + box.h > p.y1 || box.x < p.x0 || boxes.some((b) => boxesOverlap(b, box))) continue;
        boxes.push(box);
        svg.append('text').attr('x', lx).attr('y', ly + dy).attr('text-anchor', 'end').attr('fill', t['--ink'])
          .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(text);
        break;
      }
    }
    if (series.length >= 2) legendRow(root, series.map((s) => ({ label: s.label, color: s.color, kind: 'line' })), t['--surface']);
    if (keyItems.length) note(root, keyItems.join('　'));

    const focus = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    const vline = focus.append('line').attr('y1', p.y0).attr('y2', p.y1).attr('stroke', t['--ink-2']).attr('stroke-opacity', 0.5);
    const dots = series.map((s) => focus.append('circle').attr('r', 4).attr('fill', s.color).attr('stroke', t['--surface']).attr('stroke-width', 2));
    const hideFocus = () => { focus.style('display', 'none'); tooltip.hide(root); };
    const focusAt = (i) => {
      if (i < 0 || i >= n) { hideFocus(); return; }
      focusIdx = i;
      const px = xs(mi[i]);
      focus.style('display', null);
      vline.attr('x1', px).attr('x2', px);
      let anchorY = p.y0 + 10;
      series.forEach((s, k) => {
        const v = s.v[i];
        dots[k].style('display', ok(v) ? null : 'none');
        if (ok(v)) { dots[k].attr('cx', px).attr('cy', y(v)); if (s.emphasis || k === 0) anchorY = y(v); }
      });
      const band = bandBoxes.find((b) => mi[i] >= b.i0 && mi[i] <= b.i1);
      const c = clientPoint(svg.node(), px, anchorY);
      tooltip.show({
        x: c.x, y: c.y, owner: root, title: band ? `${x[i]} · ${band.label}` : x[i],
        rows: series.map((s) => ({ colorVar: s.colorVar ?? '--ink', value: fmt(s.v[i]), label: s.label })),
      });
    };
    svg.append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', p.x1 - p.x0).attr('height', p.y1 - p.y0).attr('fill', 'transparent')
      .on('pointermove pointerdown', (e) => focusAt(nearestIndex(mi, xs.invert(d3.pointer(e)[0]))))
      .on('pointerleave', hideFocus);
    svg.on('focus', () => focusAt(focusIdx >= 0 && focusIdx < n ? focusIdx : n - 1))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hideFocus(); return; }
        const next = stepIndex(e.key, Math.max(0, focusIdx), n, { page: 12, shift: e.shiftKey });
        if (next == null) return;
        e.preventDefault();
        focusAt(next);
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
