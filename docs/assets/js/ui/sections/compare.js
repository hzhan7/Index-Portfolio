// §1 纳指100 vs 标普500: KPI table, rolling excess, relative wealth, regime table.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { createCopy } from '../copy.js?v=20260912';
import { tableBlock } from '../table.js?v=20260912';
import { mountPoint, statusLine, applyStatus, chartSlot, segControl, addMonths } from './common.js?v=20260912';

const ROLL_YEARS = [5, 10, 15, 20];

function kpiRows(sb, C) {
  const { K, N } = C;
  const h = sb.h2h;
  const p = 'sample.h2h';
  const pct = (x, k, sub) => ({ t: K.pct(x, 2), k, v: x, sub });
  const pp = (x, k) => ({ t: K.pp(x, 2), k, v: x });
  const sh = (x, k, sign = false) => ({ t: K.sharpe(x, sign), k, v: x });
  // engine recoveryMonths counts trough → recovery month
  const mddSub = (s) => (s.mddPeak ? [el('span', { class: 'nowrap' }, [`${s.mddPeak}～${s.mddTrough}`]),
    ` · ${s.recoveryMonths != null ? `谷底后 ${s.recoveryMonths} 个月回本` : '样本内未回本'}`] : null);
  const ci = h.sharpeDiffCI;
  const rows = [
    ['年化复合收益', pct(h.ndx.cagr, `${p}.ndx.cagr`), pct(h.spx.cagr, `${p}.spx.cagr`), pp(h.diff.cagr, `${p}.diff.cagr`)],
    ['夏普比率', sh(h.ndx.sharpe, `${p}.ndx.sharpe`), sh(h.spx.sharpe, `${p}.spx.sharpe`),
      { t: `${K.sharpe(h.diff.sharpe, true)}（95%区间 ${K.sharpe(ci.lo, true)}～${K.sharpe(ci.hi, true)}）`, k: `${p}.diff.sharpe`, v: h.diff.sharpe }],
    ['年化波动', pct(h.ndx.vol, `${p}.ndx.vol`), pct(h.spx.vol, `${p}.spx.vol`), pp(h.diff.vol, `${p}.diff.vol`)],
    ['最大回撤（峰～谷，谷底后回本月数）', pct(h.ndx.mdd, `${p}.ndx.mdd`, mddSub(h.ndx)), pct(h.spx.mdd, `${p}.spx.mdd`, mddSub(h.spx)), pp(h.diff.mdd, `${p}.diff.mdd`)],
    ['最差12个月', pct(h.ndx.worst12m, `${p}.ndx.worst12m`, h.ndx.worst12mEnd && `截至 ${h.ndx.worst12mEnd}`),
      pct(h.spx.worst12m, `${p}.spx.worst12m`, h.spx.worst12mEnd && `截至 ${h.spx.worst12mEnd}`), pp(h.diff.worst12m, `${p}.diff.worst12m`)],
    [{ th: true, children: [h.volMatched.levered ? '加杠杆到标普波动后的年化收益 ' : '降到标普波动后的年化收益 ', el('span', { class: 'chip' }, ['纳指100+现金'])] },
      pct(h.volMatched.ndxCagr, `${p}.volMatched.ndxCagr`), pct(h.volMatched.spxCagr, `${p}.volMatched.spxCagr`), pp(h.volMatched.spread, `${p}.volMatched.spread`)],
  ];
  if (h.priceBasis) {
    const d = h.priceBasis.ndxSharpe - h.priceBasis.spxSharpe;
    rows.push(['价格口径夏普', sh(h.priceBasis.ndxSharpe, `${p}.priceBasis.ndxSharpe`), sh(h.priceBasis.spxSharpe, `${p}.priceBasis.spxSharpe`),
      sh(d, `derived:${p}.priceBasis.ndxSharpe-${p}.priceBasis.spxSharpe`, true)]);
  }
  if (h.divContribution) {
    const { ndx, spx } = h.divContribution;
    rows.push(['股息贡献（年化）', pp(ndx, `${p}.divContribution.ndx`), pp(spx, `${p}.divContribution.spx`), pp(ndx - spx, `derived:${p}.divContribution.ndx-${p}.divContribution.spx`)]);
  }
  const ab = h.alphaBeta;
  rows.push({
    cls: 'kpi-span',
    cells: [{ colspan: 4, children: ['相对标普500：β ', N(K.num(ab.beta, 2), `${p}.alphaBeta.beta`, ab.beta), ' · 年化α ', N(K.pct(ab.alphaAnn, 2), `${p}.alphaBeta.alphaAnn`, ab.alphaAnn),
      '（t=', N(K.num(ab.tAlphaNW, 2), `${p}.alphaBeta.tAlphaNW`, ab.tAlphaNW), '）'] }],
  });
  return rows;
}

