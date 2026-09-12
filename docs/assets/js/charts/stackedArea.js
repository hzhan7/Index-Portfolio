// §3 intercept → tangency weights, §4 walk-forward weights: 100% stacked layers with 2px surface gaps.
// props.extra [{id, label, values, format:'multiple'|'pct'|'num'}] rides along unstacked (tooltip + table), e.g. 杠杆倍数;
// props.tableX lists the x values the data table shows (e.g. rebalance months) instead of evenly sampled points.
import {
  createChart, baseSvg, axisBottom, axisLeftGrid, yearTicks, monthIndex, tickFormatter, clientPoint, stepIndex,
  sampleIndices, toArray, textWidth, note, legendRow, layoutLabels, nearestIndex, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, fmtNum, fmtMonth, roundWeights } from '../lib/format.js?v=20260912';

let uid = 0;
const xText = (props, v) => (props?.xFormat === 'month' ? fmtMonth(v) : fmtPct(v, 2));
const extraText = (e, v) => (!isNum(v) ? '—' : e?.format === 'pct' ? fmtPct(v, 1) : e?.format === 'multiple' ? `${fmtNum(v, 2)}倍` : fmtNum(v, 2));

/** Value of each series (or of `list`) at x (linear between points for pct, step-after for months). */
export function valuesAt(props, xv, list = props.series ?? []) {
  const isMonth = props.xFormat === 'month';
  const xs = toArray(props.x).map((v) => (isMonth ? monthIndex(v) : +v));
  const target = isMonth ? monthIndex(xv) : +xv;
  const series = list.map((s) => toArray(s.values));
  if (!xs.length) return series.map(() => null);
  let i = 0;
  while (i + 1 < xs.length && xs[i + 1] <= target) i++;
  if (isMonth || i + 1 >= xs.length || target <= xs[0]) return series.map((v) => v[target < xs[0] ? 0 : i]);
  const f = (target - xs[i]) / (xs[i + 1] - xs[i]);
  return series.map((v) => v[i] + f * (v[i + 1] - v[i]));
}

