// Robustness: seeded block bootstrap of rule weights and annual walk-forward re-estimation (SPEC §2.9).
import { engineError } from './params.js?v=20260912';
import { buildSample, firstMonth, sliceSample } from './series.js?v=20260912';
import { blockIndices, drawSeed, effectiveBlock, mulberry32, pathStats, quantile7 } from './stats.js?v=20260912';
import { kinkedCal, tangency as tangencyPoint } from './frontier.js?v=20260912';
import { calendarReturn, defaultCustomWeights, makeCtx, resolveIntercept, solveIsoVolTe, solveMaxSharpeCagrFloor } from './rules.js?v=20260912';

export const BOOTSTRAP_B = { isoVolTe: 1000, tangency: 1000, maxSharpeCagrFloor: 200 };

// Which portfolio a rule's robustness results describe. Tangency: the kinked CAL levered to volMult·σ_SPX (borrow at
// rf + spread), i.e. the 「切点×杠杆到标普波动」 row, in both the walk-forward and the bootstrap. Every other rule is unlevered.
export const robustVariant = ruleId => (ruleId === 'tangency' ? 'levered' : 'unlevered');

// Rule weights on an estimation sample. Tangency: unlevered at the resolved intercept, or the kinked CAL when levered.
export function ruleWeights(ruleId, sample, params = {}, ctxOpts = {}, { levered = false } = {}) {
  if (ruleId === 'custom') return { w: params.w };
  if (ruleId === 'maxSharpeCagrFloor') { const s = solveMaxSharpeCagrFloor(sample); return s ? { w: s.w } : null; }
  const ctx = makeCtx(sample, ctxOpts, { lite: true });
  if (ruleId === 'isoVolTe') {
    const w = solveIsoVolTe(ctx.muUsed, ctx.cov, params.volMult ?? 1, params.teCap === undefined ? 0.05 : params.teCap);
    return w ? { w } : null;
  }
  if (ruleId === 'tangency') {
    const { spread = 0.005, volMult = 1 } = params;
    if (levered) {
      const k = kinkedCal(ctx.muUsed, ctx.cov, { rfAnn: ctx.rfAnn, spread, targetVol: volMult * ctx.sigmaSpx });
      return k.w ? { w: k.w, L: k.L, notional: k.notional } : null;
    }
    const { c } = resolveIntercept(ctx, params), t = c == null ? null : tangencyPoint(ctx.muUsed, ctx.cov, c);
    return t?.status === 'ok' ? { w: t.w } : null;
  }
  throw engineError('E_BAD_RANGE', `规则 ${ruleId} 不支持重抽样或样本外检验`);
}

// Ls (levered variant only): leverage per draw, NaN when infeasible. Probabilities are over feasible draws.
export function summarizeDraws(W, from, to, Ls = null) {
  const ok = [];
  for (let b = from; b < to; b++) if (!Number.isNaN(W[3 * b])) ok.push(b);
  const col = a => ok.map(b => W[3 * b + a]);
  const q = p => [0, 1, 2].map(a => (ok.length ? quantile7(col(a), p) : null));
  const frac = pred => (ok.length ? ok.filter(pred).length / ok.length : null);
  const out = {
    nFeasible: ok.length,
    weights: { p10: q(0.1), p50: q(0.5), p90: q(0.9), mean: [0, 1, 2].map(a => (ok.length ? col(a).reduce((s, x) => s + x, 0) / ok.length : null)) },
    probUstOver50: frac(b => W[3 * b + 2] > 0.5), probSpxUnder1: frac(b => W[3 * b + 1] < 0.01),
    probCorner: frac(b => Math.max(W[3 * b], W[3 * b + 1], W[3 * b + 2]) >= 0.99), probInfeasible: (to - from - ok.length) / (to - from),
  };
  if (!Ls) return out;
  const lq = p => (ok.length ? quantile7(ok.map(b => Ls[b]), p) : null);
  const nq = p => [0, 1, 2].map(a => (ok.length ? quantile7(ok.map(b => Ls[b] * W[3 * b + a]), p) : null));
  return { ...out, leverage: { p10: lq(0.1), p50: lq(0.5), p90: lq(0.9) }, notional: { p10: nq(0.1), p50: nq(0.5), p90: nq(0.9) } };
}

