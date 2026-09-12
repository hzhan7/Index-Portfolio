// §1 rolling excess: 2px line with washes clipped at zero (blue above = 纳指100 ahead, orange below).
import {
  createChart, baseSvg, axisBottom, axisLeftGrid, yearTicks, monthIndex, addMonths, tickFormatter, valueFormatter,
  nearestIndex, clientPoint, stepIndex, januaryIndices, toArray, textWidth, note, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPpBare } from '../lib/format.js?v=20260912';

let uid = 0;

export function toTable(props) {
  const x = toArray(props?.x), v = toArray(props?.values);
  const raw = januaryIndices(x.slice(0, v.length)).map((i) => [x[i], v[i]]);
  return { columns: ['买入月份', '年化超额（个百分点）'], rows: raw.map(([m, val]) => [m, fmtPpBare(val)]), raw };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const x = toArray(props.x), vals = toArray(props.values);
    const n = Math.min(x.length, vals.length);
    const finite = vals.slice(0, n).filter(isNum);
    if (n < 2 || finite.length < 2) { note(root, props.emptyText ?? '样本不足，暂无滚动结果', 'ip-chart__empty'); return; }

    const id = `ip-ad-${++uid}`;
    const mi = x.slice(0, n).map(monthIndex);
    const narrow = width < 560;
    const height = narrow ? 230 : 280;
    const vLo = Math.min(0, d3.min(finite)), vHi = Math.max(0, d3.max(finite));
    // Headroom under the minimum keeps the "最差" annotation off the line.
    const y = d3.scaleLinear().domain([vLo < 0 && props.annotate !== false ? vLo - (vHi - vLo) * 0.1 : vLo, vHi]).nice(narrow ? 4 : 6);
    if (y.domain()[0] === y.domain()[1]) y.domain([-0.01, 0.01]);
    const ticks = y.ticks(narrow ? 4 : 6);
    const tf = tickFormatter(props.yFormat ?? 'pp', ticks[1] - ticks[0]);
    const m = { top: 24, right: 12, bottom: props.xTitle ? 46 : 28, left: Math.max(...ticks.map((v) => textWidth(tf(v), 11))) + 12 };
    const p = { x0: m.left, x1: Math.max(m.left + 1, width - m.right), y0: m.top, y1: Math.max(m.top + 1, height - m.bottom) };
    y.range([p.y1, p.y0]);
    const xs = d3.scaleLinear().domain([mi[0], mi[n - 1]]).range([p.x0, p.x1]);
    const y0 = y(0);

    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('touch-action', 'pan-y');
    svg.append('text').attr('x', 0).attr('y', 12).attr('fill', t['--ink-2']).attr('font-size', 11).text(props.yTitle ?? '年化超额（个百分点）');

    if (props.highlight) {
      const hx0 = xs(clamp(monthIndex(props.highlight.from), mi[0], mi[n - 1]));
      const hx1 = xs(clamp(monthIndex(props.highlight.to), mi[0], mi[n - 1]));
      if (hx1 - hx0 > 1 && hx1 - hx0 < (p.x1 - p.x0) * 0.99) {
        svg.append('rect').attr('x', hx0).attr('y', p.y0).attr('width', hx1 - hx0).attr('height', p.y1 - p.y0).attr('fill', t['--grid']).attr('fill-opacity', 0.6);
        const label = props.highlightLabel ?? '当前样本';
        if (hx1 - hx0 >= textWidth(label, 11) + 10) {
          svg.append('text').attr('x', hx0 + 5).attr('y', p.y0 + 13).attr('font-size', 11).attr('fill', t['--ink-2']).text(label);
        }
      }
    }

    axisLeftGrid(svg, y, ticks, tf, { x: p.x0, x1: p.x1, tokens: t });
    axisBottom(svg, xs, yearTicks(mi[0], mi[n - 1], Math.floor((p.x1 - p.x0) / 56)), tickFormatter('month'), { y: p.y1, x0: p.x0, x1: p.x1, tokens: t });
    if (props.xTitle) svg.append('text').attr('x', (p.x0 + p.x1) / 2).attr('y', height - 6).attr('text-anchor', 'middle').attr('fill', t['--ink-2']).text(props.xTitle);

    const defs = svg.append('defs');
    defs.append('clipPath').attr('id', `${id}-up`).append('rect').attr('x', p.x0).attr('y', p.y0).attr('width', p.x1 - p.x0).attr('height', Math.max(0, y0 - p.y0));
    defs.append('clipPath').attr('id', `${id}-dn`).append('rect').attr('x', p.x0).attr('y', y0).attr('width', p.x1 - p.x0).attr('height', Math.max(0, p.y1 - y0));
    const idx = d3.range(n);
    const defined = (i) => isNum(vals[i]);
    const area = d3.area().defined(defined).x((i) => xs(mi[i])).y0(y0).y1((i) => y(vals[i]));
    svg.append('path').attr('d', area(idx)).attr('fill', t['--c-pos']).attr('fill-opacity', 0.12).attr('clip-path', `url(#${id}-up)`);
    svg.append('path').attr('d', area(idx)).attr('fill', t['--c-neg']).attr('fill-opacity', 0.12).attr('clip-path', `url(#${id}-dn)`);
    svg.append('line').attr('x1', p.x0).attr('x2', p.x1).attr('y1', Math.round(y0) + 0.5).attr('y2', Math.round(y0) + 0.5).attr('stroke', t['--axis']);
    if (props.zeroLabel) {
      svg.append('text').attr('x', p.x1 - 4).attr('y', y0 - 5).attr('text-anchor', 'end').attr('font-size', 11).attr('fill', t['--ink-2'])
        .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(props.zeroLabel);
    }
    svg.append('path').attr('d', d3.line().defined(defined).x((i) => xs(mi[i])).y((i) => y(vals[i]))(idx))
      .attr('fill', 'none').attr('stroke', t['--ink-2']).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');

    const fmt = valueFormatter(props.yFormat ?? 'pp');
    if (props.annotate !== false) {
      const iMin = idx.filter(defined).reduce((a, b) => (vals[b] < vals[a] ? b : a));
      if (vals[iMin] < 0) {
        const cx = xs(mi[iMin]), cy = y(vals[iMin]);
        const label = `最差 ${x[iMin]} ${fmt(vals[iMin])}`;
        const w = textWidth(label, 11);
        const ty = cy + 16 <= p.y1 - 2 ? cy + 16 : cy - 8;
        // Beside the dot when the plot has room, otherwise centred under it; never over the tick labels.
        let anchor = 'start', tx = cx + 8;
        if (tx + w > p.x1) { anchor = 'end'; tx = cx - 8; }
        if (anchor === 'end' && tx - w < p.x0) { anchor = 'middle'; tx = clamp(cx, p.x0 + w / 2, p.x1 - w / 2); }
        svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 3.5).attr('fill', t['--ink-2']).attr('stroke', t['--surface']).attr('stroke-width', 2);
        svg.append('text').attr('x', tx).attr('y', ty).attr('text-anchor', anchor).attr('font-size', 11)
          .attr('fill', t['--ink']).attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(label);
      }
    }

    const focus = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    const vline = focus.append('line').attr('y1', p.y0).attr('y2', p.y1).attr('stroke', t['--ink-2']).attr('stroke-opacity', 0.5);
    const dot = focus.append('circle').attr('r', 4).attr('fill', t['--ink-2']).attr('stroke', t['--surface']).attr('stroke-width', 2);
    const hideFocus = () => { focus.style('display', 'none'); tooltip.hide(root); };
    const focusAt = (i) => {
      if (i < 0 || !defined(i)) { hideFocus(); return; }
      focusIdx = i;
      const px = xs(mi[i]), py = y(vals[i]);
      focus.style('display', null);
      vline.attr('x1', px).attr('x2', px);
      dot.attr('cx', px).attr('cy', py);
      const c = clientPoint(svg.node(), px, py);
      tooltip.show({
        x: c.x, y: c.y, owner: root,
        title: props.years ? `买入 ${x[i]} · 持有至 ${addMonths(x[i], props.years * 12)}` : `买入 ${x[i]}`,
        rows: [{ colorVar: vals[i] >= 0 ? '--c-pos' : '--c-neg', value: fmt(vals[i]), label: props.valueLabel ?? '纳指100 − 标普500（年化）' }],
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
