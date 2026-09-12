import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../docs/assets/js/charts/core.js?v=20260912';
import * as ternary from '../docs/assets/js/charts/ternary.js?v=20260912';
import * as frontier from '../docs/assets/js/charts/frontier.js?v=20260912';
import * as stackedArea from '../docs/assets/js/charts/stackedArea.js?v=20260912';
import * as twoAssetPanels from '../docs/assets/js/charts/twoAssetPanels.js?v=20260912';
import * as areaDiverging from '../docs/assets/js/charts/areaDiverging.js?v=20260912';
import * as lineChart from '../docs/assets/js/charts/lineChart.js?v=20260912';
import * as weightBar from '../docs/assets/js/charts/weightBar.js?v=20260912';
import * as coverageStrip from '../docs/assets/js/charts/coverageStrip.js?v=20260912';
import * as barCell from '../docs/assets/js/charts/barCell.js?v=20260912';
import * as tooltip from '../docs/assets/js/charts/tooltip.js?v=20260912';

const M = '−';
const CHARTS_DIR = new URL('../docs/assets/js/charts/', import.meta.url);

test('month helpers round-trip and year ticks land on Januaries', () => {
  assert.equal(core.monthIndex('1985-01'), 1985 * 12);
  assert.equal(core.monthFromIndex(core.monthIndex('2026-08')), '2026-08');
  assert.equal(core.addMonths('2000-02', 120), '2010-02');
  assert.equal(core.addMonths('1985-01', -1), '1984-12');
  const ticks = core.yearTicks(core.monthIndex('1985-01'), core.monthIndex('2026-08'), 6);
  assert.ok(ticks.length <= 6 && ticks.length >= 2);
  for (const t of ticks) assert.equal(t % 12, 0);
});

test('log ticks follow 1-2-5 and respect the count cap', () => {
  assert.deepEqual(core.logTicks(0.4, 6, 6), [0.5, 1, 2, 5]);
  const wide = core.logTicks(0.3, 200, 6);
  assert.ok(wide.length <= 6 && wide.length >= 2 && wide.includes(1));
  assert.deepEqual(core.logTicks(-1, 5), []);
  assert.deepEqual(core.logTicks(1.1, 1.8), []);
});

test('tick and value formatters', () => {
  assert.equal(core.tickFormatter('pp', 0.02)(0.04), '+4');
  assert.equal(core.tickFormatter('pp', 0.02)(-0.04), `${M}4`);
  assert.equal(core.tickFormatter('pct', 0.005)(0.125), '12.5%');
  assert.equal(core.tickFormatter('pct', 0.05)(0.15), '15%');
  assert.equal(core.tickFormatter('ratio')(2), '×2');
  assert.equal(core.tickFormatter('ratio')(0.5), '×0.5');
  assert.equal(core.tickFormatter('month')(core.monthIndex('1999-01')), '1999');
  assert.equal(core.valueFormatter('pp')(-0.0755), `${M}7.6个百分点`);
  assert.equal(core.valueFormatter('ratio')(2.882), '×2.88');
});

test('nearestIndex, sampling and keyboard stepping', () => {
  assert.equal(core.nearestIndex([0, 1, 2, 3], 2.4), 2);
  assert.equal(core.nearestIndex([0, 1, 2, 3], 2.6), 3);
  assert.equal(core.nearestIndex([], 1), -1);
  assert.deepEqual(core.januaryIndices(['1985-01', '1985-02', '1986-01']), [0, 2]);
  assert.deepEqual(core.yearEndIndices(['1985-01', '1985-12', '1986-06']), [0, 1, 2]);
  const s = core.sampleIndices(100, 11);
  assert.equal(s[0], 0);
  assert.equal(s.at(-1), 99);
  assert.ok(s.length <= 12);
  assert.equal(core.stepIndex('ArrowRight', 3, 10), 4);
  assert.equal(core.stepIndex('ArrowLeft', 0, 10), 0);
  assert.equal(core.stepIndex('ArrowRight', 3, 10, { shift: true, page: 5 }), 8);
  assert.equal(core.stepIndex('End', 3, 10), 9);
  assert.equal(core.stepIndex('x', 3, 10), null);
});

