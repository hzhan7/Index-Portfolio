// NDX vs SPX: head-to-head on the user sample; rolling excess and period tables on the full data range (SPEC §2.7).
import { buildSample, firstMonth, latestMonth, monthDiff } from './series.js?v=20260912';
import { pathStats, olsAlphaBeta, volMatched, sharpeDiffCI, quantile7 } from './stats.js?v=20260912';
import { regimePeriods, decadePeriods } from './periods.js?v=20260912';

export const SHORT_MONTHS = 36;
export const LOSING_RUN_MAX_GAP = 12;
const DIFF_KEYS = ['cagr', 'sharpe', 'vol', 'mdd', 'worst12m'];
const sub = (a, b) => (a == null || b == null ? null : a - b);

function assetStats(sample, i) {
  const { wealth, ...stats } = pathStats(sample.R[i], sample.rf, { startMonth: sample.start, months: sample.months });
  return stats;
}

export function headToHead(historyDoc, sampleOpts, { seed = 20260912 } = {}) {
  const sample = buildSample(historyDoc, sampleOpts);
  const { R, rf, n } = sample;
  const ndx = assetStats(sample, 0), spx = assetStats(sample, 1);
  const vm = volMatched(sample);
  const excess = i => Float64Array.from({ length: n }, (_, t) => R[i][t] - rf[t]);
  const out = {
    ndx, spx,
    diff: Object.fromEntries(DIFF_KEYS.map(k => [k, sub(ndx[k], spx[k])])),
    volMatched: { a: vm.a, levered: vm.levered, ndxCagr: vm.stats.cagr, spxCagr: spx.cagr, spread: vm.stats.cagr - spx.cagr, ndxMdd: vm.stats.mdd },
    alphaBeta: olsAlphaBeta(excess(0), excess(1)),
    sharpeDiffCI: sharpeDiffCI(sample, 0, 1, { seed }),
    priceBasis: null, divContribution: null, estimateImpact: null,
  };
  if (sample.basis !== 'tr') return out;

  const pr = buildSample(historyDoc, { ...sampleOpts, basis: 'pr' });
  const pn = assetStats(pr, 0), ps = assetStats(pr, 1);
  out.priceBasis = { ndxSharpe: pn.sharpe, spxSharpe: ps.sharpe, ndxCagr: pn.cagr, spxCagr: ps.cagr };
  out.divContribution = { ndx: ndx.cagr - pn.cagr, spx: spx.cagr - ps.cagr };
  if (sample.estimated?.ndxDiv) {
    const band = ndxDiv => {
      const s = buildSample(historyDoc, { ...sampleOpts, ndxDiv });
      const a = assetStats(s, 0), b = assetStats(s, 1);
      return { ndxCagr: a.cagr, ndxSharpe: a.sharpe, sharpeDiff: sub(a.sharpe, b.sharpe) };
    };
    const lo = band('low'), hi = band('high');
    out.estimateImpact = Object.fromEntries(Object.keys(lo).map(k => [k, [lo[k], hi[k]]]));
  }
  return out;
}

/** NDX wealth ÷ SPX wealth; index 0 is the sample start (= 1). */
export function relativeWealth(sample) {
  const ratio = new Float64Array(sample.n + 1);
  let wn = 1, ws = 1;
  ratio[0] = 1;
  for (let t = 0; t < sample.n; t++) {
    wn *= 1 + sample.R[0][t];
    ws *= 1 + sample.R[1][t];
    ratio[t + 1] = wn / ws;
  }
  return { months: [sample.start, ...sample.months], ratio, endRatio: ratio[sample.n] };
}

/** Losing start months (excess ≤ 0) as runs; runs separated by ≤ maxGap non-losing months merge. Sorted by n desc. */
export function losingRuns(starts, excess, maxGap = LOSING_RUN_MAX_GAP) {
  const runs = [];
  for (let k = 0; k < starts.length; k++) {
    if (excess[k] > 0) continue;
    const last = runs.at(-1);
    if (last && monthDiff(last.to, starts[k]) - 1 <= maxGap) { last.to = starts[k]; last.n++; }
    else runs.push({ from: starts[k], to: starts[k], n: 1 });
  }
  return runs.sort((a, b) => b.n - a.n);
}