export function toTable(props) {
  const x = toArray(props?.x);
  const series = props?.series ?? [];
  const extra = props?.extra ?? [];
  const all = [...series, ...extra];
  const cols = all.map((s) => toArray(s.values));
  const tableX = toArray(props?.tableX);
  const raw = tableX.length && x.length
    ? tableX.map((xv) => [xv, ...valuesAt(props, xv, all)])
    : sampleIndices(x.length, 41).map((i) => [x[i], ...cols.map((v) => v[i])]);
  for (const mk of props?.markers ?? []) raw.push([`${mk.label} ${xText(props, mk.x)}`, ...valuesAt(props, mk.x, all)]);
  return {
    columns: [props?.xFormat === 'month' ? '调仓月份' : (props?.xName ?? '横轴'), ...all.map((s) => s.label)],
    rows: raw.map(([xv, ...vs]) => [typeof xv === 'string' ? xv : xText(props, xv),
      ...vs.map((v, k) => (k < series.length ? fmtPct(v, 1) : extraText(extra[k - series.length], v)))]),
    raw,
  };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const isMonth = props.xFormat === 'month';
    const xRaw = toArray(props.x);
    const xv = xRaw.map((v) => (isMonth ? monthIndex(v) : +v));
    const series = (props.series ?? []).map((s) => ({ ...s, v: toArray(s.values), color: t.color(s.colorVar) }));
    const extra = (props.extra ?? []).map((e) => ({ ...e, v: toArray(e.values) }));
    const n = xv.length;
    if (!n || !series.length || xv.some((v) => !isNum(v))) { note(root, props.emptyText ?? '暂无权重数据', 'ip-chart__empty'); return; }

    let dom = props.domain ? props.domain.map((v) => (isMonth ? monthIndex(v) : +v)) : [xv[0], xv[n - 1]];
    if (isMonth && !props.domain) dom = [xv[0], xv[n - 1] + (n > 1 ? xv[n - 1] - xv[n - 2] : 12)];
    if (!(dom[1] > dom[0])) dom = [dom[0] - (isMonth ? 6 : 0.005), dom[0] + (isMonth ? 6 : 0.005)];

    const narrow = width < 560;
    const markers = (props.markers ?? []).filter((mk) => {
      const v = isMonth ? monthIndex(mk.x) : +mk.x;
      return isNum(v) && v >= dom[0] && v <= dom[1];
    });
    const xs = d3.scaleLinear().domain(dom);
    const yTicks = [0, 0.25, 0.5, 0.75, 1];
    const tfY = tickFormatter('pct', 0.25);
    const baseLeft = Math.max(...yTicks.map((v) => textWidth(tfY(v), 11))) + 12;
    const m0 = { right: 16, bottom: props.xTitle ? 46 : 28, left: baseLeft, ...props.margins };
    xs.range([m0.left, Math.max(m0.left + 1, width - m0.right)]);

    // Marker labels above the plot; rows grow the top margin.
    const labelItems = markers.map((mk) => ({ mk, x: xs(isMonth ? monthIndex(mk.x) : +mk.x), width: textWidth(mk.label, 11) }));
    const placed = layoutLabels(labelItems, { left: 0, right: width, gap: 6, maxRows: 2 });
    const rows = Math.max(0, ...placed.map((pl) => pl.row + 1));
    const m = { top: 10 + rows * 15, ...m0 };
    const height = (props.height ?? (narrow ? 190 : 230)) + rows * 15;
    const p = { x0: m.left, x1: Math.max(m.left + 1, width - m.right), y0: m.top, y1: Math.max(m.top + 1, height - m.bottom) };
    const y = d3.scaleLinear().domain([0, 1]).range([p.y1, p.y0]);
    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('touch-action', 'pan-y');
    const clipId = `ip-sa-${++uid}`;
    svg.append('defs').append('clipPath').attr('id', clipId).append('rect').attr('x', p.x0).attr('y', p.y0 - 1).attr('width', p.x1 - p.x0).attr('height', p.y1 - p.y0 + 2);

    axisLeftGrid(svg, y, yTicks, tfY, { x: p.x0, x1: p.x1, tokens: t, grid: false });
    const xTicks = isMonth ? yearTicks(dom[0], dom[1], Math.floor((p.x1 - p.x0) / 56)) : xs.ticks(Math.max(2, Math.floor((p.x1 - p.x0) / 64)));
    axisBottom(svg, xs, xTicks, isMonth ? tickFormatter('month') : tickFormatter('pct', xTicks[1] - xTicks[0]), { y: p.y1, x0: p.x0, x1: p.x1, tokens: t });
    if (props.xTitle) svg.append('text').attr('x', (p.x0 + p.x1) / 2).attr('y', height - 6).attr('text-anchor', 'middle').attr('fill', t['--ink-2']).text(props.xTitle);

    // Stack; month data is step-after and the last step runs to the domain end.
    const pts = xv.map((v, i) => ({ x: v, i }));
    if (isMonth && dom[1] > xv[n - 1]) pts.push({ x: dom[1], i: n - 1 });
    const cum = pts.map(() => 0);
    const layers = series.map((s) => pts.map((pt, k) => { const lo = cum[k]; cum[k] += Math.max(0, s.v[pt.i] ?? 0); return [lo, cum[k]]; }));
    const curve = isMonth ? d3.curveStepAfter : d3.curveLinear;
    const g = svg.append('g').attr('clip-path', `url(#${clipId})`);
    layers.forEach((L, k) => {
      g.append('path').attr('d', d3.area().curve(curve).x((_, j) => xs(pts[j].x)).y0((d) => y(d[0])).y1((d) => y(d[1]))(L)).attr('fill', series[k].color);
    });
    layers.slice(0, -1).forEach((L) => {
      g.append('path').attr('d', d3.line().curve(curve).x((_, j) => xs(pts[j].x)).y((d) => y(d[1]))(L))
        .attr('fill', 'none').attr('stroke', t['--surface']).attr('stroke-width', 2);
    });

    labelItems.forEach((it, k) => {
      const mx = it.x;
      svg.append('line').attr('x1', mx).attr('x2', mx).attr('y1', p.y0).attr('y2', p.y1).attr('stroke', t['--ink']).attr('stroke-width', 1);
      if (placed[k].row < 0) return;
      svg.append('text').attr('x', placed[k].x).attr('y', m.top - 6 - (rows - 1 - placed[k].row) * 15)
        .attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', t['--ink']).text(it.mk.label);
    });
    legendRow(root, series.map((s) => ({ label: s.label, color: s.color, kind: 'rect' })), t['--surface']);

    const focus = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    const vline = focus.append('line').attr('y1', p.y0).attr('y2', p.y1).attr('stroke', t['--ink']).attr('stroke-width', 1).attr('stroke-dasharray', null);
    const hideFocus = () => { focus.style('display', 'none'); tooltip.hide(root); };
    const focusAt = (i) => {
      if (i < 0 || i >= n) { hideFocus(); return; }
      focusIdx = i;
      const px = clamp(xs(xv[i]), p.x0, p.x1);
      focus.style('display', null);
      vline.attr('x1', px).attr('x2', px);
      const vals = series.map((s) => s.v[i]);
      const total = vals.reduce((a, b) => a + (isNum(b) ? b : 0), 0);
      const ints = Math.abs(total - 1) < 1e-6 ? roundWeights(vals) : null;
      const c = clientPoint(svg.node(), px, p.y0 + (p.y1 - p.y0) / 3);
      tooltip.show({
        x: c.x, y: c.y, owner: root,
        title: `${props.xName ? `${props.xName} ` : ''}${xText(props, xRaw[i])}`,
        rows: [...series.map((s, k) => ({ colorVar: s.colorVar, shape: 'rect', value: ints ? `${ints[k]}%` : fmtPct(vals[k], 1), label: s.label })).reverse(),
          ...extra.map((e) => ({ value: extraText(e, e.v[i]), label: e.label }))],
      });
    };
    const pick = (px) => {
      const v = xs.invert(px);
      if (isMonth) { let i = 0; while (i + 1 < n && xv[i + 1] <= v) i++; return i; }
      return nearestIndex(xv, v);
    };
    const overlay = svg.append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', p.x1 - p.x0).attr('height', p.y1 - p.y0 + (props.onPick ? 24 : 0)).attr('fill', 'transparent')
      .on('pointermove pointerdown', (e) => focusAt(pick(d3.pointer(e)[0])))
      .on('pointerleave', hideFocus);
    if (typeof props.onPick === 'function') {
      overlay.style('cursor', 'pointer').on('click', (e) => {
        const v = xs.invert(d3.pointer(e)[0]);
        props.onPick(isMonth ? xRaw[pick(d3.pointer(e)[0])] : clamp(v, dom[0], dom[1]));
      });
    }
    svg.on('focus', () => focusAt(focusIdx >= 0 && focusIdx < n ? focusIdx : 0))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hideFocus(); return; }
        const next = stepIndex(e.key, Math.max(0, focusIdx), n, { page: 10, shift: e.shiftKey });
        if (next == null) return;
        e.preventDefault();
        focusAt(next);
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