test('layoutLabels never overlaps labels within a row', () => {
  const items = [10, 20, 30, 200, 205].map((x) => ({ x, width: 40 }));
  const out = core.layoutLabels(items, { left: 0, right: 300, gap: 4, maxRows: 2 });
  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      if (out[a].row < 0 || out[a].row !== out[b].row) continue;
      assert.ok(out[a].right + 4 <= out[b].left || out[b].right + 4 <= out[a].left, `labels ${a} and ${b} overlap`);
    }
  }
  assert.ok(out.some((o) => o.row === -1), 'third crowded label is hidden when only two rows exist');
  assert.ok(out.every((o) => o.row < 0 || (o.left >= 0 && o.right <= 300)));
});

test('colour helpers: contrast, ramp ordering, text colour', () => {
  assert.ok(Math.abs(core.contrastRatio('#ffffff', '#000000') - 21) < 1e-9);
  assert.deepEqual(core.parseColor('rgb(42, 120, 214)'), { r: 42, g: 120, b: 214, a: 1 });
  assert.deepEqual(core.parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  const light = ['#cde2fb', '#3987e5', '#0d366b'];
  assert.deepEqual(core.orderRamp(light, '#fcfcfb'), light);
  assert.deepEqual(core.orderRamp(light, '#1a1a19'), [...light].reverse());
  const t = { '--ink': '#0b0b0b', '--surface': '#fcfcfb' };
  assert.equal(core.textOn('#52514e', t), '#fcfcfb');
  assert.equal(core.textOn('#e1e0d9', t), '#0b0b0b');
});

test('fallback palette has no red and dark ramps recede toward the surface', () => {
  const { light, dark } = core.FALLBACK_TOKENS;
  for (const mode of [light, dark]) {
    assert.deepEqual(core.orderRamp([100, 200, 300, 400, 500, 600, 700].map((k) => mode[`--seq-${k}`]), mode['--surface']),
      [100, 200, 300, 400, 500, 600, 700].map((k) => mode[`--seq-${k}`]));
    assert.deepEqual(core.orderRamp([100, 200, 300, 400, 500].map((k) => mode[`--gray-${k}`]), mode['--surface']),
      [100, 200, 300, 400, 500].map((k) => mode[`--gray-${k}`]));
  }
  assert.notEqual(dark['--c-mid'], dark['--axis']);
  assert.notEqual(dark['--c-mid'], dark['--grid']);
});

test('marker shapes produce paths; stroked shapes are flagged', () => {
  for (const shape of ['star', 'diamond', 'triangle', 'square', 'triangleDown', 'ring', 'cross', 'plus', 'circle']) {
    assert.match(core.shapePath(shape, 5), /^M-?\d/);
    assert.ok(core.SHAPE_GLYPH[shape]);
  }
  assert.equal(core.shapePath('star', 5).split('L').length, 10);
  assert.ok(core.STROKED_SHAPES.has('cross') && !core.STROKED_SHAPES.has('star'));
});

test('ternary geometry round-trips and snaps to the lattice', () => {
  const g = ternary.triangle(300, 10, 20);
  for (const w of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.39, 0.44, 0.17]]) {
    const [x, y] = ternary.toXY(w, g);
    ternary.toWeights(x, y, g).forEach((v, i) => assert.ok(Math.abs(v - w[i]) < 1e-9));
  }
  assert.deepEqual(ternary.snapWeights([0.3856, 0.4436, 0.1708], 1), [39, 44, 17]);
  assert.deepEqual(ternary.snapWeights([0.3856, 0.4436, 0.1708], 5), [40, 45, 15]);
  assert.deepEqual(ternary.snapWeights([-0.02, 0.5, 0.52], 1), [0, 49, 51]);
  const s = ternary.snapWeights([0.123, 0.456, 0.421], 1);
  assert.equal(s.reduce((a, b) => a + b, 0), 100);
});

