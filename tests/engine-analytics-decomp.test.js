import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anchorDecomposition, anchorValue, breakEven, identityRow, isMaterial, splitAtM0,
} from '../docs/assets/js/engine/decomp.js?v=20260912';

const history = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const valuation = JSON.parse(readFileSync(new URL('../docs/data/valuation.json', import.meta.url)));
const base = anchorDecomposition(history, valuation);
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const total = (row, k) => row[k] * row.years; // lp over the whole row

test('rows telescope to the full period; the P/E and EPS terms carry the splice gap', () => {
  const { rows, full, spliceRow } = base;
  assert.equal(rows[0].start, full.start);
  assert.equal(rows.at(-1).end, full.end);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].start, rows[i - 1].end);
  for (const k of ['price_lp_yr', 'div_lp_yr', 'tr_lp_yr']) close(rows.reduce((s, r) => s + total(r, k), 0), total(full, k), 1e-9, k);
  close(total(full, 'pe_lp_yr') - rows.reduce((s, r) => s + total(r, 'pe_lp_yr'), 0), spliceRow.lp_total, 1e-9);
  close(rows.reduce((s, r) => s + total(r, 'eps_lp_yr'), 0) - total(full, 'eps_lp_yr'), spliceRow.lp_total, 1e-9);
  assert.ok(Math.abs(spliceRow.lp_total) <= 2);
  assert.equal(spliceRow.label, '口径拼接差');
  close(spliceRow.lp_yr, spliceRow.lp_total / full.years, 1e-15);
});

test('every row satisfies the log identity, factor products and the share rule', () => {
  const lv = m => { const o = history.observations.find(x => x.month === m); return o.NDX / o.SPX; };
  for (const r of [...base.rows, base.full]) {
    close(r.price_lp_yr, r.pe_lp_yr + r.eps_lp_yr, 1e-12, r.id);
    close(r.tr_lp_yr, r.price_lp_yr + r.div_lp_yr, 1e-12, r.id);
    close(r.factors.price, r.factors.pe * r.factors.eps, 1e-12 * r.factors.price, r.id);
    close(r.factors.tr, r.factors.price * r.factors.div, 1e-12 * r.factors.tr, r.id);
    close(r.factors.price, lv(r.end) / lv(r.start), 1e-12 * r.factors.price, r.id);
    close(r.factors.pe, r.M_end / r.M_start, 1e-12, r.id);
    const lnR = Math.log(r.factors.price), lnT = Math.log(r.factors.tr);
    if (isMaterial(lnR, r.years)) close(r.sharesPrice.pe + r.sharesPrice.eps, 1, 1e-12, r.id);
    else assert.equal(r.sharesPrice, null, r.id);
    if (isMaterial(lnT, r.years)) close(r.sharesTr.pe + r.sharesTr.eps + r.sharesTr.div, 1, 1e-12, r.id);
    else assert.equal(r.sharesTr, null, r.id);
  }
  const tiers = new Set(Object.keys(valuation.tiers));
  for (const r of base.rows) assert.ok(tiers.has(r.startTier) && tiers.has(r.endTier), r.id);
  assert.doesNotThrow(() => structuredClone(base));
});

test('materiality rule: |ln total| ≥ 0.10 and |annual| ≥ 1 lp', () => {
  assert.equal(identityRow({ years: 10, lnR: 0.09, lnM: 0.01 }).sharesPrice, null);
  assert.equal(identityRow({ years: 20, lnR: 0.15, lnM: 0.01 }).sharesPrice, null);
  assert.ok(identityRow({ years: 10, lnR: 0.12, lnM: 0.01 }).sharesPrice);
  const noDiv = identityRow({ years: 10, lnR: 0.5, lnM: 0.1 });
  for (const k of ['div_lp_yr', 'tr_lp_yr', 'sharesTr']) assert.equal(noDiv[k], null, k);
  assert.equal(noDiv.factors.tr, null);
});

test('m0 overrides only the d1985 start and the full start', () => {
  assert.equal(base.rows[0].M_start, valuation.m0_1985.central);
  assert.equal(base.full.m0Used, valuation.m0_1985.central);
  assert.equal(base.full.M_end, valuation.latest.M);
  const alt = anchorDecomposition(history, valuation, { m0: 2.5 });
  assert.equal(alt.rows[0].M_start, 2.5);
  assert.equal(alt.full.M_start, 2.5);
  assert.equal(alt.full.m0Used, 2.5);
  assert.equal(alt.rows[0].startTier, 'user');
  assert.equal(alt.full.startTier, 'user');
  for (let i = 1; i < base.rows.length; i++) assert.deepEqual(alt.rows[i], base.rows[i]);
  assert.equal(alt.rows[0].price_lp_yr, base.rows[0].price_lp_yr);
  close(alt.spliceRow.lp_total, base.spliceRow.lp_total, 1e-12);
  assert.deepEqual(alt.full.band, base.full.band);
});

test('break-even M0 values give 0/25/50% P/E shares and splitAtM0 reproduces the full row', () => {
  const be = breakEven(history, valuation);
  assert.deepEqual(be, base.breakEven);
  for (const [k, share] of [['p0', 0], ['p25', 0.25], ['p50', 0.5]]) close(1 - splitAtM0(be, be.m0ForPeShare[k]).epsSharePrice, share, 1e-12, k);
  const s = splitAtM0(be, base.full.m0Used);
  close(s.pe_lp_yr, base.full.pe_lp_yr, 1e-12);
  close(s.eps_lp_yr, base.full.eps_lp_yr, 1e-12);
  close(s.epsSharePrice, base.full.sharesPrice.eps, 1e-12);
  const lo = splitAtM0(be, valuation.m0_1985.low), hi = splitAtM0(be, valuation.m0_1985.high);
  for (const k of ['epsSharePrice', 'pe_lp_yr', 'eps_lp_yr']) assert.deepEqual(base.full.band[k], [Math.min(lo[k], hi[k]), Math.max(lo[k], hi[k])], k);
  assert.ok(Object.values(be).every(v => typeof v !== 'function'));
});

test('dividend band and withholding tax move only the dividend term', () => {
  for (const opts of [{ ndxDiv: 'low' }, { ndxDiv: 'high' }, { wht: 0.3 }]) {
    const alt = anchorDecomposition(history, valuation, opts);
    assert.equal(alt.full.price_lp_yr, base.full.price_lp_yr);
    assert.equal(alt.full.pe_lp_yr, base.full.pe_lp_yr);
    assert.notEqual(alt.full.div_lp_yr, base.full.div_lp_yr);
  }
  const low = anchorDecomposition(history, valuation, { ndxDiv: 'low' }), high = anchorDecomposition(history, valuation, { ndxDiv: 'high' });
  assert.ok(low.rows[0].div_lp_yr < base.rows[0].div_lp_yr && base.rows[0].div_lp_yr < high.rows[0].div_lp_yr);
  const observedNdxTr = base.rows.filter(r => r.start >= '2004-12');
  for (const r of observedNdxTr) close(low.rows.find(x => x.id === r.id).div_lp_yr, r.div_lp_yr, 1e-12, r.id);
});

test('missing anchors raise E_NULL_DATA', () => {
  assert.throws(() => anchorValue(valuation, '1990-06', 'bridge'), e => e.code === 'E_NULL_DATA');
  assert.equal(anchorValue(valuation, valuation.latest.month, valuation.latest.tier), valuation.latest.M);
});
