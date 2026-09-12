import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATE } from '../docs/assets/js/engine/params.js?v=20260912';
import {
  PRESETS, URL_KEYS, activePresetId, monthsBetween, normaliseState, parseUrl, presetRange, rangeProblem,
  serialise, warningMessages,
} from '../docs/assets/js/ui/state.js?v=20260912';
import { createCompute } from '../docs/assets/js/ui/workers.js?v=20260912';

const latest = '2026-08';
const opts = { latest };
const make = (patch) => ({ ...DEFAULT_STATE, ...patch });

test('URL keys follow the §2.1 table', () => {
  assert.deepEqual(URL_KEYS, {
    start: 's', end: 'e', basis: 'b', ndxDiv: 'd', wht: 't', rule: 'r', volMult: 'vm', teCap: 'te', intercept: 'ic',
    interceptC: 'cc', spread: 'sp', pair: 'pr', customW: 'w', fill: 'fl', mu: 'mu', roll: 'rw', rollVm: 'rv',
    wfWindow: 'wf', m0: 'pe', ternaryMetric: 'tm',
  });
});

test('serialise omits defaults', () => {
  assert.equal(serialise(DEFAULT_STATE, opts), '');
  assert.equal(serialise(make({ end: latest }), opts), '');
  assert.equal(serialise(DEFAULT_STATE, { latest, vintage: true }), '?v=2026-08');
  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    assert.equal(serialise(make({ [key]: structuredClone(value) }), opts), '', key);
  }
  assert.deepEqual(parseUrl('', opts), { state: DEFAULT_STATE, warnings: [] });
});

const ROUND_TRIPS = [
  [{ start: '1999-03' }, '?s=1999-03'],
  [{ start: '2009-02', end: '2020-12', basis: 'pr' }, '?s=2009-02&e=2020-12&b=pr'],
  [{ ndxDiv: 'low', wht: 0.15 }, '?d=low&t=15'],
  [{ rule: 'tangency', intercept: 'custom', interceptC: 0.07, spread: 0.01 }, '?r=tangency&ic=custom&cc=7&sp=1'],
  [{ volMult: 0.7, teCap: 0.02 }, '?vm=0.7&te=2'],
  [{ volMult: 1.15, teCap: null, intercept: 'y10', spread: 0 }, '?vm=1.15&te=none&ic=y10&sp=0'],
  [{ rule: 'twoAsset', pair: [0, 1] }, '?r=twoAsset&pr=0-1'],
  [{ rule: 'custom', customW: [0.39, 0.44, 0.17], fill: 0 }, '?r=custom&w=39,44,17&fl=0'],
  [{ mu: 'y10bond', roll: 20, rollVm: true, wfWindow: 'expanding' }, '?mu=y10bond&rw=20&rv=1&wf=expanding'],
  [{ m0: 1.85, ternaryMetric: 'cagr', ndxDiv: 'high', wht: 0.3, interceptC: 0.0569 }, '?d=high&t=30&cc=5.69&pe=1.85&tm=cagr'],
  [{ rule: 'maxSharpeCagrFloor', pair: [1, 2], teCap: 0.08, roll: 5 }, '?r=maxSharpeCagrFloor&te=8&pr=1-2&rw=5'],
];

test('URL round-trip restores non-default states exactly', () => {
  for (const [patch, query] of ROUND_TRIPS) {
    const state = make(patch);
    assert.equal(serialise(state, opts), query);
    const parsed = parseUrl(query, opts);
    assert.deepEqual(parsed.warnings, [], query);
    assert.deepEqual(parsed.state, state, query);
    const shared = parseUrl(serialise(state, { latest, vintage: true }), opts);
    assert.deepEqual(shared, { state, warnings: [] }, `${query} + v`);
  }
});