/** Rolling `years`-year CAGR excess NDX − SPX for every start month of the full data range (current basis/ndxDiv/wht). */
export function rollingExcess(historyDoc, opts, { years = 10, volMatched: vmMode = false } = {}) {
  const s = buildSample(historyDoc, { start: firstMonth(historyDoc), end: latestMonth(historyDoc), basis: opts.basis, ndxDiv: opts.ndxDiv, wht: opts.wht });
  const { R, rf, n, months } = s;
  const L = 12 * years, m = Math.max(0, n - L + 1);
  const start = new Array(m), end = new Array(m), plain = new Float64Array(m), matched = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    let gN = 0, gS = 0, eN = 0, eS = 0, eN2 = 0, eS2 = 0;
    for (let t = k; t < k + L; t++) {
      gN += Math.log1p(R[0][t]);
      gS += Math.log1p(R[1][t]);
      const xn = R[0][t] - rf[t], xs = R[1][t] - rf[t];
      eN += xn; eS += xs; eN2 += xn * xn; eS2 += xs * xs;
    }
    // vol-matched NDX inside the window: a·NDX + (1−a)·cash, a = std(SPX excess) / std(NDX excess)
    const a = Math.sqrt((eS2 - eS * eS / L) / (eN2 - eN * eN / L));
    let gV = 0;
    for (let t = k; t < k + L; t++) gV += Math.log1p(a * R[0][t] + (1 - a) * rf[t]);
    const cagrS = Math.expm1(12 * gS / L);
    plain[k] = Math.expm1(12 * gN / L) - cagrS;
    matched[k] = Math.expm1(12 * gV / L) - cagrS;
    start[k] = k === 0 ? s.start : months[k - 1];
    end[k] = months[k + L - 1];
  }
  const excess = vmMode ? matched : plain;
  const base = { years, volMatched: vmMode, points: { start, end, excess }, n: m };
  if (!m) return { ...base, nWin: 0, winRate: null, median: null, p10: null, p90: null, worst: null, nLose: 0, losingRuns: [], vmWinRate: null };
  let worst = 0, nWin = 0, vmWin = 0;
  for (let k = 0; k < m; k++) {
    if (excess[k] < excess[worst]) worst = k;
    if (excess[k] > 0) nWin++;
    if (matched[k] > 0) vmWin++;
  }
  return { ...base, nWin, winRate: nWin / m, median: quantile7(excess, 0.5), p10: quantile7(excess, 0.1), p90: quantile7(excess, 0.9),
    worst: { start: start[worst], end: end[worst], excess: excess[worst] }, nLose: m - nWin, losingRuns: losingRuns(start, excess), vmWinRate: vmWin / m };
}

function periodRow(historyDoc, opts, { id, label, from, to }) {
  const s = buildSample(historyDoc, { start: from, end: to, basis: opts.basis, ndxDiv: opts.ndxDiv, wht: opts.wht, minMonths: 1 });
  const short = s.n < SHORT_MONTHS;
  const side = i => {
    const st = pathStats(s.R[i], s.rf, { startMonth: s.start, months: s.months });
    return { cagr: st.cagr, cumReturn: st.cumReturn, sharpe: short ? null : st.sharpe, mdd: st.mdd };
  };
  const ndx = side(0), spx = side(1);
  return { id, label, from, to, n: s.n, short, ndx, spx, spreadCagr: ndx.cagr - spx.cagr };
}

export const regimeTable = (historyDoc, opts) => regimePeriods(latestMonth(historyDoc)).map(p => periodRow(historyDoc, opts, p));
export const decadeTable = (historyDoc, opts) => decadePeriods(latestMonth(historyDoc)).map(p => periodRow(historyDoc, opts, p));