function linearLattice(step = 1) {
  const i = [], j = [], v = [];
  for (let a = 0; a <= 100; a += step) for (let b = 0; a + b <= 100; b += step) { i.push(a); j.push(b); v.push(a); }
  return { i: Uint8Array.from(i), j: Uint8Array.from(j), v: Float32Array.from(v) };
}

test('ternary contours of a linear field are single straight chains', () => {
  const { i, j, v } = linearLattice(1);
  const lut = ternary.latticeLookup(i, j);
  assert.equal(i.length, 5151);
  const lines = ternary.contourLines(lut, v, 50.5, 1);
  assert.equal(lines.length, 1);
  for (const [ndx] of lines[0]) assert.ok(Math.abs(ndx - 50.5) < 1e-9);
  const spx = lines[0].map((pt) => pt[1]);
  assert.ok(Math.min(...spx) < 1e-9 && Math.max(...spx) > 49.4);
  assert.deepEqual(ternary.contourLines(lut, v, 200, 1), []);
});

test('ternary toTable downsamples to 10% steps plus markers', () => {
  const { i, j, v } = linearLattice(1);
  const tbl = ternary.toTable({
    step: 0.01, i, j, values: v, metric: 'cagr',
    contours: [{ values: v, level: 50, label: '夏普=标普500', metric: 'sharpe' }],
    markers: [{ shape: 'star', label: '同波动·收益最高', w: [0.3856, 0.4436, 0.1708] }],
  });
  assert.equal(tbl.rows.length, 66 + 1);
  assert.deepEqual(tbl.columns, ['点', '纳指', '标普', '美债', '年化复合收益', '夏普比率']);
  assert.deepEqual(tbl.rows.at(-1).slice(0, 4), ['★ 同波动·收益最高', '39%', '44%', '17%']);
});

test('frontier TE path interpolation and table', () => {
  const path = [{ k: 0, vol: 0.15, mu: 0.124 }, { k: 0.03, vol: 0.151, mu: 0.128 }, { k: 0.05, vol: 0.151, mu: 0.1294 }];
  const p = frontier.tePoint(path, 0.04);
  assert.ok(Math.abs(p.mu - 0.1287) < 1e-12);
  assert.equal(frontier.tePoint(path, 0.06), null);
  const tbl = frontier.toTable({
    frontier: Array.from({ length: 50 }, (_, k) => ({ mu: 0.06 + k * 0.002, vol: 0.07 + k * 0.003, w: [k / 49, 0, 1 - k / 49] })),
    assets: [{ label: '纳指100', mu: 0.166, vol: 0.233 }],
    markers: [{ shape: 'cross', label: '60/40', mu: 0.098, vol: 0.094, w: [0, 0.6, 0.4] }],
  });
  assert.equal(tbl.rows[0][0], '✕ 60/40');
  assert.equal(tbl.rows[0][1], '纳指 0 / 标普 60 / 美债 40');
  assert.ok(tbl.rows.length <= 1 + 1 + 12);
});

test('stackedArea valuesAt interpolates (pct) and steps (month)', () => {
  const pct = { xFormat: 'pct', x: [0.02, 0.04], series: [{ values: [0.1, 0.3] }, { values: [0.9, 0.7] }] };
  const v = stackedArea.valuesAt(pct, 0.03);
  assert.ok(Math.abs(v[0] - 0.2) < 1e-12 && Math.abs(v[1] - 0.8) < 1e-12);
  const month = { xFormat: 'month', x: ['1996-01', '1997-01'], series: [{ values: [0.4, 0.5] }] };
  assert.deepEqual(stackedArea.valuesAt(month, '1996-07'), [0.4]);
  assert.deepEqual(stackedArea.valuesAt(month, '1998-07'), [0.5]);
  const tbl = stackedArea.toTable({ ...pct, xName: '截距', markers: [{ x: 0.03, label: '无风险利率' }] });
  assert.equal(tbl.columns[0], '截距');
  assert.equal(tbl.rows.length, 2 + 1);
  assert.equal(tbl.rows.at(-1)[0], '无风险利率 3.00%');
  assert.equal(tbl.rows.at(-1)[1], '20.0%');
});