// Draw b always uses mulberry32(drawSeed(seed, b)), so any [from, to) chunking reproduces the same draws.
// `block` in the result is the effective block length (capped at ⌊n/4⌋). Tangency draws are the levered kinked CAL:
// `draws` hold its risky weights and `drawsL` its leverage; `weights` quantiles are risky weights, `notional` = L·w.
export function bootstrapRule(sample, ruleId, params = {}, ctxOpts = {}, { B = BOOTSTRAP_B[ruleId] ?? 1000, block = 24, seed = 20260912, from = 0, to = B, onProgress } = {}) {
  const { n } = sample, blk = effectiveBlock(n, block), variant = robustVariant(ruleId), levered = variant === 'levered';
  const idx = new Int32Array(n), W = new Float64Array(B * 3).fill(NaN), Ls = levered ? new Float64Array(B).fill(NaN) : null;
  const rs = { start: sample.start, months: null, basis: sample.basis, dgs10End: sample.dgs10End, n, R: [0, 1, 2].map(() => new Float64Array(n)), rf: new Float64Array(n) };
  for (let b = from; b < to; b++) {
    blockIndices(n, blk, mulberry32(drawSeed(seed, b)), idx);
    for (let t = 0; t < n; t++) { const s = idx[t]; rs.R[0][t] = sample.R[0][s]; rs.R[1][t] = sample.R[1][s]; rs.R[2][t] = sample.R[2][s]; rs.rf[t] = sample.rf[s]; }
    const res = ruleWeights(ruleId, rs, params, ctxOpts, { levered });
    if (res) { W.set(res.w, 3 * b); if (Ls) Ls[b] = res.L; }
    if (onProgress && ((b - from + 1) % 25 === 0 || b === to - 1)) onProgress(b - from + 1, to - from);
  }
  return { rule: ruleId, variant, params, B, block: blk, seed, from, to, ...summarizeDraws(W, from, to, Ls), draws: Float32Array.from(W),
    ...(Ls ? { drawsL: Float32Array.from(Ls) } : {}) };
}

const statsOf = (r, s) => { const { wealth, ...rest } = pathStats(r, s.rf, { startMonth: s.start, months: s.months }); return { wealth, stats: rest }; };

function heldReturns(s, w, L = null, spread = 0) {
  const out = new Float64Array(s.n);
  for (let t = 0; t < s.n; t++) {
    const r = w[0] * s.R[0][t] + w[1] * s.R[1][t] + w[2] * s.R[2][t];
    out[t] = L == null ? r : L * r - (L - 1) * s.rf[t] - (Math.max(L - 1, 0) * spread) / 12;
  }
  return out;
}

