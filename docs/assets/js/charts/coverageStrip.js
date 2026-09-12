// §5 data coverage: one row per series, neutral fills by provenance (no status hues), text labels + legend.
import {
  createChart, baseSvg, axisBottom, yearTicks, monthIndex, tickFormatter, clientPoint, stepIndex, textWidth, note,
  legendRow, textOn, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtMonths, RANGE_SEP } from '../lib/format.js?v=20260912';

export const STATUS_LABEL = { observed: '实测', model: '模型', constructed: '构建', estimated: '估算' };
// Gray step (near-surface-first ramp index): observed data recedes, the less direct the evidence the stronger the fill.
const STATUS_STEP = { observed: 1, model: 2, constructed: 3, estimated: 4 };

export function toTable(props) {
  const raw = (props?.series ?? []).flatMap((s) => (s.segments ?? []).map((sg) => [s.label, sg.from, sg.to, sg.status]));
  return { columns: ['序列', '起', '止', '状态'], rows: raw.map(([l, f, to, st]) => [l, f, to, STATUS_LABEL[st] ?? st]), raw };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const series = (props.series ?? []).filter((s) => (s.segments ?? []).length);
    const r0 = monthIndex(props.range?.[0]), r1 = monthIndex(props.range?.[1]);
    if (!series.length || !isNum(r0) || !isNum(r1) || r1 < r0) { note(root, props.emptyText ?? '暂无覆盖信息', 'ip-chart__empty'); return; }

    const stacked = width < 480;
    const labelW = stacked ? 0 : Math.max(...series.map((s) => textWidth(s.label, 12))) + 14;
    const barH = 18, rowGap = stacked ? 26 : 10, top = 26;
    const rowY = (k) => top + (stacked ? 16 : 0) + k * (barH + rowGap);
    const plotBottom = rowY(series.length - 1) + barH;
    const height = plotBottom + 26;
    const xs = d3.scaleLinear().domain([r0, r1 + 1]).range([labelW, Math.max(labelW + 1, width - 8)]);
    const svg = baseSvg(d3, root, { width, height, title, ariaLabel });
    const fillOf = (status) => t.gray[STATUS_STEP[status] ?? 2] ?? t['--gray-300'];

    axisBottom(svg, xs, yearTicks(r0, r1, Math.floor((width - labelW) / 56)), tickFormatter('month'), { y: plotBottom + 4, x0: labelW, x1: width - 8, tokens: t });

    const segs = [];
    series.forEach((s, k) => {
      const y = rowY(k);
      svg.append('text').attr('x', 0).attr('y', stacked ? y - 5 : y + barH / 2).attr('dy', stacked ? 0 : '0.35em').attr('fill', t['--ink']).text(s.label);
      s.segments.forEach((sg, si) => {
        // Return series start one month after the level series (first return = second level month): draw them contiguous.
        const from = monthIndex(sg.from);
        const a = clamp(si === 0 && from === r0 + 1 ? r0 : from, r0, r1 + 1), b = clamp(monthIndex(sg.to) + 1, r0, r1 + 1);
        if (!(b > a)) return;
        const x0 = xs(a) + 1, x1 = Math.max(xs(a) + 2, xs(b) - 1);
        const fill = fillOf(sg.status);
        svg.append('rect').attr('x', x0).attr('y', y).attr('width', x1 - x0).attr('height', barH).attr('rx', 2).attr('fill', fill);
        const label = STATUS_LABEL[sg.status] ?? sg.status;
        if (x1 - x0 >= textWidth(label, 11) + 10) {
          svg.append('text').attr('x', (x0 + x1) / 2).attr('y', y + barH / 2).attr('dy', '0.35em').attr('text-anchor', 'middle').attr('font-size', 11)
            .attr('fill', textOn(fill, t)).attr('pointer-events', 'none').text(label);
        }
        segs.push({ s, sg, x0, x1, y, fill });
      });
    });

    const hl = props.highlight;
    if (hl && isNum(monthIndex(hl.from)) && isNum(monthIndex(hl.to))) {
      const hx0 = Math.round(xs(clamp(monthIndex(hl.from), r0, r1 + 1))) + 0.5, hx1 = Math.round(xs(clamp(monthIndex(hl.to) + 1, r0, r1 + 1))) - 0.5;
      const yTop = top - 6;
      svg.append('path').attr('d', `M${hx0},${plotBottom + 3}V${yTop}H${hx1}V${plotBottom + 3}`).attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5);
      const label = `当前样本 ${hl.from}${RANGE_SEP}${hl.to}`;
      const lw = textWidth(label, 11);
      const lx = clamp((hx0 + hx1) / 2, lw / 2, width - lw / 2);
      svg.append('text').attr('x', lx).attr('y', yTop - 6).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', t['--ink'])
        .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(label);
    }

    const present = Object.keys(STATUS_LABEL).filter((st) => segs.some((d) => d.sg.status === st));
    legendRow(root, present.map((st) => ({ kind: 'rect', color: fillOf(st), label: props.statusLabels?.[st] ?? STATUS_LABEL[st] })), t['--surface']);

    const ring = svg.append('rect').attr('fill', 'none').attr('stroke', t['--ink']).attr('stroke-width', 1.5).attr('rx', 3).attr('pointer-events', 'none').style('display', 'none');
    const hideFocus = () => { ring.style('display', 'none'); tooltip.hide(root); };
    const showSeg = (k) => {
      const d = segs[k];
      if (!d) { hideFocus(); return; }
      focusIdx = k;
      ring.style('display', null).attr('x', d.x0 - 2).attr('y', d.y - 2).attr('width', d.x1 - d.x0 + 4).attr('height', barH + 4);
      const months = monthIndex(d.sg.to) - monthIndex(d.sg.from) + 1;
      const c = clientPoint(svg.node(), (d.x0 + d.x1) / 2, d.y + barH);
      tooltip.show({
        x: c.x, y: c.y, owner: root, title: d.s.label,
        rows: [{ colorVar: d.fill, shape: 'rect', value: STATUS_LABEL[d.sg.status] ?? d.sg.status, label: `${d.sg.from}${RANGE_SEP}${d.sg.to}（${fmtMonths(months)}）` }],
      });
    };
    segs.forEach((d, k) => {
      svg.append('rect').attr('x', d.x0).attr('y', d.y - 3).attr('width', Math.max(24, d.x1 - d.x0)).attr('height', barH + 6).attr('fill', 'transparent')
        .on('pointermove pointerdown', () => showSeg(k)).on('pointerleave', hideFocus);
    });
    svg.on('focus', () => showSeg(Math.max(0, focusIdx)))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hideFocus(); return; }
        const next = stepIndex(e.key, Math.max(0, focusIdx), segs.length, { page: 1 });
        if (next == null) return;
        e.preventDefault();
        showSeg(next);
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