test('twoAssetPanels merges coincident guides and tabulates them first', () => {
  const merged = twoAssetPanels.mergeGuides([
    { x: 0.5909, label: '收益=标普500' }, { x: 0.59094, label: '收益≥标普500·夏普最高' }, { x: 0.1496, label: '夏普=标普500' },
  ]);
  assert.deepEqual(merged.map((g) => g.labels.length), [1, 2]);
  const x = Float64Array.from({ length: 1001 }, (_, i) => i / 1000);
  const tbl = twoAssetPanels.toTable({
    x, xLabel: '纳指100权重', guides: [{ x: 0.5909, label: '收益=标普500' }],
    panels: [{ label: '夏普比率', values: Array.from(x, (v) => 0.5 + v / 10), yFormat: 'num' }, { label: '年化复合收益', values: Array.from(x), yFormat: 'pct' }],
  });
  assert.equal(tbl.rows[0][0], '收益=标普500 59.1%');
  assert.equal(tbl.rows[0][2], '59.10%');
  assert.equal(tbl.rows.length, 1 + 11);
});

test('area and line tables downsample to Januaries and year-ends', () => {
  const months = Array.from({ length: 36 }, (_, k) => core.addMonths('1985-01', k));
  const a = areaDiverging.toTable({ x: months, values: months.map((_, k) => (k - 10) / 1000) });
  assert.deepEqual(a.rows.map((r) => r[0]), ['1985-01', '1986-01', '1987-01']);
  assert.equal(a.rows[0][1], `${M}1.0`);
  const l = lineChart.toTable({ x: months, yFormat: 'ratio', series: [{ label: '纳指100 ÷ 标普500', values: months.map(() => 2.88) }] });
  assert.deepEqual(l.rows.map((r) => r[0]), ['1985-01', '1985-12', '1986-12', '1987-12']);
  assert.equal(l.rows[0][1], '×2.88');
});

test('weightBar, coverageStrip and barCell helpers', () => {
  const wb = weightBar.toTable({ w: [0.3856, 0.4436, 0.1708], whiskers: { p10: [0, 0.38, 0], p50: [0.34, 0.5, 0.14], p90: [0.45, 1, 0.18] } });
  assert.deepEqual(wb.rows[0], ['纳指100', '39%', '0%', '34%', '45%']);
  const cs = coverageStrip.toTable({ series: [{ label: '纳指100 含息', segments: [{ from: '1985-02', to: '1999-03', status: 'estimated' }] }] });
  assert.deepEqual(cs.rows[0], ['纳指100 含息', '1985-02', '1999-03', '估算']);
  assert.deepEqual(barCell.domainOf([-1.5, 4.1, null]), [-1.5, 4.1]);
  const g = barCell.barGeometry(-1, [-2, 2]);
  assert.deepEqual([g.zero, g.left, g.width, g.sign], [50, 25, 25, -1]);
  assert.equal(barCell.barGeometry(null, [-2, 2]).width, 0);
  assert.equal(barCell.FORMATS.lp(-0.83), `${M}0.8`);
});

