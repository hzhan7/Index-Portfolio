import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KINDS, handle, latestMonth, resolveJob, serveWorker, toPlain } from '../docs/assets/js/engine/jobs.js?v=20260912';
import { buildSample } from '../docs/assets/js/engine/series.js?v=20260912';
import { pathStats } from '../docs/assets/js/engine/stats.js?v=20260912';
import { defaultCustomWeights, makeCtx } from '../docs/assets/js/engine/rules.js?v=20260912';
import { ternaryLattice } from '../docs/assets/js/engine/surfaces.js?v=20260912';
import { stateFromQuery } from '../scripts/compute.mjs';

const read = f => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url)));
const data = { history: read('docs/data/history.json'), valuation: read('docs/data/valuation.json') };
const latest = latestMonth(data.history);
const code = c => err => err.code === c;

function assertNoFunctions(x, path = 'result') {
  assert.notEqual(typeof x, 'function', `${path} is a function`);
  if (x && typeof x === 'object' && !ArrayBuffer.isView(x)) for (const [k, v] of Object.entries(x)) assertNoFunctions(v, `${path}.${k}`);
}

const STATES = { default: {}, infeasible: { volMult: 0.7, teCap: 0.02 }, tangencyCustom7: { rule: 'tangency', intercept: 'custom', interceptC: 0.07 },
  prBasis: { basis: 'pr' }, short2016: { start: '2016-08' }, twoAsset01: { rule: 'twoAsset', pair: [0, 1] }, y10bond: { mu: 'y10bond', rule: 'custom' },
  crisis: { start: '2009-02', ndxDiv: 'low', wht: 0.3 } };
const ROBUST = new Set(['default', 'infeasible', 'short2016']);

for (const [name, state] of Object.entries(STATES)) {
  test(`jobs (${name}): every kind echoes its key and is structured-clone / JSON safe`, () => {
    const keys = resolveJob(state, { latest }).keys;
    for (const kind of KINDS) {
      if (kind === 'robust' && !ROBUST.has(name)) continue;
      const result = handle({ kind, state }, data);
      assert.equal(result.key, keys[kind], `${kind} key`);
      assertNoFunctions(result);
      assert.doesNotThrow(() => structuredClone(result), `${kind} structuredClone`);
      const json = JSON.stringify(toPlain(result));
      assert.ok(!json.includes('"0":'), `${kind} typed array leaked into JSON`);
    }
  });
}

test('bundle contents: sample, alloc and context carry what the UI reads', () => {
  const sample = handle({ kind: 'sample', state: {} }, data);
  assert.equal(sample.sample.months.length, sample.sample.n);
  assert.equal(sample.sample.R.length, 3);
  assert.equal(sample.lattice.n, 5151);
  assert.deepEqual(sample.references.map(r => r.id), ['spx', 'ndx', 'sixty40', 'ndxSpx5050']);
  const alloc = handle({ kind: 'alloc', state: { rule: 'twoAsset', pair: [0, 1] } }, data);
  assert.deepEqual(Object.keys(alloc.rules).sort(), ['custom', 'isoVolTe', 'maxSharpeCagrFloor', 'tangency', 'twoAsset', 'twoAssetNdxUst']);
  assert.equal(alloc.active, 'twoAsset');
  assert.deepEqual(alloc.rules.twoAsset.params.pair, [0, 1]);
  assert.deepEqual(alloc.rules.twoAssetNdxUst.params.pair, [0, 2]);
  assert.equal(alloc.asked.length, 9);
  assert.ok(alloc.tangencyPath.points.length > 10);
  const T = alloc.rules.tangency;
  assert.deepEqual([T.atRf.status, T.atRf.c], ['ok', alloc.ctx.rfAnn]);
  assert.deepEqual([T.atY10.status, T.atY10.c], ['ok', alloc.ctx.y10]);
  assert.ok(T.atY10.w && ['mu', 'vol', 'te'].every(k => Number.isFinite(T.atY10.model[k])) && T.atY10.stats && T.atY10.vsSpx);
  assert.ok(['borrow', 'lend', 'frontier'].includes(T.levered.cUsedKind) && Number.isFinite(T.levered.cUsed));
  assert.deepEqual(alloc.rules.custom.w, defaultCustomWeights(makeCtx(buildSample(data.history, { start: '1985-01' })), { volMult: 1, teCap: 0.05 }));
  assert.equal(alloc.frontier, null);
  assert.ok(handle({ kind: 'alloc', state: { mu: 'y10bond' } }, data).frontier.frontier.length > 1);
  for (const basis of ['tr', 'pr']) {
    const ctx = handle({ kind: 'context', state: { basis } }, data);
    assert.ok(ctx.regimes.length >= 9 && ctx.decades.length >= 5 && ctx.rolling && ctx.decomp && ctx.coverage);
  }
  assert.throws(() => handle({ kind: 'alloc', state: { basis: 'pr', mu: 'y10bond' } }, data), code('E_Y10_REQUIRES_TR'));
  assert.throws(() => handle({ kind: 'nope', state: {} }, data), code('E_BAD_RANGE'));
});

