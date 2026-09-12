// §3 两资产 tab: 1×2 panels (夏普比率, 年化复合收益) vs weight, shared x, ink guides labelled once, 标普500 line.
import {
  createChart, baseSvg, axisBottom, axisLeftGrid, tickFormatter, clientPoint, stepIndex, toArray, textWidth, note,
  layoutLabels, circled, nearestIndex, isNum, clamp,
} from './core.js?v=20260912';
import * as tooltip from './tooltip.js?v=20260912';
import { fmtPct, fmtNum } from '../lib/format.js?v=20260912';

const panelFormat = (panel, table = false) => (panel?.yFormat === 'pct' ? (v) => fmtPct(v, table ? 2 : 1) : (v) => fmtNum(v, 2));

/** Merge guides whose x differ by < tol into one guide with joint labels. */
export function mergeGuides(guides, tol = 1e-4) {
  const out = [];
  for (const gd of [...(guides ?? [])].filter((d) => isNum(d?.x)).sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && Math.abs(gd.x - last.x) < tol) { if (!last.labels.includes(gd.label)) last.labels.push(gd.label); } else out.push({ x: gd.x, labels: [gd.label] });
  }
  return out;
}

export function toTable(props) {
  const x = toArray(props?.x);
  const panels = props?.panels ?? [];
  const vals = panels.map((pn) => toArray(pn.values));
  const at = (i) => panels.map((_, k) => vals[k][i] ?? null);
  const raw = [];
  for (const gd of mergeGuides(props?.guides)) raw.push([`${gd.labels.join(' · ')} ${fmtPct(gd.x, 1)}`, ...at(nearestIndex(x, gd.x))]);
  for (let q = 0; q <= 10; q++) { const i = nearestIndex(x, q / 10); if (i >= 0) raw.push([fmtPct(x[i], 0), ...at(i)]); }
  return {
    columns: [props?.xLabel ?? '权重', ...panels.map((pn) => pn.label)],
    rows: raw.map(([label, ...vs]) => [label, ...vs.map((v, k) => panelFormat(panels[k], true)(v))]),
    raw,
  };
}

