// NDX/SPX relative price = relative P/E × relative EPS, decomposed between valuation anchors (log points, SPEC §2.7).
// ln R = ln M + ln E with R = NDX/SPX price ratio, M = relative P/E, E = R/M; total return adds the dividend term
// D = Δln(TR/PR)_NDX − Δln(TR/PR)_SPX. lp = 100·ln; every term is additive across factors and contiguous periods.
import { buildSample, monthDiff } from './series.js?v=20260912';

const MIN_TOTAL_LN = 0.10;
const MIN_ANNUAL_LP = 1;
const lpYr = (ln, years) => 100 * ln / years;

/** Shares are shown only for material moves: |ln total| ≥ 0.10 and |annual| ≥ 1 lp. */
export const isMaterial = (ln, years) => Math.abs(ln) >= MIN_TOTAL_LN && Math.abs(lpYr(ln, years)) >= MIN_ANNUAL_LP;

/** Row terms from log changes; lnD = null → no dividend / total-return terms. */
export function identityRow({ years, lnR, lnM, lnD = null }) {
  const lnE = lnR - lnM;
  const lnT = lnD == null ? null : lnR + lnD;
  const opt = f => (lnD == null ? null : f());
  return {
    years,
    price_lp_yr: lpYr(lnR, years), pe_lp_yr: lpYr(lnM, years), eps_lp_yr: lpYr(lnE, years),
    div_lp_yr: opt(() => lpYr(lnD, years)), tr_lp_yr: opt(() => lpYr(lnT, years)),
    factors: { price: Math.exp(lnR), pe: Math.exp(lnM), eps: Math.exp(lnE), div: opt(() => Math.exp(lnD)), tr: opt(() => Math.exp(lnT)) },
    sharesPrice: isMaterial(lnR, years) ? { pe: lnM / lnR, eps: lnE / lnR } : null,
    sharesTr: lnD != null && isMaterial(lnT, years) ? { pe: lnM / lnT, eps: lnE / lnT, div: lnD / lnT } : null,
  };
}

export function anchorValue(valuation, month, tier) {
  const hit = valuation.anchors.find(a => a.month === month && a.tier === tier);
  if (hit) return hit.M;
  if (valuation.latest.month === month && valuation.latest.tier === tier) return valuation.latest.M;
  throw Object.assign(new Error(`估值锚点缺失：${month}（${tier}）`), { code: 'E_NULL_DATA' });
}

function levelRatio(historyDoc, month) {
  const o = historyDoc.observations.find(r => r.month === month);
  if (!o || !(o.NDX > 0 && o.SPX > 0)) throw Object.assign(new Error(`缺少 ${month} 的指数水平`), { code: 'E_NULL_DATA' });
  return o.NDX / o.SPX;
}

/** Cumulative dividend term over the tr-basis sample start…end: D(a, b) = cum[b] − cum[a]. */
function dividendTermFn(historyDoc, start, end, ndxDiv, wht) {
  const s = buildSample(historyDoc, { start, end, basis: 'tr', ndxDiv, wht, minMonths: 1 });
  const rows = new Map(historyDoc.observations.map(o => [o.month, o]));
  const cum = new Map([[start, 0]]);
  let d = 0;
  for (let t = 0; t < s.n; t++) {
    const o = rows.get(s.months[t]);
    d += (Math.log1p(s.R[0][t]) - Math.log1p(o.ndx_pr)) - (Math.log1p(s.R[1][t]) - Math.log1p(o.spx_pr));
    cum.set(s.months[t], d);
  }
  return (a, b) => cum.get(b) - cum.get(a);
}

export function breakEven(historyDoc, valuation) {
  const segs = valuation.segments;
  const start = segs[0].start, end = segs.at(-1).end;
  const R0 = levelRatio(historyDoc, start), RT = levelRatio(historyDoc, end);
  const lnR = Math.log(RT / R0), M_end = valuation.latest.M;
  return { R0, RT, lnR, years: monthDiff(start, end) / 12, M_end,
    m0ForPeShare: { p0: M_end, p25: M_end * Math.exp(-0.25 * lnR), p50: M_end * Math.exp(-0.5 * lnR) } };
}

/** Full-period price split for a 1985-01 relative P/E M0 (slider). */
export function splitAtM0(be, M0) {
  const lnM = Math.log(be.M_end / M0), lnE = be.lnR - lnM;
  return { pe_lp_yr: lpYr(lnM, be.years), eps_lp_yr: lpYr(lnE, be.years),
    epsSharePrice: isMaterial(be.lnR, be.years) ? lnE / be.lnR : null, factors: { pe: Math.exp(lnM), eps: Math.exp(lnE) } };
}

export function anchorDecomposition(historyDoc, valuation, { ndxDiv = 'default', wht = 0, m0 = null } = {}) {
  const segs = valuation.segments;
  const start = segs[0].start, end = segs.at(-1).end;
  const divTerm = dividendTermFn(historyDoc, start, end, ndxDiv, wht);
  const row = (a, b, M_start, M_end) => ({ start: a, end: b, M_start, M_end, ...identityRow({
    years: monthDiff(a, b) / 12, lnR: Math.log(levelRatio(historyDoc, b) / levelRatio(historyDoc, a)), lnM: Math.log(M_end / M_start), lnD: divTerm(a, b) }) });

  const rows = segs.map(sg => {
    const override = m0 != null && sg.start === start;
    const M_start = override ? m0 : anchorValue(valuation, sg.start, sg.startTier);
    return { id: sg.id, label: sg.label, startTier: override ? 'user' : sg.startTier, endTier: sg.endTier, splice: sg.splice,
      ...row(sg.start, sg.end, M_start, anchorValue(valuation, sg.end, sg.endTier)) };
  });
  const m0Used = m0 ?? valuation.m0_1985.central;
  const be = breakEven(historyDoc, valuation);
  const lo = splitAtM0(be, valuation.m0_1985.low), hi = splitAtM0(be, valuation.m0_1985.high);
  const range = k => (lo[k] == null || hi[k] == null ? null : [Math.min(lo[k], hi[k]), Math.max(lo[k], hi[k])]);
  const full = { id: 'full', label: '全期', startTier: m0 == null ? valuation.m0_1985.tier : 'user', endTier: valuation.latest.tier, splice: false,
    ...row(start, end, m0Used, valuation.latest.M), m0Used,
    band: { m0Low: valuation.m0_1985.low, m0High: valuation.m0_1985.high, epsSharePrice: range('epsSharePrice'), pe_lp_yr: range('pe_lp_yr'), eps_lp_yr: range('eps_lp_yr') } };
  // P/E log changes telescope except where adjacent segments switch anchor tiers; the remainder is the splice gap.
  const lpTotal = 100 * Math.log(full.M_end / full.M_start) - rows.reduce((s, r) => s + 100 * Math.log(r.M_end / r.M_start), 0);
  return { rows, spliceRow: { label: '口径拼接差', lp_total: lpTotal, lp_yr: lpTotal / full.years }, full, breakEven: be };
}