test('chart modules follow the static contract', () => {
  const files = fs.readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.js'));
  for (const f of ['tooltip.js', 'core.js', 'areaDiverging.js', 'lineChart.js', 'frontier.js', 'stackedArea.js', 'ternary.js', 'twoAssetPanels.js', 'weightBar.js', 'barCell.js', 'coverageStrip.js']) {
    assert.ok(files.includes(f), `${f} exists`);
  }
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, CHARTS_DIR), 'utf8');
    for (const spec of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) assert.match(spec[1], /\?v=20260912$/, `${f}: ${spec[1]}`);
    assert.doesNotMatch(src, /d3\.(csv|tsv)Parse|innerHTML|new Function|eval\(/, f);
    assert.doesNotMatch(src, /#e34948|#e66767|#d03b3b|['"]red['"]/i, `${f} must not use red`);
    assert.doesNotMatch(src, /^(const|let|var)\s+\w+\s*=\s*(globalThis|window)\.d3/m, `${f} reads d3 at module top level`);
  }
  for (const mod of [areaDiverging, lineChart, frontier, stackedArea, ternary, twoAssetPanels, weightBar, coverageStrip]) {
    assert.equal(typeof mod.create, 'function');
    assert.equal(typeof mod.toTable, 'function');
    const empty = mod.toTable({});
    assert.ok(Array.isArray(empty.columns) && Array.isArray(empty.rows));
  }
  assert.equal(typeof barCell.render, 'function');
});

test('stackedArea table lists the given rebalance months and unstacked extra columns', () => {
  const months = Array.from({ length: 36 }, (_, k) => core.addMonths('1995-12', k));
  const at = (m) => (m < '1997-01' ? 0 : m < '1998-01' ? 1 : 2);
  const props = {
    xFormat: 'month', x: months, tableX: ['1996-01', '1997-01', '1998-01'],
    series: [{ label: '纳指100', values: months.map((m) => [0.1, 0.2, 0.3][at(m)]) }, { label: '标普500', values: months.map((m) => [0.9, 0.8, 0.7][at(m)]) }],
    extra: [{ label: '杠杆倍数', format: 'multiple', values: months.map((m) => [1.71, 2.5, 0.82][at(m)]) }],
  };
  const tbl = stackedArea.toTable(props);
  assert.deepEqual(tbl.columns, ['调仓月份', '纳指100', '标普500', '杠杆倍数']);
  assert.deepEqual(tbl.rows, [['1996-01', '10.0%', '90.0%', '1.71倍'], ['1997-01', '20.0%', '80.0%', '2.50倍'], ['1998-01', '30.0%', '70.0%', '0.82倍']]);
  const plain = stackedArea.toTable({ ...props, tableX: undefined, extra: undefined });
  assert.equal(plain.columns.length, 3);
  assert.equal(plain.rows[0][0], '1995-12');
});

test('a pinned tooltip unpins when the page scrolls and then yields to other charts', (t) => {
  const listeners = {};
  const mk = (doc) => ({ ownerDocument: doc, style: {}, attrs: {}, children: [], hidden: false, isConnected: true, className: '', textContent: '',
    replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    getBoundingClientRect: () => ({ width: 120, height: 40 }), contains: () => false, addEventListener() {} });
  const doc = { querySelector: () => null, getElementById: () => null,
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); } };
  doc.createElement = () => mk(doc);
  doc.head = mk(doc);
  doc.body = mk(doc);
  globalThis.document = doc;
  t.after(() => { delete globalThis.document; });
  const ternaryOwner = {}, lineOwner = {};
  let unpinned = 0;
  tooltip.show({ x: 10, y: 10, owner: ternaryOwner, pin: true, title: '纳指 39 / 标普 44 / 美债 17', rows: [{ value: '0.647', label: '夏普比率' }], onUnpin: () => { unpinned += 1; } });
  assert.ok(tooltip.isPinned(ternaryOwner));
  assert.equal(listeners.scroll?.length, 1);
  for (const fn of [...listeners.scroll]) fn({});
  assert.equal(tooltip.isPinned(), false);
  assert.equal(unpinned, 1);
  assert.equal(listeners.scroll.length, 0, 'scroll listener leaves with the pin');
  tooltip.show({ x: 50, y: 50, owner: lineOwner, title: '2000-02', rows: [{ value: '×1.20', label: '规则 ÷ 标普500' }] });
  const node = doc.body.children.at(-1);
  assert.equal(node.children[0].textContent, '2000-02');
  assert.equal(node.hidden, false);
});