export function create(el, { title = '', ariaLabel = '' } = {}) {
  let focusIdx = -1;
  const chart = createChart(el, { title, ariaLabel }, draw, { onDestroy: () => tooltip.release(chart.root) });

  function draw({ root, width, props, tokens: t, d3 }) {
    root.replaceChildren();
    const x = toArray(props.x);
    const n = x.length;
    const panels = (props.panels ?? []).map((pn) => ({ ...pn, v: toArray(pn.values) })).filter((pn) => pn.v.length >= n);
    if (n < 2 || !panels.length) { note(root, props.emptyText ?? '暂无两资产曲线', 'ip-chart__empty'); return; }

    const cols = width >= 640 && panels.length > 1 ? 2 : 1;
    const gap = cols === 2 ? 32 : 0;
    const panelW = (width - gap * (cols - 1)) / cols;
    const plotH = width < 560 ? 170 : 200;
    const xDom = [x[0], x[n - 1]];
    const curveColor = t.color(props.colorVar ?? '--c-pos');

    const geo = panels.map((pn) => {
      const lo = Math.min(d3.min(pn.v, (v) => (isNum(v) ? v : Infinity)), isNum(pn.spxValue) ? pn.spxValue : Infinity);
      const hi = Math.max(d3.max(pn.v, (v) => (isNum(v) ? v : -Infinity)), isNum(pn.spxValue) ? pn.spxValue : -Infinity);
      const y = d3.scaleLinear().domain(lo === hi ? [lo - 0.01, hi + 0.01] : [lo, hi]).nice(4);
      const ticks = y.ticks(4);
      const tf = tickFormatter(pn.yFormat === 'pct' ? 'pct' : 'num', ticks[1] - ticks[0]);
      return { pn, y, ticks, tf, left: Math.max(...ticks.map((v) => textWidth(tf(v), 11))) + 12 };
    });
    const left = Math.max(...geo.map((gg) => gg.left));

    // Guide labels are laid out once, above the first panel.
    const guides = mergeGuides(props.guides).filter((gd) => gd.x >= xDom[0] && gd.x <= xDom[1]);
    const xs0 = d3.scaleLinear().domain(xDom).range([left, panelW - 12]);
    let texts = guides.map((gd) => `${gd.labels.join(' · ')} ${fmtPct(gd.x, 0)}`);
    let placed = layoutLabels(texts.map((s, k) => ({ x: xs0(guides[k].x), width: textWidth(s, 11) })), { left: 0, right: panelW, gap: 8, maxRows: 3 });
    let keyed = false;
    if (placed.some((pl) => pl.row < 0)) {
      keyed = true;
      texts = guides.map((gd, k) => `${circled(k)} ${fmtPct(gd.x, 0)}`);
      placed = layoutLabels(texts.map((s, k) => ({ x: xs0(guides[k].x), width: textWidth(s, 11) })), { left: 0, right: panelW, gap: 4, maxRows: 3 });
    }
    const labelRows = Math.max(0, ...placed.map((pl) => pl.row + 1));
    const bottomBand = 30, rowGap = 12;
    const rowsN = Math.ceil(panels.length / cols);
    // Only the first row carries the guide labels under its panel titles.
    const heads = Array.from({ length: rowsN }, (_, r) => (r === 0 ? 32 + labelRows * 15 : 26));
    const rowY0 = [];
    let acc = 0;
    for (const head of heads) { rowY0.push(acc + head); acc += head + plotH + bottomBand + rowGap; }
    const height = acc - rowGap + (props.xLabel ? 18 : 0);
    const svg = baseSvg(d3, root, { width, height, title, ariaLabel }).style('touch-action', 'pan-y');

    const frames = geo.map((gg, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const ox = col * (panelW + gap);
      const p = { x0: ox + left, x1: ox + panelW - 12, y0: rowY0[row], y1: rowY0[row] + plotH };
      const xs = d3.scaleLinear().domain(xDom).range([p.x0, p.x1]);
      gg.y.range([p.y1, p.y0]);
      return { ...gg, p, xs, ox, row };
    });

    for (const [k, f] of frames.entries()) {
      const { pn, p, xs, y, ticks, tf } = f;
      const fmt = panelFormat(pn);
      svg.append('text').attr('x', f.ox + 4).attr('y', f.row === 0 ? 16 : p.y0 - 10).attr('font-weight', 600).attr('fill', t['--ink']).text(pn.label);
      axisLeftGrid(svg, y, ticks, tf, { x: p.x0, x1: p.x1, tokens: t });
      const xt = xs.ticks(width < 560 ? 4 : 5);
      axisBottom(svg, xs, xt, tickFormatter('pct', xt[1] - xt[0]), { y: p.y1, x0: p.x0, x1: p.x1, tokens: t });
      const rowY = (gi) => p.y0 - 12 - (labelRows - 1 - placed[gi].row) * 15;
      for (const [gi, gd] of guides.entries()) {
        const gx = Math.round(xs(gd.x)) + 0.5;
        const yTop = k === 0 && placed[gi].row >= 0 ? rowY(gi) + 3 : p.y0;
        svg.append('line').attr('x1', gx).attr('x2', gx).attr('y1', yTop).attr('y2', p.y1).attr('stroke', t['--ink']).attr('stroke-width', 1);
      }
      if (isNum(pn.spxValue)) {
        const sy = Math.round(y(pn.spxValue)) + 0.5;
        svg.append('line').attr('x1', p.x0).attr('x2', p.x1).attr('y1', sy).attr('y2', sy).attr('stroke', t['--c-spx']).attr('stroke-width', 1.5);
        const label = `标普500 ${fmt(pn.spxValue)}`;
        const lw = textWidth(label, 11);
        // First corner slot (right/left × above/below the line) that the curve does not cross.
        const clear = ([lx, ly]) => {
          if (ly - 12 < p.y0 || ly + 3 > p.y1) return false;
          for (let i = 0; i < n; i += 4) {
            const cx = xs(x[i]);
            if (cx < lx - 3 || cx > lx + lw + 3 || !isNum(pn.v[i])) continue;
            const cy = y(pn.v[i]);
            if (cy > ly - 15 && cy < ly + 6) return false;
          }
          return true;
        };
        const slots = [[p.x1 - 4 - lw, sy - 6], [p.x0 + 6, sy - 6], [p.x1 - 4 - lw, sy + 15], [p.x0 + 6, sy + 15]];
        const [lx, ly] = slots.find(clear) ?? slots[0];
        svg.append('text').attr('x', lx).attr('y', ly).attr('font-size', 11).attr('fill', t['--ink'])
          .attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(label);
      }
      if (k === 0) {
        guides.forEach((_, gi) => {
          if (placed[gi].row < 0) return;
          svg.append('text').attr('x', placed[gi].x).attr('y', rowY(gi)).attr('text-anchor', 'middle')
            .attr('font-size', 11).attr('fill', t['--ink']).attr('stroke', t['--surface']).attr('stroke-width', 3).attr('paint-order', 'stroke').text(texts[gi]);
        });
      }
      svg.append('path').attr('d', d3.line().defined((i) => isNum(pn.v[i])).x((i) => xs(x[i])).y((i) => y(pn.v[i]))(d3.range(n)))
        .attr('fill', 'none').attr('stroke', curveColor).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
      for (const gd of guides) {
        const i = nearestIndex(x, gd.x);
        if (!isNum(pn.v[i])) continue;
        svg.append('circle').attr('cx', xs(gd.x)).attr('cy', y(pn.v[i])).attr('r', 3.5).attr('fill', t['--ink']).attr('stroke', t['--surface']).attr('stroke-width', 2);
      }
    }
    if (props.xLabel) svg.append('text').attr('x', width / 2).attr('y', height - 4).attr('text-anchor', 'middle').attr('fill', t['--ink-2']).text(props.xLabel);
    if (keyed) note(root, guides.map((gd, k) => `${circled(k)} ${gd.labels.join(' · ')}`).join('　'));

    const focus = svg.append('g').attr('pointer-events', 'none').style('display', 'none');
    const marks = frames.map((f) => ({
      line: focus.append('line').attr('y1', f.p.y0).attr('y2', f.p.y1).attr('stroke', t['--ink-2']).attr('stroke-opacity', 0.5),
      dot: focus.append('circle').attr('r', 4).attr('fill', curveColor).attr('stroke', t['--surface']).attr('stroke-width', 2),
    }));
    const hideFocus = () => { focus.style('display', 'none'); tooltip.hide(root); };
    const focusAt = (i, panelK = 0) => {
      if (i < 0 || i >= n) { hideFocus(); return; }
      focusIdx = i;
      focus.style('display', null);
      frames.forEach((f, k) => {
        const px = f.xs(x[i]);
        marks[k].line.attr('x1', px).attr('x2', px);
        marks[k].dot.attr('cx', px).attr('cy', f.y(isNum(f.pn.v[i]) ? f.pn.v[i] : f.y.domain()[0]));
      });
      const f = frames[clamp(panelK, 0, frames.length - 1)];
      const c = clientPoint(svg.node(), f.xs(x[i]), f.y(isNum(f.pn.v[i]) ? f.pn.v[i] : f.y.domain()[0]));
      const names = props.xNames;
      tooltip.show({
        x: c.x, y: c.y, owner: root,
        title: names ? `${names[0]} ${fmtPct(x[i], 1)} · ${names[1]} ${fmtPct(1 - x[i], 1)}` : fmtPct(x[i], 1),
        rows: frames.map((ff) => ({
          colorVar: props.colorVar ?? '--c-pos', value: panelFormat(ff.pn)(ff.pn.v[i]),
          label: `${ff.pn.label}${isNum(ff.pn.spxValue) ? `（标普500 ${panelFormat(ff.pn)(ff.pn.spxValue)}）` : ''}`,
        })),
      });
    };
    frames.forEach((f, k) => {
      svg.append('rect').attr('x', f.p.x0).attr('y', f.p.y0).attr('width', f.p.x1 - f.p.x0).attr('height', f.p.y1 - f.p.y0).attr('fill', 'transparent')
        .on('pointermove pointerdown', (e) => focusAt(nearestIndex(x, f.xs.invert(d3.pointer(e)[0])), k))
        .on('pointerleave', hideFocus);
    });
    const unit = Math.max(1, Math.round(0.01 / ((x[n - 1] - x[0]) / (n - 1) || 0.01)));
    svg.on('focus', () => focusAt(focusIdx >= 0 && focusIdx < n ? focusIdx : nearestIndex(x, guides[0]?.x ?? 0.5)))
      .on('blur', hideFocus)
      .on('keydown', (e) => {
        if (e.key === 'Escape') { hideFocus(); return; }
        const cur = Math.max(0, focusIdx);
        const next = stepIndex(e.key, Math.round(cur / unit), Math.floor((n - 1) / unit) + 1, { page: 5, shift: e.shiftKey });
        if (next == null) return;
        e.preventDefault();
        focusAt(Math.min(n - 1, next * unit));
      });
  }

  return { update: chart.update, destroy: chart.destroy };
}