test('invalid params fall back to defaults with one warning each', () => {
  const bad = {
    s: '1984-12', e: '2030-01', b: 'xx', d: 'mid', t: '20', r: 'foo', vm: '0.73', te: '7', ic: 'zz', cc: 'abc',
    sp: '2', pr: '0-0', w: '50,50,1', fl: '3', mu: 'custom', rw: '7', rv: '2', wf: 'x', pe: '5', tm: 'vol',
  };
  const { state, warnings } = parseUrl(new URLSearchParams(bad).toString(), opts);
  assert.deepEqual(state, DEFAULT_STATE);
  assert.deepEqual(warnings.map((w) => w.code), Object.keys(bad).map(() => 'W_PARAM'));
  assert.deepEqual(warnings.map((w) => w.key), Object.keys(bad));
  const messages = warningMessages(warnings);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^链接中20个参数无效/);

  const mixed = parseUrl('?s=1999-03&vm=abc&w=a,b,c&unknown=1', opts);
  assert.deepEqual(mixed.state, make({ start: '1999-03' }));
  assert.deepEqual(mixed.warnings.map((w) => w.key), ['vm', 'w']);
});

test('samples shorter than 24 months or reversed revert to the default range', () => {
  for (const query of ['?s=2025-06', '?s=2010-01&e=2005-01', '?s=2020-01&e=2021-12']) {
    const { state, warnings } = parseUrl(query, opts);
    assert.equal(state.start, DEFAULT_STATE.start, query);
    assert.equal(state.end, null, query);
    assert.deepEqual(warnings.map((w) => w.code), ['W_SAMPLE'], query);
  }
  assert.deepEqual(parseUrl('?s=2020-01&e=2022-01', opts).warnings, []);
  assert.equal(parseUrl('?e=2026-08', opts).state.end, null);
  assert.equal(rangeProblem('2020-01', '2021-12', opts), '样本至少24个月');
  assert.equal(rangeProblem('2021-01', '2020-01', opts), '起点须早于终点');
  assert.equal(rangeProblem('2000-01', null, opts), null);
});

test('mu=y10bond on the price basis falls back to hist with a warning', () => {
  const { state, warnings } = parseUrl('?b=pr&mu=y10bond', opts);
  assert.equal(state.basis, 'pr');
  assert.equal(state.mu, 'hist');
  assert.deepEqual(warnings.map((w) => w.code), ['W_Y10_REQUIRES_TR']);
  const fromStore = normaliseState(make({ mu: 'y10bond', basis: 'pr' }), opts);
  assert.equal(fromStore.state.mu, 'hist');
  assert.equal(fromStore.warnings[0].code, 'W_Y10_REQUIRES_TR');
  assert.deepEqual(parseUrl('?mu=y10bond', opts).warnings, []);
});

test('normaliseState canonicalises values set by controls', () => {
  const { state, warnings } = normaliseState(make({ customW: [0.291, 0.57, 0.139], volMult: 0.85000001, end: latest }), opts);
  assert.deepEqual(warnings, []);
  assert.deepEqual(state.customW, [0.29, 0.57, 0.14]);
  assert.equal(state.volMult, 0.85);
  assert.equal(state.end, null);
  const broken = normaliseState(make({ rule: 'nope', wht: 0.2 }), opts);
  assert.equal(broken.state.rule, 'isoVolTe');
  assert.equal(broken.state.wht, 0);
  assert.deepEqual(broken.warnings.map((w) => w.key), ['wht', 'rule']);
});

test('自定义 intercept without a usable value falls back to the default intercept', () => {
  const missing = parseUrl('?r=tangency&ic=custom', opts);
  assert.equal(missing.state.intercept, DEFAULT_STATE.intercept);
  assert.deepEqual(missing.warnings.map((w) => w.code), ['W_STATE']);
  const bad = normaliseState(make({ rule: 'tangency', intercept: 'custom', interceptC: 0.25 }), opts);
  assert.equal(bad.state.intercept, DEFAULT_STATE.intercept);
  assert.equal(bad.state.interceptC, null);
  assert.equal(bad.warnings.length, 1, 'one toast for the rejected intercept');
  const good = normaliseState(make({ intercept: 'custom', interceptC: 0.0425 }), opts);
  assert.deepEqual([good.state.intercept, good.state.interceptC, good.warnings], ['custom', 0.0425, []]);
});

