// §3 result card: segmented weight bar (no in-segment labels), legend row, optional bootstrap whisker rows.
import {
  createChart, baseSvg, clientPoint, stepIndex, toArray, textWidth, note, legendRow, isNum, ASSET_COLOR_VARS,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, roundWeights, ASSET_SHORT, ASSET_NAMES, RANGE_SEP } from '../lib/format.js?v=20260912';

let uid = 0;
const pctInt = (v) => (isNum(v) ? String(Math.round(v * 100)) : '—');

export function toTable(props) {
  const w = toArray(props?.w);
  const wk = props?.whiskers;
  const names = props?.names ?? ASSET_NAMES;
  const ints = roundWeights(w);
  const raw = w.map((v, i) => [names[i], v, ...(wk ? [wk.p10?.[i], wk.p50?.[i], wk.p90?.[i]] : [])]);
  return {
    columns: ['资产', '权重', ...(wk ? ['p10', '中位', 'p90'] : [])],
    rows: raw.map(([name, , ...q], i) => [name, `${ints[i]}%`, ...q.map((v) => fmtPct(v, 0))]),
    raw,
  };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const w = toArray(props.w).map((v) => (isNum(v) ? Math.max(0, v) : 0));
    const total = w.reduce((a, b) => a + b, 0);
    if (!w.length || !(total > 0)) { note(root, props.emptyText ?? '暂无权重', 'ip-chart__empty'); return; }
    const labels = props.labels ?? ASSET_SHORT;
    const names = props.names ?? ASSET_NAMES;
    const colorVars = props.colorVars ?? ASSET_COLOR_VARS;
    const colors = w.map((_, i) => t.color(colorVars[i]));
    const ints = roundWeights(w);
    const scaleTot = Math.max(1, total);
    const wk = props.whiskers && ['p10', 'p50', 'p90'].every((q) => toArray(props.whiskers[q]).length >= w.length) ? props.whiskers : null;

    const rowsFor = (i) => [
      { colorVar: colorVars[i], shape: 'rect', value: fmtPct(w[i], 1), label: '权重' },
      ...(wk ? [
        { value: `${fmtPct(wk.p10[i], 0)}${RANGE_SEP}${fmtPct(wk.p90[i], 0)}`, label: '重抽样 p10～p90' },
        { value: fmtPct(wk.p50[i], 0), label: '重抽样中位' },
      ] : []),
    ];

    const barH = 16, pad = 6, id = `ip-wb-${++uid}`;
    const svg = baseSvg(d3, root, { width, height: barH + pad * 2, title, ariaLabel });
    svg.append('defs').append('clipPath').attr('id', id).append('rect').attr('x', 0).attr('y', pad).attr('width', width).attr('height', barH).attr('rx', 4);
    let acc = 0;
    const segs = w.map((v, i) => { const x0 = (acc / scaleTot) * width; acc += v; return { i, x0, x1: (acc / scaleTot) * width }; }).filter((s) => s.x1 - s.x0 > 0.5);
    const bar = svg.append('g').attr('clip-path', `url(#${id})`);
    segs.forEach((s, k) => {
      const x0 = s.x0 + (k ? 1 : 0), x1 = s.x1 - (k < segs.length - 1 ? 1 : 0);
      bar.append('rect').attr('x', x0).attr('y', pad).attr('width', Math.max(0, x1 - x0)).attr('height', barH).attr('fill', colors[s.i]);
    });
    const focusRing = svg.append('rect').attr('y', 1).attr('height', barH + pad * 2 - 2).attr('rx', 5).attr('fill', 'none')
      .attr('stroke', t['--ink']).attr('stroke-width', 1.5).attr('pointer-events', 'none').style('display', 'none');
    const hideFocus = () => { focusRing.style('display', 'none'); tooltip.hide(root); };
    const showSeg = (i, anchor = null) => {
      const s = segs.find((sg) => sg.i === i);
      if (!s) { hideFocus(); return; }
      focusIdx = segs.indexOf(s);
      focusRing.style('display', null).attr('x', s.x0 + 0.75).attr('width', Math.max(0, s.x1 - s.x0 - 1.5));
      const c = anchor ?? clientPoint(svg.node(), (s.x0 + s.x1) / 2, pad + barH);
      tooltip.show({ x: c.x, y: c.y, owner: root, title: names[i] ?? labels[i], rows: rowsFor(i) });
    };
    segs.forEach((s) => {
      svg.append('rect').attr('x', s.x0).attr('y', 0).attr('width', s.x1 - s.x0).attr('height', barH + pad * 2).attr('fill', 'transparent')
        .on('pointermove pointerdown', () => showSeg(s.i)).on('pointerleave', hideFocus);
    });
    svg.on('focus', () => showSeg(segs[Math.max(0, focusIdx)]?.i ?? 0))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hideFocus(); return; }
        const next = stepIndex(e.key, Math.max(0, focusIdx), segs.length, { page: 1 });
        if (next == null) return;
        e.preventDefault();
        showSeg(segs[next].i);
      });

    legendRow(root, w.map((_, i) => ({ kind: 'rect', color: colors[i], label: `${labels[i]} ${ints[i]}` })), t['--surface']);

    if (!wk) return;
    const rowH = 24;
    const texts = w.map((_, i) => `${pctInt(wk.p10[i])}${RANGE_SEP}${pctInt(wk.p90[i])}（中位 ${pctInt(wk.p50[i])}）`);
    const labelW = Math.max(...labels.map((l) => textWidth(l, 12))) + 10;
    const textW = width >= 360 ? Math.max(...texts.map((s) => textWidth(s, 11))) + 12 : 0;
    const tx0 = labelW, tx1 = Math.max(labelW + 40, width - textW - 6);
    const xs = d3.scaleLinear().domain([0, 1]).range([tx0, tx1]);
    const wsvg = baseSvg(d3, root, { width, height: w.length * rowH + 22, title: '重抽样权重区间', focusable: false }).style('margin-top', '10px');
    w.forEach((_, i) => {
      const y = i * rowH + 12;
      wsvg.append('text').attr('x', 0).attr('y', y).attr('dy', '0.35em').attr('fill', t['--ink']).text(labels[i]);
      wsvg.append('line').attr('x1', tx0).attr('x2', tx1).attr('y1', y + 0.5).attr('y2', y + 0.5).attr('stroke', t['--grid']);
      wsvg.append('line').attr('x1', xs(wk.p10[i])).attr('x2', xs(wk.p90[i])).attr('y1', y).attr('y2', y).attr('stroke', colors[i]).attr('stroke-width', 2).attr('stroke-linecap', 'round');
      wsvg.append('line').attr('x1', xs(w[i] / scaleTot)).attr('x2', xs(w[i] / scaleTot)).attr('y1', y - 7).attr('y2', y + 7).attr('stroke', t['--ink']).attr('stroke-width', 1.5);
      wsvg.append('circle').attr('cx', xs(wk.p50[i])).attr('cy', y).attr('r', 4).attr('fill', colors[i]).attr('stroke', t['--surface']).attr('stroke-width', 2);
      if (textW) wsvg.append('text').attr('class', 'ip-tick').attr('x', width).attr('y', y).attr('dy', '0.35em').attr('text-anchor', 'end').attr('fill', t['--ink-2']).text(texts[i]);
      wsvg.append('rect').attr('x', 0).attr('y', y - rowH / 2).attr('width', width).attr('height', rowH).attr('fill', 'transparent')
        .on('pointermove pointerdown', (e) => tooltip.show({ x: e.clientX, y: e.clientY, owner: root, title: names[i] ?? labels[i], rows: rowsFor(i) }))
        .on('pointerleave', () => tooltip.hide(root));
    });
    const axisY = w.length * rowH + 14;
    [0, 0.5, 1].forEach((v) => {
      wsvg.append('text').attr('class', 'ip-tick').attr('x', xs(v)).attr('y', axisY).attr('text-anchor', v === 0 ? 'start' : v === 1 ? 'end' : 'middle').attr('fill', t['--ink-2']).text(fmtPct(v, 0));
    });
    note(root, '线：重抽样 p10～p90 · 点：中位 · 竖线：当前权重');
  }

  return { update: chart.update, destroy: chart.destroy };
}
