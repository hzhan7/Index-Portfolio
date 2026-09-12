// §5 数据与方法: coverage strip, provenance, formulas, limitations, sources, downloads, vintage.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { toCsv, downloadCsv } from '../table.js?v=20260912';
import { mountPoint, chartSlot } from './common.js?v=20260912';

const STATUS_LABEL = { observed: '实测', constructed: '构建', estimated: '估算', model: '模型' };
const FORMULAS = [
  '年化复合收益 = exp(12 × 月均对数收益) − 1',
  '夏普比率 = √12 × 月均超额收益 ÷ 月超额收益标准差（超额 = 相对国库券）',
  '年化波动 = √12 × 月收益标准差；跟踪误差 = √12 × std(组合 − 标普500)；信息比率 = 年化超额 ÷ 跟踪误差',
  '最大回撤 = 月末净值相对此前高点的最大跌幅；最差12个月 = 滚动12个月复合收益的最小值',
  '同波动·收益最高：max μ′w，约束 波动 ≤ 标普500波动 × m、跟踪误差 ≤ k、w ≥ 0、Σw = 1',
  '收益≥标普·夏普最高：max 夏普比率，约束 年化复合收益 ≥ 标普500、w ≥ 0、Σw = 1',
  '切点组合：max (μ′w − c) ÷ √(w′Σw)，w ≥ 0；加杠杆 r = L·r切点 − (L − 1)·rf − max(L − 1, 0)·利差 ÷ 12',
  '价格比拆分：Δln(纳指/标普价格比) = Δln(相对市盈率) + Δln(相对EPS)；总回报差再加 Δln(含息/价格)纳指 − Δln(含息/价格)标普',
];
const LIMITS = [
  '纳指100 早期没有官方含息指数：股息按招募说明书年末股息率估算，区间见覆盖图。',
  '标普500 1985-02～1988-01 含息为构建序列：价格 × CRSP 股息时点，按年校准到公开年度总回报。',
  '10年美债为收益率推算的模型收益，与可交易基金净值有差异。',
  '未计交易成本与管理费；股息预扣税可在数据设置中选择。',
  '所有组合按月末再平衡；再平衡频率不同，结果会不同。',
  '1985-01 相对市盈率来自第三方图表读数与 Shiller 数据，按估算区间展示。',
  '均值方差规则对预期收益敏感，权重区间见重抽样。',
  '样本外结果只来自一条历史路径。',
  '最新月份的无风险利率可能为暂估值。',
];

// Source titles/notes come verbatim from the data files; numeric ranges are shown with ～ (§3.4).
export const tildeRanges = (s) => String(s)
  .replace(/(\d{4}(?:-\d{2})?)\s*[–—]\s*(\d{2,4}(?:-\d{2})?)(?!\d)/g, '$1～$2')
  .replace(/\b(\d{4})-(\d{4})\b/g, '$1～$2');

function segmentsByStatus(coverage) {
  const out = {};
  for (const c of coverage ?? []) {
    for (const s of c.segments ?? []) {
      const range = s.from === s.to ? s.from : `${s.from}～${s.to}`;
      (out[s.status] ??= []).push(s.status === 'model' ? range : `${c.label} ${range}`); // 模型 line already names 10年美债
    }
  }
  return out;
}

// Monthly returns of the current sample, straight from the sample bundle (engine/series.js output).
export const sampleRows = ({ months, R, rf }) => Array.from(months, (m, t) => [m, R[0][t], R[1][t], R[2][t], rf[t]]);

export function mount(rootEl, api) {
  const host = mountPoint(rootEl);
  const strip = chartSlot(api, 'coverageStrip', { ariaLabel: '数据覆盖与来源类型', filename: 'coverage.csv' });
  const provenance = el('ul', { class: 'methods__list' });
  const sources = el('ul', { class: 'methods__list methods__sources' });
  const vintage = el('p', { class: 'note' });
  const sampleBtn = el('button', { type: 'button', class: 'btn btn--ghost' }, ['当前样本CSV']);
  let view0 = null;
  sampleBtn.addEventListener('click', () => {
    const smp = view0?.bundles.sample?.sample;
    if (!smp?.R) return api.toast('样本计算中…');
    downloadCsv(`sample_${smp.start}_${smp.end}_${smp.basis}.csv`, toCsv(['month', 'ndx100', 'spx500', 'ust10y', 'rf'], sampleRows(smp)));
  });

  const section = (title, body) => el('div', { class: 'methods__block' }, [el('h3', { class: 'subhead' }, [title]), ...body]);
  host.appendChild(el('div', { class: 'methods' }, [
    section('数据覆盖', [strip.root, provenance]),
    section('公式', [el('ul', { class: 'methods__list methods__formulas' }, FORMULAS.map((f) => el('li', {}, [f])))]),
    section('局限', [el('ul', { class: 'methods__list' }, LIMITS.map((t) => el('li', {}, [t])))]),
    section('来源', [sources]),
    section('下载', [el('p', { class: 'param-row' }, [el('a', { class: 'btn btn--ghost', href: 'data/monthly_history.csv', download: 'monthly_history.csv' }, ['monthly_history.csv']), sampleBtn]), vintage]),
  ]));

  let sig = '';
  return {
    render(view) {
      view0 = view;
      const h = api.data?.history ?? {};
      const v = api.data?.valuation ?? {};
      const coverage = view.bundles.context?.coverage ?? h.coverage ?? [];
      const st = view.state;
      const next = `${keyOf(view.bundles.context)}|${st.start}|${st.end}|${view.latest}`;
      if (next === sig) return;
      sig = next;
      if (coverage.length) {
        const first = coverage.flatMap((c) => c.segments.map((s) => s.from)).sort()[0];
        strip.update({ key: next, range: [first, view.latest], highlight: { from: st.start, to: st.end ?? view.latest },
          series: coverage.map((c) => ({ id: c.id, label: c.label, segments: c.segments.map((s) => ({ from: s.from, to: s.to, status: s.status })) })) });
      }
      const by = segmentsByStatus(coverage);
      const m0 = v.m0_1985 && v.segments?.[0]?.start ? [`${v.segments[0].start} 相对市盈率（${v.m0_1985.low}～${v.m0_1985.high} 倍）`] : [];
      fill(provenance, [
        ['实测', '官方指数'], ['模型', `10年美债由收益率推算${by.model?.length ? `（${by.model.join('；')}）` : ''}`],
        ['构建', by.constructed?.join('；') ?? '—'], ['估算', [...(by.estimated ?? []), ...m0].join('；') || '—'],
        ['样本内 / 样本外', '样本内 = 用整个样本估计后在同一样本评估；样本外 = 每年1月只用此前数据重估'],
      ].map(([k, t]) => el('li', {}, [el('span', { class: 'chip chip--prov' }, [STATUS_LABEL[k] ?? k]), ' ', t])));
      const srcs = [...Object.entries(h.sources ?? {}), ...Object.entries(v.sources ?? {})];
      fill(sources, srcs.map(([id, s]) => el('li', { dataset: { source: id } }, [
        s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, [tildeRanges(s.title ?? id)]) : tildeRanges(s.title ?? id),
        s.note ? el('span', { class: 'cell-sub' }, [tildeRanges(s.note)]) : null,
      ])));
      fill(vintage, [`数据截至 ${h.as_of ?? view.latest}`, h.retrieved ? `（获取 ${h.retrieved}）` : '', v.licence_note ? ` · ${v.licence_note}` : '']);
    },
  };
}