test('in-thread fallback: a function hook receives robust progress messages', () => {
  const messages = [];
  const result = handle({ type: 'job', id: 3, kind: 'robust', state: { start: '2016-08' } }, data, m => messages.push(m));
  assert.ok(messages.length > 4 && messages.every(m => m.type === 'progress' && typeof m.stage === 'string'));
  assert.ok(result.byRule.isoVolTe.walkForward && result.byRule.isoVolTe.bootstrap);
  for (const [id, { walkForward: wf }] of Object.entries(result.byRule)) {
    assert.ok(Array.isArray(wf.oosMonths) && wf.oosMonths.length === wf.months && wf.oosMonths[0] === wf.firstOos, `${id} oosMonths`);
    assert.equal(wf.variant, id === 'tangency' ? 'levered' : 'unlevered', `${id} variant`);
    if (wf.status === 'ok') assert.ok(wf.stats.ndxSpx5050 && wf.series.ndxSpx5050.length === wf.months + 1, `${id} ndxSpx5050`);
  }
});

test('worker glue: init → ready, job → result, errors carry codes, kinds are restricted per worker', () => {
  const out = [], scope = { postMessage: m => out.push(structuredClone(m)) };
  serveWorker(scope, ['context', 'sample', 'alloc']);
  scope.onmessage({ data: { type: 'job', id: 1, kind: 'alloc', state: {} } });
  assert.equal(out.at(-1).code, 'E_NULL_DATA');
  scope.onmessage({ data: { type: 'init', ...data } });
  assert.deepEqual(out.at(-1), { type: 'ready', latest });
  scope.onmessage({ data: { type: 'job', id: 2, kind: 'alloc', state: {} } });
  assert.equal(out.at(-1).type, 'result'); assert.equal(out.at(-1).id, 2); assert.equal(out.at(-1).key, resolveJob({}, { latest }).keys.alloc);
  scope.onmessage({ data: { type: 'job', id: 3, kind: 'robust', state: {} } });
  assert.deepEqual([out.at(-1).type, out.at(-1).code], ['error', 'E_BAD_RANGE']);
  scope.onmessage({ data: { type: 'job', id: 4, kind: 'sample', state: { start: '2026-01' } } });
  assert.deepEqual([out.at(-1).type, out.at(-1).code, out.at(-1).id], ['error', 'E_SHORT_SAMPLE', 4]);
});

test('compute.mjs parses the SPEC §2.1 URL table into engine state', () => {
  assert.deepEqual(stateFromQuery(''), {});
  assert.deepEqual(stateFromQuery('vm=0.7&te=2'), { volMult: 0.7, teCap: 0.02 });
  assert.deepEqual(stateFromQuery('?r=tangency&ic=custom&cc=7'), { rule: 'tangency', intercept: 'custom', interceptC: 0.07 });
  assert.deepEqual(stateFromQuery('te=none&v=2026-08'), { teCap: null });
  const s = stateFromQuery('s=2016-08&b=pr&d=low&t=30&sp=0.5&pr=0-1&w=40,40,20&rv=1&rw=5&wf=expanding&pe=2.1&mu=hist&fl=1&tm=cagr');
  const job = resolveJob(s, { latest });
  assert.deepEqual(job.sample, { start: '2016-08', end: latest, basis: 'pr', ndxDiv: 'low', wht: 0.3 });
  assert.deepEqual([job.params.tangency.spread, job.params.twoAsset.pair, job.params.custom.w, job.rolling, job.wf.window, job.m0],
    [0.005, [0, 1], [0.4, 0.4, 0.2], { years: 5, volMatched: true }, 'expanding', 2.1]);
  assert.throws(() => stateFromQuery('zz=1'));
  // unparseable numbers used to run silently (vm=abc ignored the vol cap; rw=abc threw a bare RangeError)
  for (const q of ['vm=abc', 'te=abc', 'rw=abc', 'rw=7', 'wf=bogus', 'pe=0', 'sp=abc', 'cc=abc', 't=abc', 'mu=nope']) {
    for (const kind of ['context', 'alloc']) assert.throws(() => handle({ kind, state: stateFromQuery(q) }, data), code('E_BAD_RANGE'), `${q} ${kind}`);
  }
});

test('ternary lattice: 5151 points in < 100 ms, vertices equal single-asset path stats', () => {
  const s = buildSample(data.history, { start: '1985-01' });
  ternaryLattice(s);
  const t0 = performance.now(), L = ternaryLattice(s), ms = performance.now() - t0;
  assert.ok(ms < 100, `lattice ${ms} ms`);
  assert.equal(L.n, 5151);
  for (let k = 0; k < L.n; k++) assert.ok(L.i[k] + L.j[k] <= 100);
  const spxK = Array.from(L.i).findIndex((x, k) => x === 0 && L.j[k] === 100), spx = pathStats(s.R[1], s.rf);
  assert.ok(Math.abs(L.cagr[spxK] - spx.cagr) < 1e-6 && Math.abs(L.sharpe[spxK] - spx.sharpe) < 1e-6 && Math.abs(L.mdd[spxK] - spx.mdd) < 1e-6);
  assert.equal(L.spx.cagr, spx.cagr);
  assert.equal(ternaryLattice(s, { step: 0.05 }).n, 231);
});
