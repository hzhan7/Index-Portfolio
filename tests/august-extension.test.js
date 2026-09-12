import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const data = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const history = data.observations;
const V1_KEYS = ['month', 'NDX', 'SPX', 'XNDX', 'SPXTR', 'RF', 'dgs10_pct', 'ndx_pr', 'spx_pr', 'ndx_tr', 'spx_tr', 'coupon', 'bond_pr', 'bond_tr'];
const close = (a, b, t = 1e-12) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);

test('Eight complete months extend the same historical observations to August 2026', () => {
  assert.equal(data.as_of, '2026-08-31');
  assert.equal(history.length, 500);
  assert.deepEqual(history.slice(-8).map(r => r.month), Array.from({length: 8}, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`));
  const v1 = history.filter(r => r.month <= '2025-12').map(r => Object.fromEntries(V1_KEYS.map(k => [k, r[k]])));
  assert.equal(v1.length, 492);
  assert.equal(createHash('sha256').update(JSON.stringify(v1)).digest('hex'), '0620174c31cdd2d24ff18312f4033e73ac97a5e7b465c0895f32a844352d05cd');
  for (const row of history.slice(-8)) {
    for (const field of ['NDX', 'SPX', 'XNDX', 'SPXTR', 'ndx_pr', 'spx_pr', 'ndx_tr', 'spx_tr', 'bond_tr', 'bond_pr', 'RF']) {
      assert.ok(Number.isFinite(row[field]), `${row.month} ${field}`);
    }
  }
});

test('August uses actual equity month ends and the unchanged bond formula', () => {
  const august = history.at(-1), july = history.at(-2);
  close(august.NDX, 29456.97325299668); close(august.XNDX, 35976.93828495717);
  close(august.SPX, 7686.14); close(august.SPXTR, 17219.939453125);
  close(july.SPXTR, 16763.419921875);
  close(august.spx_tr, august.SPXTR / july.SPXTR - 1); close(august.ndx_tr, august.XNDX / july.XNDX - 1);
  close(august.bond_tr, august.bond_pr + august.coupon); close(august.bond_pr, 0);
});

test('August RF carries a provisional note; January-July use published French returns', () => {
  const q = data.quality_notes.find(n => n.field === 'RF' && n.month === '2026-08');
  assert.ok(q, 'RF note for 2026-08 exists');
  assert.equal(q.status, 'estimated'); assert.equal(q.observed_value, null);
  close(q.effective_value, 1 / (1 - .0363 * 31 / 360) - 1); close(q.effective_value, history.at(-1).RF);
  assert.ok(!data.quality_notes.some(n => n.field === 'RF' && n.month >= '2026-01' && n.month <= '2026-07'));
  const actual = [.003, .0028, .0029, .0029, .0031, .0029, .0033];
  history.slice(-8, -1).forEach((row, i) => close(row.RF, actual[i]));

  const [header, ...lines] = readFileSync(new URL('../docs/data/monthly_history.csv', import.meta.url), 'utf8').trim().split(/\r?\n/).map(l => l.split(','));
  const col = header.indexOf('RF_status');
  assert.ok(col >= 0);
  assert.equal(lines.at(-1)[col], 'estimated');
  assert.ok(lines.slice(0, -1).every(l => l[col] === 'observed'));
});

test('Price and observed total-return series stay complete through August 2026', () => {
  const priceMonths = history.slice(1).filter(r => Number.isFinite(r.ndx_pr) && Number.isFinite(r.spx_pr) && Number.isFinite(r.bond_pr));
  assert.equal(priceMonths.length, 499);
  const observedTr = history.filter(r => r.month >= '1999-04' && Number.isFinite(r.ndx_tr) && Number.isFinite(r.spx_tr) && Number.isFinite(r.bond_tr));
  assert.equal(observedTr.length, 329);
});
