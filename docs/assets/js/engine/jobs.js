// Job dispatcher shared by the workers, the CLI and the in-thread fallback (SPEC §2.10).
import { engineError, resolveJob, toPlain } from './params.js?v=20260912';
import { buildSample, latestMonth } from './series.js?v=20260912';
import { impliedIntercept, solveFrontier, tangencyPath } from './frontier.js?v=20260912';
import { RULES, askedPortfolios, defaultCustomWeights, makeCtx, references } from './rules.js?v=20260912';
import { ternaryLattice } from './surfaces.js?v=20260912';
import { runRobust } from './robust.js?v=20260912';
import { decadeTable, headToHead, regimeTable, relativeWealth, rollingExcess } from './compare.js?v=20260912';
import { anchorDecomposition } from './decomp.js?v=20260912';

export { latestMonth, resolveJob, toPlain };
export const KINDS = ['context', 'sample', 'alloc', 'robust'];

function allocTangencyPath(ctx, rules, params) {
  const { muUsed, cov, rfAnn, y10 } = ctx, muMax = Math.max(...muUsed);
  const custom = params.tangency.intercept === 'custom' ? params.tangency.interceptC : null;
  const cMin = Math.min(...[rfAnn, y10, rules.tangency.implied?.c, custom].filter(Number.isFinite)) - 0.01;
  const allNdx = impliedIntercept(muUsed, cov, [1, 0, 0]); // 100% NDX is a tangency for c ≥ cLow
  const cMax = Math.max(cMin, Math.min(muMax - 1e-6, (allNdx?.cLow ?? muMax) + 0.01));
  return tangencyPath(muUsed, cov, { cMin, cMax });
}

const RUNNERS = {
  context(job, { history, valuation }) {
    const { basis, ndxDiv, wht } = job.sample, opts = { basis, ndxDiv, wht };
    return {
      rolling: rollingExcess(history, opts, job.rolling), regimes: regimeTable(history, opts), decades: decadeTable(history, opts),
      decomp: anchorDecomposition(history, valuation, { ndxDiv, wht, m0: job.m0 }), coverage: history.coverage ?? null,
    };
  },
  sample(job, { history }) {
    const s = buildSample(history, job.sample), ctx = makeCtx(s), m = ctx.moments;
    const { start, end, basis, ndxDiv, wht, n, years, estimated, warnings, months, R, rf, dgs10 } = s;
    return {
      sample: { start, end, basis, ndxDiv, wht, n, years, estimated, warnings, months, R, rf, dgs10 },
      h2h: headToHead(history, job.sample, { seed: 20260912 }), relativeWealth: relativeWealth(s), moments: m,
      frontier: solveFrontier(m.mu, m.cov), references: references(s, ctx), lattice: ternaryLattice(s),
    };
  },
  alloc(job, { history }) {
    const s = buildSample(history, job.sample), ctx = makeCtx(s, { mu: job.mu }), p = job.params;
    const rules = {
      isoVolTe: RULES.isoVolTe(s, p.isoVolTe, ctx), maxSharpeCagrFloor: RULES.maxSharpeCagrFloor(s, {}, ctx),
      tangency: RULES.tangency(s, p.tangency, ctx), twoAssetNdxUst: RULES.twoAsset(s, { pair: [0, 2] }, ctx),
    };
    rules.twoAsset = p.twoAsset.pair.join('-') === '0-2' ? rules.twoAssetNdxUst : RULES.twoAsset(s, p.twoAsset, ctx);
    rules.custom = RULES.custom(s, { w: p.custom.w ?? defaultCustomWeights(ctx, p.isoVolTe) }, ctx);
    return {
      ctx: { mu: job.mu, muUsed: ctx.muUsed, sigmaSpx: ctx.sigmaSpx, rfAnn: ctx.rfAnn, y10: ctx.y10 },
      rules, active: job.rule.id, asked: askedPortfolios({ rules, references: references(s, ctx) }),
      tangencyPath: allocTangencyPath(ctx, rules, p),
      // frontier under the μ actually used (null = same as the sample bundle's historical frontier)
      frontier: job.mu === 'hist' ? null : solveFrontier(ctx.muUsed, ctx.cov),
    };
  },
  robust(job, { history }, onProgress) {
    return runRobust(history, job, { onProgress });
  },
};

// msg = {kind, state}; data = {history, valuation}. Progress (robust only) goes to hooks.onProgress({stage, done, total})
// or, when hooks is a function (in-thread fallback), to hooks({type:'progress', stage, done, total}).
export function handle(msg, data, hooks = {}) {
  const run = RUNNERS[msg?.kind];
  if (!run) throw engineError('E_BAD_RANGE', `未知计算任务：${msg?.kind}`);
  const onProgress = typeof hooks === 'function' ? p => hooks({ type: 'progress', ...p }) : hooks?.onProgress;
  const job = resolveJob(msg.state ?? {}, { latest: latestMonth(data.history) });
  return { key: job.keys[msg.kind], ...run(job, data, onProgress) };
}

// Worker protocol glue (init → ready; job → result | error | progress). `kinds` limits what this worker accepts.
export function serveWorker(scope, kinds = KINDS) {
  let data = null;
  scope.onmessage = ({ data: msg }) => {
    if (msg?.type === 'init') {
      data = { history: msg.history, valuation: msg.valuation };
      scope.postMessage({ type: 'ready', latest: latestMonth(data.history) });
      return;
    }
    if (msg?.type !== 'job') return;
    const { id, kind, state } = msg;
    try {
      if (!data) throw engineError('E_NULL_DATA', '数据尚未载入');
      if (!kinds.includes(kind)) throw engineError('E_BAD_RANGE', `此线程不处理 ${kind} 任务`);
      const onProgress = p => scope.postMessage({ type: 'progress', id, kind, ...p });
      const result = handle({ kind, state }, data, { onProgress });
      scope.postMessage({ type: 'result', id, kind, key: result.key, result });
    } catch (e) {
      scope.postMessage({ type: 'error', id, kind, code: e.code ?? 'E_INTERNAL', message: e.message });
    }
  };
}
