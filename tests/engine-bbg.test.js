import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CANON, USER_TIER, parseExport, validate, decompose, chain, toDecompRow, decadeRows, sensitivity, RECIPE_TEXT, recipeText, EXPORT_TEMPLATE_CSV,
} from '../docs/assets/js/engine/bbg.js?v=20260912';
import { anchorDecomposition, splitAtM0 } from '../docs/assets/js/engine/decomp.js?v=20260912';

const history = JSON.parse(readFileSync(new URL('../docs/data/history.json', import.meta.url)));
const valuation = JSON.parse(readFileSync(new URL('../docs/data/valuation.json', import.meta.url)));
const mockText = readFileSync(new URL('./fixtures/mock_bbg_export.csv', import.meta.url), 'utf8');
const mock = parseExport(mockText);
const obs = new Map(history.observations.map(o => [o.month, o]));
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test('fixture is labelled as mock data', () => {
  assert.match(mockText.split('\n')[0], /^# MOCK DATA [–-] not Bloomberg$/);
});

test('wide CSV: rows, metadata, coverage and a clean validation against site history', () => {
  assert.equal(mock.rows[0].month, history.observations[0].month);
  assert.ok(mock.rows.every(r => r.ndx_px > 0 && r.spx_px > 0));
  assert.equal(mock.meta.pe_field, 'PE_RATIO (assumed)');
  assert.ok(mock.notes.includes('日期格式：ISO 或 Excel 序列号'));
  const v = validate(mock, history);
  assert.deepEqual(v.errors, []);
  assert.ok(v.firstPeMonth > history.observations[1].month);
  assert.equal(v.status, `PARTIAL_FROM_${v.firstPeMonth}`);
  assert.equal(v.coverage.ndx_pe.first, v.firstPeMonth);
  assert.equal(v.coverage.ndx_px.n, mock.rows.length);
  assert.ok(!v.warnings.some(w => w.includes('月收益') || w.includes('距月末')), v.warnings.join(' | '));
});

test('decompose: log identity, price and dividend terms match site levels', () => {
  const seg = decompose(mock, '2014-12', '2024-12');
  assert.ok(seg.computable);
  close(seg.price_lp, seg.pe_lp + seg.eps_lp, 1e-9);
  close(seg.tr_lp, seg.price_lp + seg.div_lp, 1e-9);
  close(seg.price_lp_yr * seg.years, seg.price_lp, 1e-9);
  close(seg.factors.pe, seg.M_end / seg.M_start, 1e-12);
  const lv = (m, a, b) => obs.get(m)[a] / obs.get(m)[b];
  close(seg.price_lp, 100 * Math.log(lv('2024-12', 'NDX', 'SPX') / lv('2014-12', 'NDX', 'SPX')), 1e-4); // mock prices rounded to 6 dp
  const divSite = Math.log(lv('2024-12', 'XNDX', 'NDX') / lv('2014-12', 'XNDX', 'NDX')) - Math.log(lv('2024-12', 'SPXTR', 'SPX') / lv('2014-12', 'SPXTR', 'SPX'));
  close(seg.div_lp, 100 * divSite, 1e-4);
  assert.ok(seg.sharesPrice && seg.sharesTr);

  const far = decompose(mock, history.observations[0].month, '2026-06');
  assert.equal(far.computable, false);
  assert.match(far.reason, /缺少价格或市盈率/);
  const moved = decompose(mock, '2014-11', '2024-12', { tolMonths: 1 });
  assert.equal(moved.start, '2014-12');
  assert.ok(moved.flags.some(f => f.includes('端点已移到')));
});

test('chain totals add segments and keep the dividend term only when every segment has it', () => {
  const ends = ['2004-12', '2014-12', '2024-12', '2026-06'];
  const ch = chain(mock, ends);
  assert.deepEqual(ch.flags, []);
  for (const k of ['price_lp', 'pe_lp', 'eps_lp', 'div_lp', 'tr_lp']) close(ch.total[k], ch.segments.reduce((s, x) => s + x[k], 0), 1e-9, k);
  close(ch.total.years, ch.segments.reduce((s, x) => s + x.years, 0), 1e-12);
  close(ch.total.price_lp_yr, ch.total.pe_lp_yr + ch.total.eps_lp_yr, 1e-12);

  const noTr = { ...mock, rows: mock.rows.map(r => (r.month === '2014-12' ? { ...r, ndx_tr: null } : r)) };
  const partial = chain(noTr, ends);
  assert.ok(partial.flags.includes('股息项不完整'));
  for (const k of ['div_lp', 'tr_lp', 'div_lp_yr', 'tr_lp_yr', 'sharesTr']) assert.equal(partial.total[k], null, k);
  assert.equal(partial.total.factors.div, null);
  close(partial.total.price_lp, ch.total.price_lp, 1e-12);
  assert.equal(chain(mock, [history.observations[0].month, '2004-12']).total, null);
});

test('toDecompRow returns the anchorDecomposition row shape', () => {
  const row = toDecompRow(decompose(mock, '2014-12', '2024-12'), { id: 'x', label: 'y' });
  const ref = anchorDecomposition(history, valuation).rows[0];
  assert.deepEqual(Object.keys(row).sort(), Object.keys(ref).sort());
  assert.deepEqual(Object.keys(row.factors).sort(), Object.keys(ref.factors).sort());
  assert.equal(row.startTier, USER_TIER);
  assert.equal(toDecompRow({ computable: false }), null);
});

test('Bloomberg block paste with d/m/yyyy dates reproduces the wide CSV result', () => {
  const at = m => mock.rows.find(r => r.month === m);
  const dmy = m => { const d = at(m).date; return `${+d.slice(8)}/${+d.slice(5, 7)}/${d.slice(0, 4)}`; };
  const months = ['2014-12', '2015-03', '2024-12'];
  const tsv = ['NDX Index\t\t\t\tSPX Index\t\t', '\tPX_LAST\tPE_RATIO\t\t\tPX_LAST\tPE_RATIO',
    ...months.map(m => `${dmy(m)}\t${at(m).ndx_px}\t${at(m).ndx_pe}\t\t${dmy(m)}\t${at(m).spx_px}\t${at(m).spx_pe}`)].join('\n');
  const blk = parseExport(tsv);
  assert.deepEqual(blk.months, months);
  assert.ok(blk.notes.includes('日期格式：日/月/年'));
  const a = decompose(blk, '2014-12', '2024-12'), b = decompose(mock, '2014-12', '2024-12');
  for (const k of ['price_lp_yr', 'pe_lp_yr', 'eps_lp_yr']) close(a[k], b[k], 1e-12, k);
  assert.equal(a.div_lp_yr, null);
  assert.ok(a.flags.some(f => f.includes('未计算股息项')));
});

test('validator flags forward-filled P/E, price mismatches and non-month-end dates', () => {
  const sel = history.observations.filter(o => o.month >= '2019-01' && o.month <= '2020-12');
  const rows = sel.map((o, i) => `${o.month}-20,${i >= 10 ? o.NDX * 1.03 : o.NDX},${o.SPX},${i >= 3 && i <= 8 ? 25 : 25 + i / 10},${20 + i / 20}`);
  const v = validate(parseExport(['date,ndx_px,spx_px,ndx_pe,spx_pe', ...rows].join('\n')), history);
  assert.ok(v.warnings.some(w => w.includes('疑似向前填充')), 'stale P/E');
  assert.ok(v.warnings.some(w => w.includes('距月末超过')), 'month-end');
  assert.ok(v.warnings.some(w => w.includes('与本站月收益不一致')), 'single bad month');
  const wrong = sel.map((o, i) => `${o.month}-28,${o.NDX * (i % 2 ? 1.02 : 1)},${o.SPX},30,20`);
  assert.ok(validate(parseExport(['date,ndx_px,spx_px,ndx_pe,spx_pe', ...wrong].join('\n')), history).errors.some(e => e.includes('相差超过')));
});

test('non-positive P/E is reported and treated as missing', () => {
  const p = parseExport('date,ndx_px,spx_px,ndx_pe,spx_pe\n2019-12-31,8733,3230,-5,20\n2020-12-31,12888,3756,30,25');
  assert.ok(validate(p).warnings.some(w => w.includes('按缺失处理')));
  assert.equal(decompose(p, '2019-12', '2020-12').computable, false);
});

test('dates: Excel serials, ambiguous slash dates, last observation within a month', () => {
  assert.deepEqual(parseExport('date,ndx_px,spx_px\n45657,1,1\n45688,2,2').months, ['2024-12', '2025-01']);
  const amb = parseExport('date,ndx_px,spx_px\n1/2/2020,1,1\n3/4/2020,2,2');
  assert.ok(amb.notes.some(n => n.includes('无法从数值判断')));
  const daily = parseExport('date,ndx_px,spx_px\n2020-01-31,3,3\n2020-01-15,1,1');
  assert.equal(daily.rows[0].ndx_px, 3);
  assert.equal(daily.rows[0].date, '2020-01-31');
  assert.throws(() => parseExport('# comment only\n'), e => e.code === 'E_EMPTY_INPUT');
});

test('sensitivity break-evens agree with decomp.splitAtM0', () => {
  const s = sensitivity(0.7, 3.8, 1.41, 41.5);
  assert.equal(s.m0ForPeShare.p0, 1.41);
  for (const [k, share] of [['p25', 0.25], ['p50', 0.5]]) close(1 - splitAtM0(s, s.m0ForPeShare[k]).epsSharePrice, share, 1e-12, k);
  assert.ok(s.rows.length > 0 && s.rows.every(r => Number.isFinite(r.pe_lp_yr) && Number.isFinite(r.eps_lp_yr)));
});

test('decadeRows chains DECADES boundaries inside the P/E coverage', () => {
  const d = decadeRows(mock);
  assert.equal(d.rows[0].start, d.coverage.from);
  assert.ok(d.rows.every(Boolean) && d.total);
  for (let i = 1; i < d.rows.length; i++) assert.equal(d.rows[i].start, d.rows[i - 1].end);
  assert.ok(d.rows.some(r => r.start === '2014-12' && r.end === '2024-12'));
  assert.deepEqual(decadeRows(parseExport('date,ndx_px,spx_px\n2020-01-31,1,1')).rows, []);
  assert.doesNotThrow(() => structuredClone(d));
});

test('decadeRows: a first P/E month 1–2 months before a decade boundary is absorbed instead of forming a 1–2 month row', () => {
  const lastDay = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate();
  for (const first of ['2004-10', '2004-11', '2004-12', '2005-01']) {
    const rows = history.observations.filter(o => o.month >= first)
      .map((o, k) => `${o.month}-${lastDay(o.month)},${o.NDX},${o.SPX},${(30 - k * 0.01).toFixed(2)},${(18 + k * 0.005).toFixed(3)}`);
    const d = decadeRows(parseExport(['date,ndx_px,spx_px,ndx_pe,spx_pe', ...rows].join('\n')));
    assert.deepEqual([d.rows[0].start, d.rows[0].end], [first, '2014-12'], first);
    assert.ok(d.rows.every(r => r.years > 2 / 12 + 1e-9), `${first}: ${d.rows.map(r => r.label).join(' | ')}`);
    for (let i = 1; i < d.rows.length; i++) assert.equal(d.rows[i].start, d.rows[i - 1].end);
  }
});

test('parser: semicolon and tab files with decimal commas, two-digit years, and a Date label over block-paste date columns', () => {
  const at = m => mock.rows.find(r => r.month === m);
  const months = ['2014-12', '2015-03', '2024-12'], keys = ['ndx_px', 'spx_px', 'ndx_pe', 'spx_pe'];
  const comma = v => String(v).replace('.', ',');
  const day = m => +at(m).date.slice(8), mon = m => +at(m).date.slice(5, 7), yr = m => at(m).date.slice(0, 4);
  const sameValues = (p, label) => {
    assert.deepEqual(p.months, months, label);
    for (const m of months) for (const k of keys) assert.equal(p.rows.find(r => r.month === m)[k], at(m)[k], `${label} ${m} ${k}`);
    const a = decompose(p, '2014-12', '2024-12'), b = decompose(mock, '2014-12', '2024-12');
    for (const k of ['price_lp_yr', 'pe_lp_yr', 'eps_lp_yr']) close(a[k], b[k], 1e-12, `${label} ${k}`);
  };
  // European Excel CSV: ';' separator, ',' decimals, d.m.yyyy dates (parsed to zero rows before)
  const eu = parseExport(['date;ndx_px;spx_px;ndx_pe;spx_pe', ...months.map(m => [`${day(m)}.${mon(m)}.${yr(m)}`, ...keys.map(k => comma(at(m)[k]))].join(';'))].join('\n'));
  assert.deepEqual([eu.format.sep, eu.format.decimal], [';', ',']);
  assert.ok(eu.notes.includes('数字格式：逗号为小数点') && eu.notes.includes('分隔符：分号'));
  sameValues(eu, 'semicolon+decimal comma');
  // ';' separator with '.' decimals keeps '.'
  const semiDot = parseExport(['date;ndx_px;spx_px;ndx_pe;spx_pe', ...months.map(m => [at(m).date, ...keys.map(k => at(m)[k])].join(';'))].join('\n'));
  assert.equal(semiDot.format.decimal, '.');
  sameValues(semiDot, 'semicolon+decimal dot');
  // US two-digit years m/d/yy in a comma CSV
  sameValues(parseExport(['date,ndx_px,spx_px,ndx_pe,spx_pe', ...months.map(m => [`${mon(m)}/${day(m)}/${yr(m).slice(2)}`, ...keys.map(k => at(m)[k])].join(','))].join('\n')), 'm/d/yy');
  // Bloomberg block paste from a European terminal: tabs, ',' decimals, d/m/yy dates under an explicit Date label
  const dmyy = m => `${day(m)}/${mon(m)}/${yr(m).slice(2)}`;
  const tsv = parseExport(['NDX Index\t\t\t\tSPX Index\t\t', 'Date\tPX_LAST\tPE_RATIO\t\tDate\tPX_LAST\tPE_RATIO',
    ...months.map(m => `${dmyy(m)}\t${comma(at(m).ndx_px)}\t${comma(at(m).ndx_pe)}\t\t${dmyy(m)}\t${comma(at(m).spx_px)}\t${comma(at(m).spx_pe)}`)].join('\n'));
  assert.deepEqual([tsv.format.sep, tsv.format.decimal], ['\t', ',']);
  sameValues(tsv, 'tab+decimal comma+Date label');
  assert.deepEqual(validate(tsv).errors, []);
  assert.equal(parseExport('date,ndx_px,spx_px\n12/31/85,1,1\n1/31/86,2,2').months.join(), '1985-12,1986-01');
});

test('validate names the cause when data lines yield no month instead of listing every column as missing', () => {
  const noDates = validate(parseExport('date,ndx_px,spx_px\nfoo,1,2\nbar,3,4'));
  assert.equal(noDates.errors.length, 1); assert.match(noDates.errors[0], /无法识别日期列或分隔符/);
  const pipes = validate(parseExport('date|ndx_px|spx_px\n2020-01-31|1|2\n2020-02-29|3|4'));
  assert.equal(pipes.errors.length, 1); assert.match(pipes.errors[0], /无法识别日期列或分隔符/);
  const noCols = validate(parseExport('date,foo,bar\n2020-01-31,1,2\n2020-02-29,3,4'));
  assert.equal(noCols.errors.length, 1); assert.match(noCols.errors[0], /未识别任何数据列/);
  assert.ok(validate(parseExport(EXPORT_TEMPLATE_CSV)).errors.some(e => e.includes('缺少必需列 ndx_px')), 'header-only template still lists required columns');
});

test('recipe and export template: Chinese, parseable, no data-derived end date', () => {
  assert.match(RECIPE_TEXT, /=BDH\("NDX Index","PE_RATIO","19850101","\{END\}","period=cm"\)/);
  assert.match(RECIPE_TEXT, /[一-鿿]/);
  const filled = recipeText('2024-02');
  assert.ok(filled.includes('"20240229"') && !filled.includes('{END}'));
  const tpl = parseExport(EXPORT_TEMPLATE_CSV);
  assert.equal(tpl.meta.pe_field, 'PE_RATIO');
  assert.deepEqual(tpl.rows, []);
  assert.ok(validate(tpl).errors.length >= 2);
  assert.deepEqual(EXPORT_TEMPLATE_CSV.split('\n').find(l => l.startsWith('date')).split(','), ['date', ...CANON]);
});