function periodRows(rows, C, path, latest) {
  const { K } = C;
  return rows.map((r, i) => {
    const to = r.to === 'latest' ? latest : r.to;
    const k = `${path}.${i}`;
    const val = (side) => (r.short
      ? { t: K.pct(r[side].cumReturn, 2), k: `${k}.${side}.cumReturn`, v: r[side].cumReturn, sub: '区间收益' }
      : { t: K.pct(r[side].cagr, 2), k: `${k}.${side}.cagr`, v: r[side].cagr });
    // short rows: the gap of the two 区间收益 cells, labelled as such (engine spreadCum when present)
    const cumGap = Number.isFinite(r.spreadCum) ? { v: r.spreadCum, k: `${k}.spreadCum` }
      : { v: r.ndx.cumReturn - r.spx.cumReturn, k: `derived:${k}.ndx.cumReturn-${k}.spx.cumReturn` };
    const diff = r.short ? { t: K.pp(cumGap.v, 2), k: cumGap.k, v: cumGap.v, sub: '区间收益差' } : { t: K.pp(r.spreadCagr, 2), k: `${k}.spreadCagr`, v: r.spreadCagr };
    const sharpe = (side) => (r.short || r[side].sharpe == null ? { t: 'n/m' } : { t: K.sharpe(r[side].sharpe), k: `${k}.${side}.sharpe`, v: r[side].sharpe });
    const range = `${r.from}～${to}`;
    return [{ t: r.label, sub: r.label === range ? null : range, th: true }, val('ndx'), val('spx'), diff,
      sharpe('ndx'), sharpe('spx'), { t: K.pct(r.ndx.mdd, 2), k: `${k}.ndx.mdd`, v: r.ndx.mdd }, { t: K.pct(r.spx.mdd, 2), k: `${k}.spx.mdd`, v: r.spx.mdd }];
  });
}

const PERIOD_HEAD = [
  [{ t: '阶段', rowspan: 2 }, { t: '年化复合收益', colspan: 3 }, { t: '夏普比率', colspan: 2 }, { t: '最大回撤', colspan: 2 }],
  ['纳指100', '标普500', '差', '纳指100', '标普500', '纳指100', '标普500'],
];

