// Monthly return samples from history.json (schema v2) on the tr / pr basis.
import { engineError } from './params.js?v=20260912';

export const monthIndex = m => +m.slice(0, 4) * 12 + +m.slice(5, 7) - 1;
export const monthDiff = (a, b) => monthIndex(b) - monthIndex(a);
export const addMonths = (m, k) => {
  const i = monthIndex(m) + k;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
export const firstMonth = doc => doc.observations[0].month;
export const latestMonth = doc => doc.observations.at(-1).month;
// DGS10 is a semiannual bond-equivalent yield.
export const yieldToAnnualReturn = y => (1 + y / 2) ** 2 - 1;

const indexCache = new WeakMap();
function rowIndex(doc) {
  let map = indexCache.get(doc);
  if (!map) indexCache.set(doc, (map = new Map(doc.observations.map((o, i) => [o.month, i]))));
  return map;
}

export function y10At(doc, month) {
  const i = rowIndex(doc).get(month);
  const v = i == null ? null : doc.observations[i].dgs10_pct;
  return v == null ? null : v / 100;
}

const BANDS = ['default', 'low', 'high'];
const ok = Number.isFinite;

export function buildSample(doc, { start, end = null, basis = 'tr', ndxDiv = 'default', wht = 0, minMonths = 24 } = {}) {
  const obs = doc.observations, idx = rowIndex(doc);
  end = end ?? latestMonth(doc);
  if (!idx.has(start) || !idx.has(end) || start >= end) throw engineError('E_BAD_RANGE', `样本区间无效：${start}～${end}`);
  if (!['tr', 'pr'].includes(basis) || !BANDS.includes(ndxDiv)) throw engineError('E_BAD_RANGE', `口径参数无效：${basis}/${ndxDiv}`);
  const i0 = idx.get(start), n = idx.get(end) - i0;
  if (n < minMonths) throw engineError('E_SHORT_SAMPLE', `样本只有${n}个月，至少需要${minMonths}个月`);
  const R = [0, 1, 2].map(() => new Float64Array(n)), div = [new Float64Array(n), new Float64Array(n)];
  const rf = new Float64Array(n), dgs10 = new Float64Array(n), months = new Array(n);
  const ndxEst = [], spxCon = [];
  for (let t = 0; t < n; t++) {
    const o = obs[i0 + 1 + t];
    months[t] = o.month;
    let a, b, c;
    if (basis === 'tr') {
      const dv = o[`ndx_div_${ndxDiv}`];
      const ndx = o.ndx_tr ?? (ok(o.ndx_pr) && ok(dv) ? o.ndx_pr + dv : null);
      const spx = o.spx_tr ?? o.spx_tr_con;
      if (o.ndx_tr == null) ndxEst.push(o.month);
      if (o.spx_tr == null) spxCon.push(o.month);
      if (ok(ndx) && ok(o.ndx_pr)) div[0][t] = ndx - o.ndx_pr;
      if (ok(spx) && ok(o.spx_pr)) div[1][t] = spx - o.spx_pr;
      a = ndx - wht * div[0][t];
      b = spx - wht * div[1][t];
      c = o.bond_tr;
      if (!ok(ndx) || !ok(spx)) a = NaN;
    } else {
      [a, b, c] = [o.ndx_pr, o.spx_pr, o.bond_pr];
    }
    if (![a, b, c, o.RF, o.dgs10_pct].every(v => v != null && ok(v)))
      throw engineError('E_NULL_DATA', `${o.month} 缺少${basis === 'tr' ? '含息总回报' : '价格'}口径数据`);
    R[0][t] = a; R[1][t] = b; R[2][t] = c; rf[t] = o.RF; dgs10[t] = o.dgs10_pct / 100;
  }
  const range = list => (list.length ? { from: list[0], to: list.at(-1), count: list.length } : null);
  const inSample = new Set(months);
  const rfEstimated = (doc.quality_notes ?? [])
    .filter(q => q.field === 'RF' && q.status === 'estimated' && inSample.has(q.month)).map(q => q.month);
  return {
    start, end, basis, ndxDiv, wht, months, R, rf, div, n, years: n / 12,
    estimated: { ndxDiv: range(ndxEst), spxConstructed: range(spxCon), rfEstimated },
    dgs10, dgs10Start: obs[i0].dgs10_pct / 100, dgs10End: dgs10[n - 1],
    warnings: basis === 'pr' ? ['W_PR_SHARPE_VS_CASH'] : [],
  };
}

// Return rows [from, to) of a sample as a new sample (views, no copies).
export function sliceSample(s, from, to) {
  return {
    start: from === 0 ? s.start : s.months[from - 1], end: s.months[to - 1], basis: s.basis, ndxDiv: s.ndxDiv, wht: s.wht,
    months: s.months.slice(from, to), R: s.R.map(x => x.subarray(from, to)), rf: s.rf.subarray(from, to),
    div: s.div.map(x => x.subarray(from, to)), dgs10: s.dgs10.subarray(from, to),
    n: to - from, years: (to - from) / 12, dgs10Start: from === 0 ? s.dgs10Start : s.dgs10[from - 1], dgs10End: s.dgs10[to - 1],
    estimated: null, warnings: s.warnings,
  };
}
