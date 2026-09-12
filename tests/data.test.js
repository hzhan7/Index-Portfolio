import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, ROOT));
const history = JSON.parse(read('docs/data/history.json'));
const valuation = JSON.parse(read('docs/data/valuation.json'));
const rows = history.observations;
const by = Object.fromEntries(rows.map(r => [r.month, r]));
const latest = rows.at(-1).month;

const V1_KEYS = ['month', 'NDX', 'SPX', 'XNDX', 'SPXTR', 'RF', 'dgs10_pct', 'ndx_pr', 'spx_pr', 'ndx_tr', 'spx_tr', 'coupon', 'bond_pr', 'bond_tr'];
const NEW_KEYS = ['ndx_div_default', 'ndx_div_low', 'ndx_div_high', 'spx_tr_con'];
const BANDS = ['default', 'low', 'high'];
// sha256(JSON.stringify(v1-key projection of rows <= 2025-12)), computed from commit d907738 (schemaVersion 1)
const V1_THROUGH_2025_SHA256 = '0620174c31cdd2d24ff18312f4033e73ac97a5e7b465c0895f32a844352d05cd';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const close = (a, b, tol, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b} (tol ${tol})`);
const monthsBetween = (from, to) => rows.map(r => r.month).filter(m => m >= from && m <= to);
const nonNullMonths = key => rows.filter(r => r[key] !== null).map(r => r.month);
const nextMonth = m => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const compound = months => months.reduce((g, m) => g * (1 + by[m].spx_tr_con), 1) - 1;

test('history.json is schemaVersion 2 and every row has the v1 keys plus the backfill keys', () => {
  assert.equal(history.schemaVersion, 2);
  for (const row of rows) assert.deepEqual(Object.keys(row), [...V1_KEYS, ...NEW_KEYS], row.month);
  assert.equal(rows[0].month, '1985-01');
  rows.slice(1).forEach((row, i) => assert.equal(row.month, nextMonth(rows[i].month), 'contiguous months'));
});

test('v1 values through 2025-12 are unchanged (hash of the v1-key projection)', () => {
  const v1 = rows.filter(r => r.month <= '2025-12').map(r => Object.fromEntries(V1_KEYS.map(k => [k, r[k]])));
  assert.equal(v1.length, 492);
  assert.equal(sha256(JSON.stringify(v1)), V1_THROUGH_2025_SHA256);
});

test('NDX dividend estimates cover exactly 1985-02…1999-03 with low ≤ default ≤ high', () => {
  const months = monthsBetween('1985-02', '1999-03');
  assert.equal(months.length, 170);
  for (const band of BANDS) assert.deepEqual(nonNullMonths(`ndx_div_${band}`), months, band);
  for (const m of months) {
    const r = by[m];
    assert.equal(r.ndx_tr, null, m);
    assert.ok(r.ndx_div_default > 0 && r.ndx_div_low <= r.ndx_div_default && r.ndx_div_default <= r.ndx_div_high, m);
    close(r.ndx_div_low, 0.75 * r.ndx_div_default, 1.5e-10, `${m} low`);
    close(r.ndx_div_high, 1.25 * r.ndx_div_default, 1.5e-10, `${m} high`);
  }
});

test('SPX constructed total return covers exactly 1985-02…1988-01 and matches the calibration', () => {
  const months = monthsBetween('1985-02', '1988-01');
  assert.equal(months.length, 36);
  assert.deepEqual(nonNullMonths('spx_tr_con'), months);
  for (const m of months) assert.ok(by[m].spx_tr === null && by[m].spx_tr_con >= by[m].spx_pr, m);

  const levels = Object.fromEntries(read('data/sources/backfill_1985/spxtr_backfill_1985_1987_recommended.csv')
    .toString().trim().split(/\r?\n/).slice(1).map(line => line.split(',')).map(([m, level]) => [m, Number(level)]));
  const jan1985 = levels['1985-01'] / levels['1984-12'] - 1;
  const annual = {
    1985: (1 + jan1985) * (1 + compound(monthsBetween('1985-02', '1985-12'))) - 1,
    1986: compound(monthsBetween('1986-01', '1986-12')),
    1987: compound(monthsBetween('1987-01', '1987-12')),
  };
  close(annual[1985], levels['1985-12'] / levels['1984-12'] - 1, 1e-12, '1985 rows vs levels');
  for (const [year, target] of Object.entries({1985: 31.73, 1986: 18.67, 1987: 5.25})) close(annual[year] * 100, target, 0.02, year);

  assert.equal(by['1988-01'].SPXTR, 257.47);
  assert.equal(levels['1987-12'], 247.08);
  close(by['1988-01'].spx_tr_con, 257.47 / 247.08 - 1, 1e-12, '1988-01');
});

test('total-return basis series have no nulls from 1985-02 to latest for every dividend band', () => {
  for (const row of rows.slice(1)) {
    for (const band of BANDS) assert.ok(Number.isFinite(row.ndx_tr ?? row.ndx_pr + row[`ndx_div_${band}`]), `${row.month} NDX ${band}`);
    assert.ok(Number.isFinite(row.spx_tr ?? row.spx_tr_con), `${row.month} SPX`);
    assert.ok(Number.isFinite(row.bond_tr) && Number.isFinite(row.RF), `${row.month} UST/RF`);
  }
});

test('coverage, sources and quality notes describe every series and the backfills', () => {
  const statusOf = {
    NDX: r => r.NDX === null ? null : 'observed',
    SPX: r => r.SPX === null ? null : 'observed',
    NDX_TR: r => r.ndx_tr !== null ? 'observed' : r.ndx_div_default !== null ? 'estimated' : null,
    SPX_TR: r => r.spx_tr !== null ? 'observed' : r.spx_tr_con !== null ? 'constructed' : null,
    RF: r => r.RF === null ? null : history.quality_notes.some(q => q.field === 'RF' && q.month === r.month && q.status === 'estimated') ? 'estimated' : 'observed',
    UST: r => r.bond_tr === null ? null : 'model',
  };
  assert.deepEqual(history.coverage.map(c => c.id), Object.keys(statusOf));
  for (const series of history.coverage) {
    assert.ok(series.label, series.id);
    const expanded = {};
    series.segments.forEach((s, i) => {
      assert.ok(['observed', 'constructed', 'estimated', 'model'].includes(s.status) && s.from <= s.to, series.id);
      assert.ok(history.sources[s.source_id]?.title, `${series.id} ${s.source_id}`);
      if (i) assert.equal(s.from, nextMonth(series.segments[i - 1].to), `${series.id} contiguous`);
      for (let m = s.from; m <= s.to; m = nextMonth(m)) expanded[m] = s.status;
    });
    for (const row of rows) assert.equal(expanded[row.month] ?? null, statusOf[series.id](row), `${series.id} ${row.month}`);
  }
  const span = id => history.coverage.find(c => c.id === id).segments.map(({from, to, status}) => [from, to, status]);
  assert.deepEqual(span('NDX_TR'), [['1985-02', '1999-03', 'estimated'], ['1999-04', latest, 'observed']]);
  assert.deepEqual(span('SPX_TR'), [['1985-02', '1988-01', 'constructed'], ['1988-02', latest, 'observed']]);

  assert.ok(history.quality_notes.some(q => q.field === 'RF' && q.month === '2026-08' && q.status === 'estimated'));
  const range = field => history.quality_notes.find(q => q.field === field);
  assert.deepEqual([range('ndx_div').from, range('ndx_div').to, range('ndx_div').status], ['1985-02', '1999-03', 'estimated']);
  assert.deepEqual([range('spx_tr').from, range('spx_tr').to, range('spx_tr').status], ['1985-02', '1988-01', 'constructed']);
});

test('monthly_history.csv carries the extended total-return columns', () => {
  const [header, ...lines] = read('docs/data/monthly_history.csv').toString().trim().split(/\r?\n/).map(l => l.split(','));
  for (const col of ['RF_status', 'ndx_div_default', 'ndx_div_low', 'ndx_div_high', 'ndx_tr_ext', 'ndx_tr_status', 'spx_tr_con', 'spx_tr_ext', 'spx_tr_status']) {
    assert.ok(header.includes(col), col);
  }
  assert.equal(lines.length, rows.length);
  const csv = Object.fromEntries(lines.map(l => [l[0], Object.fromEntries(header.map((h, i) => [h, l[i]]))]));
  const expect = (m, ndxStatus, spxStatus) => {
    assert.equal(csv[m].ndx_tr_status, ndxStatus, m);
    assert.equal(csv[m].spx_tr_status, spxStatus, m);
    if (ndxStatus) close(Number(csv[m].ndx_tr_ext), by[m].ndx_tr ?? by[m].ndx_pr + by[m].ndx_div_default, 1e-15, m);
    if (spxStatus) close(Number(csv[m].spx_tr_ext), by[m].spx_tr ?? by[m].spx_tr_con, 1e-15, m);
  };
  expect('1985-01', '', '');
  expect('1985-02', 'estimated', 'constructed');
  expect('1988-01', 'estimated', 'constructed');
  expect('1988-02', 'estimated', 'observed');
  expect('1999-03', 'estimated', 'observed');
  expect('1999-04', 'observed', 'observed');
  expect(latest, 'observed', 'observed');
});

test('manifest lists every data file with a matching SHA256', () => {
  const manifest = JSON.parse(read('data/manifest.json'));
  const files = ['data/sources/', 'docs/data/'].flatMap(dir => readdirSync(new URL(dir, ROOT), {recursive: true})
    .map(p => dir + p.split('\\').join('/'))
    .filter(p => !p.split('/').some(part => part.startsWith('.') || part === '__pycache__') && statSync(new URL(p, ROOT)).isFile()));
  assert.deepEqual(manifest.files.map(f => f.path).sort(), files.sort());
  for (const f of manifest.files) {
    const bytes = read(f.path);
    assert.equal(bytes.length, f.bytes, f.path);
    assert.equal(sha256(bytes), f.sha256, f.path);
  }
  for (const path of ['docs/data/valuation.json', 'data/sources/backfill_1985/README.md', 'data/sources/backfill_1985/ndx_yearend_dividend_yield_sec.csv']) {
    assert.ok(files.includes(path), path);
  }
  assert.ok(!files.some(p => p.includes('cost_preset')), 'DATA ships no cost presets');
});

test('valuation.json anchors, segments and chain invariants', () => {
  const {anchors, segments, tiers, sources, m0_1985: m0} = valuation;
  assert.equal(valuation.schemaVersion, 1);
  assert.deepEqual(Object.keys(tiers).sort(), ['bbg_chart', 'bbg_label', 'bridge', 'estimate']);
  const key = (month, tier) => `${month}|${tier}`;
  const anchor = new Map(anchors.map(a => [key(a.month, a.tier), a]));
  assert.equal(anchor.size, anchors.length, 'anchors unique per (month, tier)');
  assert.ok(anchors.length <= 8, 'only a few derived ratios are published');
  for (const a of anchors) {
    assert.ok(a.tier in tiers && sources[a.source_id], `${a.month} ${a.tier}`);
    assert.ok(a.M > 0 && a.M_raw > 0 && a.alignment, `${a.month} ${a.tier}`);
    if (a.tier === 'bridge') close(a.M, a.M_raw * Math.exp(valuation.basis_shift_ln), 1e-12, `${a.month} shift`);
    if (a.tier === 'bbg_chart') assert.equal(a.M, a.M_raw);
  }
  for (const m of ['1985-01', '1994-12', '2004-12']) assert.ok(anchor.has(key(m, 'bridge')), m);
  for (const m of ['2004-12', '2014-12', '2024-12']) assert.ok(anchor.has(key(m, 'bbg_chart')), m);

  assert.equal(m0.central, anchor.get(key('1985-01', 'bridge')).M);
  assert.ok(m0.low <= m0.central && m0.central <= m0.high && m0.tier in tiers && sources[m0.source_id]);

  const last = valuation.latest;
  assert.ok(last.tier in tiers && sources[last.source_id]);
  assert.equal(last.month, latest);
  assert.equal(anchor.get(key(latest, last.tier)).M, last.M);
  close(last.M_label, last.ndx_pe_label / last.spx_pe_label, 5e-5, 'label ratio');
  if (last.verified) {
    const [end, label] = [Object.keys(last.closes).find(d => d.startsWith(latest)), last.labelDate];
    const c = last.closes;
    assert.ok(c[end].NDX === by[latest].NDX && c[end].SPX === by[latest].SPX, 'month-end closes are the site levels');
    close(c[end].fred.NDX, c[end].NDX, 0.005, 'FRED NDX month end');
    close(c[end].fred.SPX, c[end].SPX, 0.005, 'FRED SPX month end');
    close(last.M, last.M_label * (c[end].NDX / c[end].SPX) / (c[label].NDX / c[label].SPX), 1e-12, 'latest adjustment');
  } else {
    assert.equal(last.M, last.M_label);
  }

  assert.deepEqual(segments.map(s => s.id), ['d1985', 'd1995', 'd2005', 'd2015', 'd2025']);
  assert.equal(segments[0].start, '1985-01');
  assert.equal(segments.at(-1).end, latest);
  segments.forEach((s, i) => {
    assert.ok(anchor.has(key(s.start, s.startTier)) && anchor.has(key(s.end, s.endTier)), s.id);
    assert.equal(s.splice, s.startTier !== s.endTier, s.id);
    if (i) assert.equal(s.start, segments[i - 1].end, s.id);
  });

  const lnR = m => Math.log(by[m].NDX / by[m].SPX);
  const M = (m, tier) => anchor.get(key(m, tier)).M;
  let price = 0, pe = 0;
  for (const s of segments) {
    price += lnR(s.end) - lnR(s.start);
    pe += Math.log(M(s.end, s.endTier) / M(s.start, s.startTier));
  }
  const fullPrice = lnR(latest) - lnR('1985-01');
  const fullPe = Math.log(M(latest, last.tier) / m0.central);
  close(100 * (fullPrice - price), 0, 1e-9, 'price chain');
  assert.ok(Math.abs(100 * (fullPe - pe)) <= 2, `P/E splice gap ${100 * (fullPe - pe)} lp`);
  assert.ok(Math.abs(100 * ((fullPrice - fullPe) - (price - pe))) <= 2, 'EPS splice gap');
});

test('licence: no vendor P/E series ship in the repo; the Bloomberg parser fixture P/E is synthetic', () => {
  // Only derived ratios (valuation.json anchors) and the two latest P/E labels may be published.
  const FIXTURE = 'tests/fixtures/mock_bbg_export.csv';
  const csvs = ['data/sources/', 'docs/data/', 'tests/fixtures/'].flatMap(dir => readdirSync(new URL(dir, ROOT), {recursive: true})
    .map(p => dir + p.split('\\').join('/')).filter(p => p.endsWith('.csv')));
  assert.ok(csvs.includes(FIXTURE), FIXTURE);
  const header = p => String(read(p)).split('\n').find(l => l && !l.startsWith('#')).split(',').map(c => c.trim());
  const isPe = c => /(^|_)pe($|_)|pe_ratio/i.test(c);
  for (const p of csvs) if (p !== FIXTURE) assert.deepEqual(header(p).filter(isPe), [], `${p} carries a P/E column`);

  const lines = String(read(FIXTURE)).split('\n');
  assert.match(lines[0], /^# MOCK DATA [–-] not Bloomberg$/);
  assert.match(lines[1], /P\/E = synthetic/);
  assert.doesNotMatch(lines.filter(l => l.startsWith('#')).join('\n'), /screenshot|pixel|截图/i);
  const cols = header(FIXTURE);
  const [iN, iS] = [cols.indexOf('ndx_pe'), cols.indexOf('spx_pe')];
  const peRows = lines.filter(l => l && !l.startsWith('#')).slice(1).map(l => l.split(','))
    .filter(f => f[iN] !== '' || f[iS] !== '');
  assert.ok(peRows.length >= 40, `P/E rows ${peRows.length}`);
  peRows.forEach((f, k) => {
    // Any real (vendor) level pasted back in breaks this deterministic formula.
    close(Number(f[iN]), 30 * Math.exp(0.25 * Math.sin(k / 5)), 6e-7, `${f[0]} ndx_pe`);
    close(Number(f[iS]), 20 * Math.exp(0.12 * Math.cos(k / 7)), 6e-7, `${f[0]} spx_pe`);
  });
});

test('README: per-year decomposition terms add within a row, not across periods of different length', () => {
  const readme = String(read('README.md'));
  assert.doesNotMatch(readme, /相邻区间可直接相加/);
  assert.match(readme, /年化值不能跨区间直接相加/);
  // The data behind it: per-year P/E terms of the decade segments do not sum to the full-period per-year term.
  const {segments, anchors, m0_1985: m0, latest: last} = valuation;
  const M = (m, tier) => anchors.find(a => a.month === m && a.tier === tier).M;
  const yrs = (a, b) => { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (yb - ya) + (mb - ma) / 12; };
  const perYear = segments.map(s => 100 * Math.log(M(s.end, s.endTier) / M(s.start, s.startTier)) / yrs(s.start, s.end));
  const fullPerYear = 100 * Math.log(M(latest, last.tier) / m0.central) / yrs('1985-01', latest);
  assert.ok(Math.abs(perYear.reduce((a, b) => a + b, 0) - fullPerYear) > 0.2, 'per-year terms happen to add; README note may be moot');
});