export function mount(rootEl, api) {
  const C = createCopy(api.format);
  const { K, N } = C;
  const host = mountPoint(rootEl);
  const status = statusLine();
  const kpi = el('div', { class: 'compare__kpi' });
  const rolling = chartSlot(api, 'areaDiverging', { ariaLabel: '滚动持有期纳指100减标普500年化收益差', filename: 'rolling_excess.csv' });
  const rollYears = segControl({ label: '持有年数', options: ROLL_YEARS.map((y) => ({ value: y, label: `${y}年` })), onSelect: (y) => api.setState({ roll: y }) });
  const rollVm = segControl({ label: '同波动调整', options: [{ value: 1, label: '同波动调整' }], onSelect: () => api.setState({ rollVm: !api.getState().rollVm }) });
  const annotation = el('p', { class: 'note compare__annotation' });
  const wealth = chartSlot(api, 'lineChart', { ariaLabel: '纳指100相对标普500累计净值比', filename: 'relative_wealth.csv' });
  const periods = el('div', { class: 'compare__periods' });

  host.appendChild(status);
  host.appendChild(kpi);
  host.appendChild(el('div', { class: 'compare__rolling' }, [el('div', { class: 'param-row' }, [rollYears.root, rollVm.root]), rolling.root, annotation]));
  host.appendChild(wealth.root);
  host.appendChild(periods);

  const sig = { kpi: '', roll: '', wealth: '', periods: '' };

  return {
    render(view) {
      applyStatus(host, status, view, ['sample', 'context']);
      const { sample: sb, context: ctx } = view.bundles;
      const st = view.state;
      const end = st.end ?? view.latest;
      rollYears.set(st.roll);
      rollVm.set(st.rollVm ? 1 : 0);

      if (sb && keyOf(sb) !== sig.kpi) {
        sig.kpi = keyOf(sb);
        const cap = `${sb.sample.start}～${sb.sample.end} · ${sb.sample.basis === 'pr' ? '价格口径' : '含息总回报'}`;
        fill(kpi, [tableBlock({ caption: `纳指100 与 标普500（${cap}）`, head: [['指标', '纳指100', '标普500', '差值']], rows: kpiRows(sb, C), className: 'table table--kpi', cellLabels: true })]);
      }

      if (ctx?.rolling) {
        const r = ctx.rolling;
        const hlTo = addMonths(end, -12 * r.years);
        const highlight = st.start <= hlTo ? { from: st.start, to: hlTo } : null;
        const key = `${keyOf(ctx)}|${st.start}|${end}`;
        if (key !== sig.roll) {
          sig.roll = key;
          rolling.setTitle(C.rollingTitle(ctx));
          fill(annotation, C.rollingAnnotation(ctx));
          rolling.update({ key, x: r.points.start, values: r.points.excess, yFormat: 'pp', highlight, xTitle: `买入月份（持有${r.years}年）`, zeroLabel: '持平' });
        }
      }

      if (sb?.relativeWealth && ctx?.regimes) {
        const key = `${keyOf(sb)}|${keyOf(ctx)}`;
        if (key !== sig.wealth) {
          sig.wealth = key;
          const rw = sb.relativeWealth;
          const [m0, m1] = [rw.months[0], rw.months[rw.months.length - 1]];
          const bands = ctx.regimes
            .map((g) => ({ from: g.from < m0 ? m0 : g.from, to: (g.to === 'latest' ? view.latest : g.to) > m1 ? m1 : (g.to === 'latest' ? view.latest : g.to), label: g.label }))
            .filter((b) => b.from < b.to);
          wealth.setTitle(['纳指100 相对标普500：', N(K.ratio(rw.endRatio), 'sample.relativeWealth.endRatio', rw.endRatio),
            `（${sb.sample.basis === 'pr' ? '价格' : '含息'}，`, N(sb.sample.start, 'sample.sample.start'), '～', N(sb.sample.end, 'sample.sample.end'), '）']);
          wealth.update({ key, x: rw.months, series: [{ id: 'ratio', label: '纳指100 ÷ 标普500', colorVar: '--ink', values: rw.ratio, emphasis: true }], yScale: 'log', yFormat: 'ratio', bands, baseline: 1 });
        }
      }

      if (ctx?.regimes && keyOf(ctx) !== sig.periods) {
        sig.periods = keyOf(ctx);
        const groupRow = (t) => ({ cls: 'group-row', cells: [{ t, colspan: 8, th: true, scope: 'colgroup' }] });
        const rows = [groupRow('按市场阶段'), ...periodRows(ctx.regimes, C, 'context.regimes', view.latest)];
        if (ctx.decades?.length) rows.push(groupRow('按十年'), ...periodRows(ctx.decades, C, 'context.decades', view.latest));
        fill(periods, [tableBlock({ caption: '分阶段表现（全部数据区间；不足36个月显示区间收益）', head: PERIOD_HEAD, rows, className: 'table table--periods' })]);
      }
    },
  };
}
