import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../docs/assets/js/lib/format.js?v=20260912';

const M = '−';

test('percent formats use U+2212 and no space before %', () => {
  assert.equal(f.fmtPct(0.14765923), '14.8%');
  assert.equal(f.fmtPct(-0.81042973), `${M}81.0%`);
  assert.equal(f.fmtPct(0.1245), '12.5%', 'decimal half rounds up despite float artefacts');
  assert.equal(f.fmtPct(0.11881436, 2), '11.88%');
  assert.equal(f.fmtPct(-0.00004), '0.0%', 'values rounding to zero carry no sign');
  assert.equal(f.fmtPctSigned(0.0057), '+0.6%');
  assert.equal(f.fmtPctSigned(-0.0383), `${M}3.8%`);
  for (const s of [f.fmtPct(-0.5), f.fmtPctSigned(0.2), f.fmtPct(1)]) assert.doesNotMatch(s, / %/);
});

test('percentage points, log points and ratios', () => {
  assert.equal(f.fmtPp(0.029), '+2.9个百分点');
  assert.equal(f.fmtPp(-0.0755256), `${M}7.6个百分点`);
  assert.equal(f.fmtPp(0), '0.0个百分点');
  assert.equal(f.fmtPpBare(0.0410), '+4.1');
  assert.equal(f.fmtLp(-0.83176669), `${M}0.8个百分点/年`);
  assert.equal(f.fmtLp(4.93460613), '+4.9个百分点/年');
  assert.equal(f.fmtLpBare(-1.557), `${M}1.6`);
  assert.equal(f.fmtRatio(2.88204311), '×2.88');
  assert.equal(f.fmtRatio(5.5074262, 1), '×5.5');
});

test('plain and signed numbers', () => {
  assert.equal(f.fmtNum(0.61414498), '0.61');
  assert.equal(f.fmtNum(-0.0378, 3), `${M}0.038`);
  assert.equal(f.fmtNumSigned(0.0333), '+0.03');
  assert.equal(f.fmtNumSigned(-0.0378), `${M}0.04`);
  assert.equal(f.fmtNum(1234.5, 0), '1235');
});

test('missing values render as an em dash', () => {
  for (const fn of [f.fmtPct, f.fmtPp, f.fmtNum, f.fmtRatio, f.fmtLp, f.fmtNumSigned, f.fmtPctSigned]) {
    assert.equal(fn(null), '—');
    assert.equal(fn(NaN), '—');
    assert.equal(fn(undefined), '—');
  }
  assert.equal(f.fmtMonth('bad'), '—');
});

test('months, ranges and arrows', () => {
  assert.equal(f.fmtMonth('2026-08'), '2026-08');
  assert.equal(f.fmtMonth('2026-09-10'), '2026-09');
  assert.equal(f.fmtMonth(new Date(Date.UTC(1985, 0, 31))), '1985-01');
  assert.equal(f.fmtMonths(126), '126个月');
  assert.equal(f.fmtRange(-0.22004624, 0.16598154, f.fmtNumSigned), `${M}0.22～+0.17`);
  assert.equal(f.fmtRange(1.8, 2.5), '1.80～2.50');
  assert.equal(f.fmtRange(0.114, 0.133, (x) => f.fmtPct(x, 0)), '11%～13%');
  assert.equal(f.deltaArrow(0.006), '▲');
  assert.equal(f.deltaArrow(-0.038), '▼');
  assert.equal(f.deltaArrow(0.00001, 0.00005), '');
});

test('roundWeights uses largest remainder and always sums to 100', () => {
  assert.deepEqual(f.roundWeights([0.3856061, 0.44364835, 0.17074555]), [39, 44, 17]);
  assert.deepEqual(f.roundWeights([0.43507731, 0.36339364, 0.20152905]), [44, 36, 20]);
  assert.deepEqual(f.roundWeights([1 / 3, 1 / 3, 1 / 3]), [34, 33, 33]);
  assert.deepEqual(f.roundWeights([0.125, 0.125, 0.75]), [13, 12, 75]);
  assert.deepEqual(f.roundWeights([1, 0, 0]), [100, 0, 0]);
  assert.deepEqual(f.roundWeights([0.5, 0.5, -1e-16]), [50, 50, 0]);
  assert.deepEqual(f.roundWeights([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(f.roundWeights(new Float64Array([0.2, 0.3, 0.5])), [20, 30, 50]);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 500; k++) {
    const a = rnd(), b = rnd() * (1 - a);
    const r = f.roundWeights([a, b, 1 - a - b]);
    assert.equal(r.reduce((s, x) => s + x, 0), 100);
    r.forEach((x, i) => assert.ok(Math.abs(x - [a, b, 1 - a - b][i] * 100) < 1 + 1e-9));
  }
});

test('fmtWeights renders the compact weight string', () => {
  assert.equal(f.fmtWeights([0.3856061, 0.44364835, 0.17074555]), '纳指 39 / 标普 44 / 美债 17');
  assert.equal(f.fmtWeights([0.7566, 0, 0.2434], f.ASSET_NAMES), '纳指100 76 / 标普500 0 / 10年美债 24');
});