export function walkForward(doc, sampleOpts, ruleId, params = {}, ctxOpts = {}, { window = 'trailing', lookbackYears = 10 } = {}) {
  const user = buildSample(doc, sampleOpts);
  const full = buildSample(doc, { ...sampleOpts, start: firstMonth(doc), end: user.end, minMonths: 1 });
  const variant = robustVariant(ruleId), levered = variant === 'levered';
  const fidx = new Map(full.months.map((m, i) => [m, i])), L = 12 * lookbackYears;
  const taus = [user.months[0], ...user.months.slice(1).filter(m => m.endsWith('-01'))];
  const weights = [];
  for (const tau of taus) {
    const f = fidx.get(tau);
    if (f < L) continue;
    const lo = window === 'trailing' ? f - L : 0; // estimation uses return months strictly before τ
    const res = ruleWeights(ruleId, sliceSample(full, lo, f), params, ctxOpts, { levered });
    weights.push({ month: tau, w: res?.w ?? [0, 1, 0], ...(res?.notional ? { L: res.L, notional: res.notional } : {}),
      estFrom: full.months[lo], estTo: full.months[f - 1], infeasible: !res });
  }
  const base = { window, lookbackYears, rule: ruleId, variant, params };
  if (!weights.length) return { ...base, status: 'insufficient', reason: '样本外不足36个月', firstOos: null, months: 0, oosMonths: [], series: null,
    relToSpx: null, stats: null, weights, inSampleStatic: null, ustOver50Years: 0, y2022: null };
  const oos = sliceSample(user, user.months.indexOf(weights[0].month), user.n), m = oos.n;
  const rule = new Float64Array(m);
  for (let t = 0, k = 0; t < m; t++) {
    while (k + 1 < weights.length && weights[k + 1].month <= oos.months[t]) k++;
    const e = weights[k], r = e.w[0] * oos.R[0][t] + e.w[1] * oos.R[1][t] + e.w[2] * oos.R[2][t];
    rule[t] = e.L == null ? r : e.L * r - (e.L - 1) * oos.rf[t] - (Math.max(e.L - 1, 0) * (params.spread ?? 0.005)) / 12;
  }
  // reference paths on the same OOS months (fixed weights, monthly rebalanced)
  const paths = { rule, spx: oos.R[1], ndx: oos.R[0], sixty40: heldReturns(oos, [0, 0.6, 0.4]), ndxSpx5050: heldReturns(oos, [0.5, 0.5, 0]) };
  const series = {}, stats = {};
  for (const [id, r] of Object.entries(paths)) ({ wealth: series[id], stats: stats[id] } = statsOf(r, oos));
  const relToSpx = series.rule.map((x, k) => x / series.spx[k]);
  const st = ruleWeights(ruleId, oos, params, ctxOpts, { levered });
  const inSampleStatic = st ? { w: st.w, ...(st.notional ? { L: st.L, notional: st.notional } : {}),
    stats: statsOf(heldReturns(oos, st.w, st.L ?? null, params.spread ?? 0.005), oos).stats } : null;
  const y22 = calendarReturn(oos.months, rule, '2022');
  // months = OOS return-month count; oosMonths = those months (series[k + 1] is wealth at the end of oosMonths[k])
  return { ...base, status: m >= 36 ? 'ok' : 'insufficient', reason: m >= 36 ? null : '样本外不足36个月', firstOos: oos.months[0], months: m,
    oosMonths: oos.months, series, relToSpx, stats, weights, inSampleStatic, ustOver50Years: weights.filter(e => e.w[2] > 0.5).length,
    infeasibleWindows: weights.filter(e => e.infeasible).length, // those windows hold 100% SPX
    y2022: y22 == null ? null : { rule: y22, spx: calendarReturn(oos.months, oos.R[1], '2022') } };
}

export function robustPlan(job) {
  const { params } = job, active = job.rule.id;
  const stages = [
    { id: 'wf:isoVolTe', type: 'walkForward', ruleId: 'isoVolTe', params: params.isoVolTe },
    { id: 'wf:maxSharpeCagrFloor', type: 'walkForward', ruleId: 'maxSharpeCagrFloor', params: {} },
    { id: 'wf:tangency', type: 'walkForward', ruleId: 'tangency', params: params.tangency },
    { id: 'bs:isoVolTe', type: 'bootstrap', ruleId: 'isoVolTe', params: params.isoVolTe, B: BOOTSTRAP_B.isoVolTe },
  ];
  if (active === 'maxSharpeCagrFloor' || active === 'tangency')
    stages.push({ id: `bs:${active}`, type: 'bootstrap', ruleId: active, params: params[active], B: BOOTSTRAP_B[active] });
  if (active === 'custom') stages.push({ id: 'wf:custom', type: 'walkForward', ruleId: 'custom', params: params.custom });
  return stages;
}

// onProgress({stage, done, total}) per stage start/end and every 25 bootstrap draws.
export function runRobust(doc, job, { onProgress = () => {} } = {}) {
  const ctxOpts = { mu: job.mu }, byRule = {}, stages = robustPlan(job);
  let user = null;
  const sample = () => (user ??= buildSample(doc, job.sample));
  for (const st of stages) {
    const total = st.B ?? 1;
    onProgress({ stage: st.id, done: 0, total });
    const params = st.ruleId === 'custom' && !st.params.w ? { w: defaultCustomWeights(makeCtx(sample(), ctxOpts, { lite: true }), job.params.isoVolTe) } : st.params;
    const slot = (byRule[st.ruleId] ??= {});
    if (st.type === 'walkForward') slot.walkForward = walkForward(doc, job.sample, st.ruleId, params, ctxOpts, job.wf);
    else slot.bootstrap = bootstrapRule(sample(), st.ruleId, params, ctxOpts, { B: st.B, onProgress: (done, t) => onProgress({ stage: st.id, done, total: t }) });
    onProgress({ stage: st.id, done: total, total });
  }
  return { byRule, active: job.rule.id, stages: stages.map(s => s.id) };
}
