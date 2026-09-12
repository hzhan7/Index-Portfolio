import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  headToHead, relativeWealth, losingRuns, rollingExcess, regimeTable, decadeTable, SHORT_MONTHS,
} from '../docs/assets/js/engine/compare.js?v=20260912';
import { buildSample, firstMonth, latestMonth, monthDiff, addMonths } from '../docs/assets/js/engine/series.js?v=20260912';
import { REGIMES } from '../docs/assets/js/engine/periods.js?v=20260912';

const history = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const latest = latestMonth(history), first = firstMonth(history);
const TR = { basis: 'tr', ndxDiv: 'default', wht: 0 };
const close = (a, b, tol = 1e-12, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test('losingRuns merges runs separated by at most 12 non-losing months and sorts by size', () => {
  const starts = Array.from({ length: 40 }, (_, k) => addMonths('2000-01', k));
  const ex = new Float64Array(40).fill(0.01);
  for (const k of [0, 1, 14, 28, 29, 30]) ex[k] = -0.01;
  ex[31] = 0; // zero excess counts as losing
  assert.deepEqual(losingRuns(starts, ex), [{ from: starts[28], to: starts[31], n: 4 }, { from: starts[0], to: starts[14], n: 3 }]);
  assert.deepEqual(losingRuns(starts, ex, 11).map(r => r.n), [4, 2, 1]);
  assert.deepEqual(losingRuns(starts, new Float64Array(40).fill(0.02)), []);
});

test('rollingExcess covers every start month of the full range with consistent summaries', () => {
  const nMonths = history.observations.length - 1;
  for (const years of [5, 10, 20]) {
    const r = rollingExcess(history, { ...TR, start: '2010-01' }, { years });
    assert.equal(r.n, nMonths - 12 * years + 1);
    assert.equal(r.points.start[0], first);
    assert.equal(r.points.end.at(-1), latest);
    for (let k = 1; k < r.n; k++) assert.equal(monthDiff(r.points.start[k - 1], r.points.start[k]), 1);
    assert.equal(r.nWin, Array.from(r.points.excess).filter(v => v > 0).length);
    assert.equal(r.nWin + r.nLose, r.n);
    close(r.winRate, r.nWin / r.n);
    close(r.worst.excess, Math.min(...r.points.excess));
    assert.equal(r.losingRuns.reduce((s, x) => s + x.n, 0), r.nLose);
    assert.ok(r.p10 <= r.median && r.median <= r.p90);
    const vm = rollingExcess(history, TR, { years, volMatched: true });
    assert.equal(vm.volMatched, true);
    close(vm.winRate, r.vmWinRate);
    close(vm.vmWinRate, r.vmWinRate);
  }
  assert.doesNotThrow(() => structuredClone(rollingExcess(history, TR)));
});

test('a rolling point equals the NDX − SPX CAGR difference of its own 10-year sample', () => {
  const r = rollingExcess(history, TR, { years: 10 });
  const cagr = (s, i) => Math.expm1(12 * s.R[i].reduce((a, v) => a + Math.log1p(v), 0) / s.n);
  for (const k of [0, 37, r.n - 1]) {
    const s = buildSample(history, { start: r.points.start[k], end: r.points.end[k], ...TR });
    assert.equal(s.n, 120);
    close(r.points.excess[k], cagr(s, 0) - cagr(s, 1), 1e-12, `k=${k}`);
  }
});

test('headToHead: differences, vol matching, price basis, dividend contribution and estimate impact', () => {
  const h = headToHead(history, { start: first, end: latest, ...TR });
  for (const k of ['cagr', 'sharpe', 'vol', 'mdd', 'worst12m']) close(h.diff[k], h.ndx[k] - h.spx[k], 1e-15, k);
  close(h.volMatched.spread, h.volMatched.ndxCagr - h.spx.cagr, 1e-15);
  assert.ok(h.sharpeDiffCI.lo < h.sharpeDiffCI.point && h.sharpeDiffCI.point < h.sharpeDiffCI.hi);
  close(h.divContribution.ndx, h.ndx.cagr - h.priceBasis.ndxCagr, 1e-15);
  const [lo, hi] = h.estimateImpact.ndxCagr;
  assert.ok(lo < h.ndx.cagr && h.ndx.cagr < hi);
  assert.ok(!('wealth' in h.ndx));
  assert.doesNotThrow(() => structuredClone(h));

  const estimatedTo = buildSample(history, { start: first, end: latest, ...TR }).estimated.ndxDiv.to;
  const late = headToHead(history, { start: estimatedTo, end: latest, ...TR });
  assert.equal(late.estimateImpact, null);
  assert.ok(late.priceBasis);

  const pr = headToHead(history, { start: first, end: latest, ...TR, basis: 'pr' });
  assert.equal(pr.priceBasis, null);
  assert.equal(pr.divContribution, null);
  assert.equal(pr.estimateImpact, null);
  close(pr.ndx.sharpe, h.priceBasis.ndxSharpe, 1e-15);

  const taxed = headToHead(history, { start: first, end: latest, ...TR, wht: 0.3 });
  assert.ok(taxed.ndx.cagr < h.ndx.cagr && taxed.spx.cagr < h.spx.cagr);
  close(taxed.priceBasis.spxCagr, h.priceBasis.spxCagr, 0);
});

test('relativeWealth starts at 1 and ends at the ratio of compounded wealth', () => {
  const s = buildSample(history, { start: '2009-02', end: latest, ...TR });
  const rw = relativeWealth(s);
  assert.equal(rw.months.length, s.n + 1);
  assert.equal(rw.months[0], '2009-02');
  assert.equal(rw.ratio[0], 1);
  const w = i => s.R[i].reduce((a, v) => a * (1 + v), 1);
  close(rw.endRatio, w(0) / w(1), 1e-10);
});

test('regimeTable and decadeTable run over every period on both bases and all dividend settings', () => {
  for (const basis of ['tr', 'pr']) for (const [ndxDiv, wht] of [['default', 0], ['low', 0], ['high', 0.3]]) {
    const opts = { basis, ndxDiv, wht };
    const regimes = regimeTable(history, opts), decades = decadeTable(history, opts);
    assert.deepEqual(regimes.map(r => r.id), REGIMES.map(r => r.id));
    assert.equal(regimes.at(-1).to, latest);
    assert.deepEqual(decades.map(r => r.id), ['d1985', 'd1995', 'd2005', 'd2015', 'd2025']);
    assert.equal(decades.at(-1).to, latest);
    for (const r of [...regimes, ...decades]) {
      assert.equal(r.n, monthDiff(r.from, r.to));
      assert.equal(r.short, r.n < SHORT_MONTHS);
      for (const side of [r.ndx, r.spx]) {
        if (r.short) assert.equal(side.sharpe, null);
        else assert.ok(Number.isFinite(side.sharpe));
        close(Math.pow(1 + side.cagr, r.n / 12), 1 + side.cumReturn, 1e-9);
      }
      close(r.spreadCagr, r.ndx.cagr - r.spx.cagr, 1e-15);
    }
    assert.doesNotThrow(() => structuredClone({ regimes, decades }));
  }
});