test('data vintage: an older link keeps its end month', () => {
  const older = parseUrl('?s=1999-03&v=2026-05', opts);
  assert.deepEqual(older.state, make({ start: '1999-03', end: '2026-05' }));
  assert.equal(older.warnings[0].code, 'W_VINTAGE');
  assert.match(older.warnings[0].message, /2026-08.*2026-05/);
  assert.equal(parseUrl('?e=2020-12&v=2026-05', opts).state.end, '2020-12');
  assert.deepEqual(parseUrl('?v=2026-08', opts).warnings, []);
  const newer = parseUrl('?v=2026-11', opts);
  assert.equal(newer.state.end, null);
  assert.equal(newer.warnings[0].code, 'W_VINTAGE');
});

test('presets resolve relative to the latest data month', () => {
  assert.deepEqual(PRESETS.map((p) => p.label),
    ['1985-01 全样本', '1999-03 纳指含息实测起点', '2000-03 泡沫顶', '2009-02 危机底', '近20年', '近10年']);
  assert.deepEqual(presetRange('last10', opts), { start: '2016-08', end: null });
  assert.deepEqual(presetRange('last20', opts), { start: '2006-08', end: null });
  assert.deepEqual(presetRange('last10', { latest: '2031-01' }), { start: '2021-01', end: null });
  assert.deepEqual(presetRange('gfcLow', opts), { start: '2009-02', end: null });
  for (const preset of PRESETS) {
    const range = presetRange(preset, opts);
    assert.equal(rangeProblem(range.start, range.end, opts), null, preset.id);
    assert.equal(activePresetId(make(range), opts), preset.id);
  }
  assert.equal(monthsBetween(presetRange('last10', opts).start, latest), 120);
  assert.equal(activePresetId(DEFAULT_STATE, opts), 'full');
  assert.equal(activePresetId(make({ start: '1999-03', end: '2020-12' }), opts), null);
});

// ---- ui/workers.js: latest-wins, robust restart, in-thread fallback (fake workers) ----
const tick = (ms = 5) => new Promise((resolve) => { setTimeout(resolve, ms); });

class FakeWorker {
  constructor(channel, { autoReady = true } = {}) {
    Object.assign(this, { channel, autoReady, sent: [], terminated: false });
  }
  postMessage(msg) {
    this.sent.push(msg);
    if (msg.type === 'init' && this.autoReady) setTimeout(() => this.emit({ type: 'ready', latest }), 0);
  }
  emit(msg) { this.onmessage?.({ data: msg }); }
  terminate() { this.terminated = true; }
  jobs() { return this.sent.filter((m) => m.type === 'job'); }
}

function harness({ spawnThrows = false, autoReady = true, readyTimeout = 50 } = {}) {
  const workers = [];
  const out = { results: [], errors: [], progress: [] };
  const handle = (msg, data, { onProgress }) => { // engine/jobs.js handle(msg, data, {onProgress})
    onProgress({ stage: 'stage', done: 1, total: 2 });
    if (msg.state.fail) throw Object.assign(new Error('样本太短'), { code: 'E_SHORT_SAMPLE' });
    return { key: `${msg.kind}:${msg.state.n}`, value: msg.state.n };
  };
  const compute = createCompute({
    history: {}, valuation: {}, readyTimeout,
    onResult: (r) => out.results.push(r), onError: (e) => out.errors.push(e), onProgress: (p) => out.progress.push(p),
    spawn: (channel) => {
      if (spawnThrows) throw new Error('Worker unavailable');
      const w = new FakeWorker(channel, { autoReady });
      workers.push(w);
      return w;
    },
    loadJobs: async () => ({ handle }),
  });
  return { compute, ...out, worker: (channel) => workers.filter((w) => w.channel === channel).at(-1) };
}

