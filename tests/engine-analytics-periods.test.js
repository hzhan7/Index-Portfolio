import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGIMES, DECADES, resolveMonth, regimePeriods, decadePeriods } from '../docs/assets/js/engine/periods.js?v=20260912';

const history = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const valuation = JSON.parse(readFileSync(new URL('../docs/data/valuation.json', import.meta.url)));
const latest = history.observations.at(-1).month;

test('regimes are contiguous, start at the first data month and end at latest', () => {
  assert.equal(REGIMES[0].from, history.observations[0].month);
  for (let i = 1; i < REGIMES.length; i++) assert.equal(REGIMES[i].from, REGIMES[i - 1].to);
  assert.equal(REGIMES.at(-1).to, 'latest');
  const resolved = regimePeriods(latest);
  assert.equal(resolved.at(-1).to, latest);
  assert.ok(resolved.every(r => r.from < r.to));
  assert.equal(new Set(REGIMES.map(r => r.id)).size, REGIMES.length);
});

test('decade periods chain DECADES and line up with valuation.json segments', () => {
  const periods = decadePeriods(latest);
  assert.equal(periods.length, DECADES.length - 1);
  assert.equal(periods.at(-1).to, latest);
  assert.deepEqual(periods.map(p => p.id), valuation.segments.map(s => s.id));
  assert.deepEqual(periods.map(p => [p.from, p.to]), valuation.segments.map(s => [s.start, s.end]));
  assert.deepEqual(periods.map(p => p.label), valuation.segments.map(s => s.label));
});

test('resolveMonth maps latest and null only', () => {
  assert.equal(resolveMonth('latest', '2026-08'), '2026-08');
  assert.equal(resolveMonth(null, '2026-08'), '2026-08');
  assert.equal(resolveMonth('2001-05', '2026-08'), '2001-05');
});