test('createCompute: per-kind latest wins on the compute worker', async () => {
  const h = harness();
  h.compute.request('sample', { n: 1 }, { key: 'a' });
  await tick();
  const w = h.worker('compute');
  assert.equal(w.sent[0].type, 'init');
  h.compute.request('sample', { n: 2 }, { key: 'b' });
  h.compute.request('sample', { n: 3 }, { key: 'c' });
  h.compute.request('alloc', { n: 9 }, { key: 'x' });
  await tick();
  const [first, alloc] = w.jobs();
  assert.deepEqual([first.state, alloc.state, w.jobs().length], [{ n: 1 }, { n: 9 }, 2]);
  w.emit({ type: 'result', id: first.id, kind: 'sample', key: 'a', result: { key: 'a' } });
  await tick();
  assert.deepEqual(h.results, []);
  const third = w.jobs().at(-1);
  assert.deepEqual(third.state, { n: 3 });
  w.emit({ type: 'result', id: third.id, kind: 'sample', key: 'c', result: { key: 'c' } });
  w.emit({ type: 'progress', id: alloc.id, kind: 'alloc', stage: 'x', done: 1, total: 1 });
  w.emit({ type: 'error', id: alloc.id, kind: 'alloc', code: 'E_INFEASIBLE', message: '无解' });
  assert.deepEqual(h.results.map((r) => r.key), ['c']);
  assert.deepEqual(h.errors.map((e) => e.code), ['E_INFEASIBLE']);
  assert.equal(h.progress.length, 1);
  h.compute.request('sample', { n: 4 }, { key: 'd' });
  await tick();
  const posted = w.jobs().length;
  h.compute.request('sample', { n: 5 }, { key: 'd' }); // same key as the running job: nothing new to post
  await tick();
  assert.equal(w.jobs().length, posted);
  assert.deepEqual(w.jobs().at(-1).state, { n: 4 });
});

test('createCompute: a superseding robust job terminates and re-initialises the robust worker', async () => {
  const h = harness();
  h.compute.request('robust', { n: 1 }, { key: 'r1' });
  await tick();
  const first = h.worker('robust');
  const staleJob = first.jobs()[0];
  h.compute.request('robust', { n: 2 }, { key: 'r2' });
  assert.equal(first.terminated, true);
  await tick();
  const second = h.worker('robust');
  assert.notEqual(second, first);
  assert.equal(second.sent[0].type, 'init');
  const job = second.jobs()[0];
  assert.deepEqual(job.state, { n: 2 });
  first.emit({ type: 'result', id: staleJob.id, kind: 'robust', key: 'r1', result: { key: 'r1' } });
  second.emit({ type: 'result', id: job.id, kind: 'robust', key: 'r2', result: { key: 'r2' } });
  assert.deepEqual(h.results.map((r) => r.key), ['r2']);
  h.compute.request('robust', { n: 3 }, { key: 'r3' });
  await tick();
  h.compute.cancel('robust');
  assert.equal(h.worker('robust').terminated, true);
});

test('createCompute: falls back to in-thread jobs when Worker construction throws', async () => {
  const h = harness({ spawnThrows: true });
  h.compute.request('context', { n: 4 });
  h.compute.request('sample', { fail: true });
  await tick(20);
  assert.deepEqual(h.results.map((r) => [r.kind, r.key, r.result.value]), [['context', 'context:4', 4]]);
  assert.deepEqual(h.errors.map((e) => [e.kind, e.code, e.message]), [['sample', 'E_SHORT_SAMPLE', '样本太短']]);
  assert.deepEqual(h.compute.status(), { compute: 'thread', robust: 'thread' });
});

test('createCompute: falls back when ready does not arrive in time', async () => {
  const h = harness({ autoReady: false, readyTimeout: 10 });
  h.compute.request('alloc', { n: 5 });
  await tick(40);
  assert.equal(h.worker('compute').terminated, true);
  assert.deepEqual(h.results.map((r) => r.result.value), [5]);
  assert.deepEqual(h.progress.map((p) => [p.kind, p.stage]), [['alloc', 'stage']]);
});
