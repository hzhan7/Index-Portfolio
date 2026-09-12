// SECTIONS lane: copy templates (typography, wording flips) and section modules rendered into a minimal fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const history = read('docs/data/history.json');
const valuation = read('docs/data/valuation.json');
const data = { history, valuation };

const format = await import('../docs/assets/js/lib/format.js');
const { handle } = await import('../docs/assets/js/engine/jobs.js');
const { DEFAULT_STATE, RULE_IDS } = await import('../docs/assets/js/engine/params.js');
const decompEngine = await import('../docs/assets/js/engine/decomp.js');
const bbgEngine = await import('../docs/assets/js/engine/bbg.js');
const { createCopy, text, addUp } = await import('../docs/assets/js/ui/copy.js');

const KINDS = ['context', 'sample', 'alloc', 'robust'];
const run = (over = {}, kinds = KINDS) => {
  const state = { ...DEFAULT_STATE, ...over };
  return { state, bundles: Object.fromEntries(kinds.map((kind) => [kind, handle({ kind, state }, data)])) };
};
const DEF = run();
const C = createCopy(format);
const clone = (x) => structuredClone(x);

function assertTypography(s, where) {
  assert.ok(!/ %/.test(s), `${where}: ASCII space before %: ${s}`);
  assert.ok(!/(^|[^0-9A-Za-z_])-\d/.test(s), `${where}: ASCII hyphen used as minus: ${s}`);
  assert.ok(!/\d\s*[–~]\s*[−+]?\d/.test(s), `${where}: range must use ～: ${s}`);
  assert.ok(!/NaN|undefined|\[object|Infinity/.test(s), `${where}: broken value: ${s}`);
  // notional weights of a levered row carry （x倍杠杆） and may sum above 100; a de-levered row adds its cash leg to 100
  for (const m of s.matchAll(/纳指 (\d+) \/ 标普 (\d+) \/ 美债 (\d+)(?!\d|（[\d.]+倍杠杆）| \+ 现金)/g)) assert.equal(+m[1] + +m[2] + +m[3], 100, `${where}: weights ${m[0]}`);
  for (const m of s.matchAll(/纳指 (\d+) \/ 标普 (\d+) \/ 美债 (\d+) \+ 现金 (\d+)/g)) assert.equal(+m[1] + +m[2] + +m[3] + +m[4], 100, `${where}: weights + cash ${m[0]}`);
}
const cardText = (c) => text([c.eyebrow, ' ', c.big, ' ', c.lines, ' ', c.small ?? []]);

test('default copy: U+2212, no space before %, ～ ranges, weights sum to 100', () => {
  const { sample, context, alloc, robust } = DEF.bundles;
  const split = decompEngine.splitAtM0(context.decomp.breakEven, 2);
  const outputs = {
    answer: C.heroAnswer(sample), meta: C.heroMeta(sample, DEF.state).line, chips: C.heroMeta(sample, DEF.state).chips.map((c) => c.text),
    card1: cardText(C.card1(sample)), card2: cardText(C.card2(context)), card3: cardText(C.card3(context)), card4: cardText(C.card4(alloc, robust, DEF.state)),
    rollingTitle: C.rollingTitle(context), rollingAnnotation: C.rollingAnnotation(context), decomp: C.decompAnswer(context), slider: C.sliderReadout(split),
    capm: C.capmCaption(alloc), intercept: C.interceptCaption(alloc), two: C.twoAssetStatus(alloc.rules.twoAsset, [0, 2]),
    msf: C.maxSharpeNote(robust, DEF.state), prob: C.probLine(robust.byRule.isoVolTe.bootstrap, 'isoVolTe'),
    bootstrap: C.bootstrapRows(robust.byRule.isoVolTe.bootstrap, 'isoVolTe'), muShift: C.muShiftLine(alloc.rules.isoVolTe) ?? [],
    y10: C.y10Header(sample, alloc), flatTop: C.flatTopLine(alloc.rules.isoVolTe) ?? [],
  };
  for (const [k, segs] of Object.entries(outputs)) assertTypography(text(segs), k);
  const all = Object.values(outputs).map((s) => text(s)).join('\n');
  assert.ok(all.includes('−'), 'negative values use U+2212');
  assert.ok(all.includes('～'), 'ranges use ～');
  const iso = alloc.rules.isoVolTe;
  assert.ok(text(outputs.card4).includes(format.fmtWeights(iso.w)));
  // segments carry data-k and a finite data-v whenever a raw value exists
  for (const seg of [outputs.answer, outputs.card1, outputs.decomp].flat(Infinity)) {
    if (seg && typeof seg === 'object') assert.ok(seg.k && (seg.v == null || Number.isFinite(seg.v)), JSON.stringify(seg));
  }
});

test('answer line and card 1 flip with the data', () => {
  const s0 = DEF.bundles.sample;
  const h = s0.h2h;
  const sharpeLeader = h.ndx.sharpe > h.spx.sharpe ? '纳指100' : '标普500';
  const cagrLeader = h.ndx.cagr >= h.spx.cagr ? '纳指100' : '标普500';
  const ans = text(C.heroAnswer(s0));
  assert.ok(ans.startsWith(`收益选${cagrLeader}：年化 ${format.fmtPct(Math.max(h.ndx.cagr, h.spx.cagr))}`), ans);
  assert.ok(text(C.card1(s0).big).startsWith(`夏普 ${sharpeLeader}`));

  const up = clone(s0);
  up.h2h.ndx.cagr = up.h2h.spx.cagr + 0.03;
  up.h2h.ndx.sharpe = up.h2h.spx.sharpe + 0.1;
  up.h2h.sharpeDiffCI = { ...up.h2h.sharpeDiffCI, point: 0.1, lo: -0.05, hi: 0.25 };
  assert.match(text(C.heroAnswer(up)), /^收益选纳指100：.*风险调整后也是纳指100：夏普 .*（95%区间含0）。$/);
  assert.ok(text(C.card1(up).big).startsWith('夏普 纳指100'));

  const split = clone(up);
  split.h2h.spx.cagr = split.h2h.ndx.cagr + 0.01;
  split.h2h.sharpeDiffCI = { ...split.h2h.sharpeDiffCI, lo: 0.02, hi: 0.3 };
  const t = text(C.heroAnswer(split));
  assert.match(t, /^收益选标普500：/);
  assert.match(t, /风险调整后纳指100更优：.*（95%区间不含0）。$/);

  const lever = clone(s0);
  lever.h2h.volMatched.levered = true;
  assert.ok(text(C.card1(lever).lines[1]).startsWith('加杠杆到标普波动后'));
});

test('losing-run wording follows rolling.losingRuns', () => {
  const ctx = DEF.bundles.context;
  const r = ctx.rolling;
  const top = r.losingRuns[0];
  assert.ok(text(C.card2(ctx).lines[0]).includes(`跑输主要在 ${top.from}～${top.to}（${top.n}/${r.nLose}）`));
  const none = clone(ctx);
  Object.assign(none.rolling, { nLose: 0, losingRuns: [] });
  assert.ok(text(C.rollingAnnotation(none)).endsWith('没有跑输的买入月份'));
  const single = clone(ctx);
  single.rolling.losingRuns = [{ from: '1997-05', to: '1997-05', n: 1 }];
  single.rolling.nLose = 1;
  assert.ok(text(C.card2(single).lines[0]).includes('跑输主要在 1997-05（1/1）'));
  const vm = clone(ctx);
  vm.rolling.volMatched = true;
  assert.ok(!text(C.card2(vm).lines).includes('同波动调整后跑赢'), 'vol-matched view does not repeat the vol-matched win rate');
  const empty = clone(ctx);
  Object.assign(empty.rolling, { n: 0, nWin: 0, winRate: null, worst: null });
  assert.match(text(C.rollingTitle(empty)), /窗口不足$/);
});

test('estimate chip only when the sample touches estimated NDX dividends', () => {
  const chips = (sb, st) => C.heroMeta(sb, st).chips.map((c) => text(c.text));
  assert.ok(chips(DEF.bundles.sample, DEF.state).some((c) => c.startsWith('含估算股息：纳指100年化 ±')));
  for (const start of ['1999-03', '1999-04']) {
    const late = run({ start }, ['sample']);
    const cs = chips(late.bundles.sample, late.state);
    assert.ok(!cs.some((c) => c.includes('含估算股息')), `start ${start}: ${cs}`);
    assert.ok(cs.includes('10年美债为模型'));
  }
  const pr = run({ basis: 'pr' }, ['sample']);
  assert.ok(!chips(pr.bundles.sample, pr.state).some((c) => c.includes('含估算股息')));
});

test('tangency CAPM caption, intercept caption and two-asset statuses', () => {
  const alloc = DEF.bundles.alloc;
  const t = alloc.rules.tangency;
  const capm = text(C.capmCaption(alloc));
  if (t.atRf?.w) assert.ok(capm.startsWith(`CAPM 的切点默认你会加杠杆：截距 ${format.fmtPct(t.cRf)} 时切点 ${format.fmtWeights(t.atRf.w)}；`), capm);
  else assert.ok(capm.startsWith('CAPM 的切点默认你会加杠杆：'), capm);
  assert.ok(capm.includes(`加 ${format.fmtNum(t.levered.L, 1)} 倍杠杆到标普波动 → 年化 ${format.fmtPct(t.levered.stats.cagr)}`));
  // the levered portfolio is the tangency at the borrowing rate (rf + spread); the caption names its own weights
  const cUsed = Number.isFinite(t.levered.cUsed) ? t.levered.cUsed : t.cRf + t.levered.spread;
  assert.ok(capm.includes(`融资利率 ${format.fmtPct(cUsed)}`) && capm.includes(`${format.fmtWeights(t.levered.w)}，加 `), capm);
  const noSpread = run({ rule: 'tangency', spread: 0 }, ['alloc']).bundles.alloc;
  const capm0 = text(C.capmCaption(noSpread));
  assert.ok(capm0.startsWith(`CAPM 的切点默认你会加杠杆：截距 ${format.fmtPct(noSpread.rules.tangency.cRf)} 时切点 ${format.fmtWeights(noSpread.rules.tangency.levered.w)}；加 `), capm0);
  assert.ok(!capm0.includes('融资利率'), capm0);
  // c* is anchored to the vol target and split into rf + the cost of no leverage; the displayed split adds up
  assert.ok(capm.includes(`不加杠杆、波动定在标普500 ${format.fmtPct(alloc.ctx.sigmaSpx)} 时，截距 = 无风险利率 ${format.fmtPct(t.cRf)} + 不能加杠杆的代价 `), capm);
  assert.ok(capm.includes(` = ${format.fmtPct(t.implied.c)}，切点就是 ${format.fmtWeights(t.implied.w)}。`), capm);
  const split = /无风险利率 ([\d.]+)% \+ 不能加杠杆的代价 ([\d.]+)个百分点 = ([\d.]+)%/.exec(capm);
  assert.equal((Math.round((+split[1] + +split[2]) * 10) / 10).toFixed(1), split[3], capm);
  // the default rule is that tangency plus the TE cap
  assert.ok(capm.includes(`默认再加跟踪误差≤${format.fmtPct(alloc.rules.isoVolTe.params.teCap, 0)} → ${format.fmtWeights(alloc.rules.isoVolTe.w)}，年化`), capm);
  const interval = clone(alloc);
  interval.rules.tangency.implied.atLeast = true;
  assert.ok(text(C.capmCaption(interval)).includes(`= ≥${format.fmtPct(t.implied.c)}`));
  const ic = text(C.interceptCaption(alloc));
  assert.ok(ic.includes('美债低于一半') && ic.includes('纳指100全仓') && ic.includes('｜'), ic);

  const ta = alloc.rules.twoAsset;
  assert.ok(text(C.twoAssetStatus(ta, [0, 2])).startsWith('夏普=标普500：纳指100 '));
  const none = clone(ta);
  Object.assign(none, { status: 'none', roots: { ...none.roots, sharpeEqSpx: [] } });
  assert.match(text(C.twoAssetStatus(none, [0, 2])), /^夏普最高 .* 仍低于标普500 .*，配不出同夏普组合$/);
  const above = clone(ta);
  Object.assign(above, { status: 'all-above', roots: { ...above.roots, sharpeEqSpx: [0.2] } });
  assert.equal(text(C.twoAssetStatus(above, [1, 2])), `标普500占比 ≥ ${format.fmtPct(0.2)} 时夏普高于标普500`);
  above.roots.trivial = [1]; // 100% is 标普500 itself, where Sharpe only equals it: an open interval
  assert.equal(text(C.twoAssetStatus(above, [1, 2])), `标普500占比在 ${format.fmtPct(0.2)} 与 100% 之间时夏普高于标普500`);
  const real = run({ rule: 'twoAsset', pair: [1, 2] }, ['alloc']).bundles.alloc.rules.twoAsset;
  const s = text(C.twoAssetStatus(real, [1, 2]) ?? []);
  if (real.status === 'all-above') assert.ok(s.endsWith('时夏普高于标普500') && !s.includes('都高于'), s);
  if (real.status === 'none') assert.ok(s.endsWith('配不出同夏普组合'), s);
});

test('isoVolTe infeasible message, insufficient and pending walk-forward', () => {
  const inf = run({ volMult: 0.7, teCap: 0.02 }, ['alloc']);
  const iso = inf.bundles.alloc.rules.isoVolTe;
  assert.equal(iso.status, 'infeasible');
  const c4 = C.card4(inf.bundles.alloc, null, inf.state);
  assert.equal(text(c4.big), '—');
  assert.match(text(c4.lines[0]), /^波动上限 0\.70× 时跟踪误差上限至少 \d+\.\d%$/);
  const chip = C.teChipFor(iso.feasibility.minTeForVolCap);
  assert.ok(chip.value == null || chip.value >= iso.feasibility.minTeForVolCap - 1e-9);

  assert.equal(text(C.card4(DEF.bundles.alloc, null, DEF.state).lines[1]), '样本外计算中…');
  const short = run({ start: '2024-01' }, ['alloc', 'robust']);
  assert.equal(short.bundles.robust.byRule.isoVolTe.walkForward.status, 'insufficient');
  assert.equal(text(C.card4(short.bundles.alloc, short.bundles.robust, short.state).lines[1]), '样本外不足36个月');
  assert.equal(text(C.maxSharpeNote(short.bundles.robust, short.state)), '样本外不足36个月');
  const ok = text(C.card4(DEF.bundles.alloc, DEF.bundles.robust, DEF.state).lines[1]);
  assert.ok(ok.startsWith(`样本外（每年1月用过去10年重估，${DEF.bundles.robust.byRule.isoVolTe.walkForward.firstOos}起）：年化 `), ok);
});

// ---------- sections ----------
const SECTION_FILES = ['hero', 'compare', 'decomp', 'allocation', 'robust', 'methods'];

test('section modules import cleanly without a DOM', async () => {
  assert.equal(globalThis.document, undefined);
  for (const name of [...SECTION_FILES, 'allocation-params', 'common', 'dom']) {
    const mod = await import(`../docs/assets/js/ui/sections/${name}.js?v=20260912`);
    if (SECTION_FILES.includes(name)) assert.equal(typeof mod.mount, 'function', name);
  }
  await import('../docs/assets/js/ui/table.js?v=20260912');
});

function fakeDocument() {
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class Node {
    constructor() { this.childNodes = []; this.parentNode = null; }
    appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
    replaceChildren(...nodes) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; nodes.forEach((n) => this.appendChild(n)); }
    remove() { this.parentNode?.removeChild(this); }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (v != null && v !== '') this.appendChild(doc.createTextNode(String(v))); }
  }
  class Text extends Node { constructor(t) { super(); this.nodeType = 3; this.data = t; } get textContent() { return this.data; } set textContent(v) { this.data = String(v); } }
  class Element extends Node {
    constructor(tag) {
      super();
      Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), attributes: new Map(), dataset: {}, listeners: {}, className: '', hidden: false, disabled: false, value: '', ownerDocument: doc });
      this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    }
    get classList() {
      const list = () => this.className.split(/\s+/).filter(Boolean);
      return { add: (...c) => { this.className = [...new Set([...list(), ...c])].join(' '); }, contains: (c) => list().includes(c),
        remove: (...c) => { this.className = list().filter((x) => !c.includes(x)).join(' '); },
        toggle: (c, force) => { const on = force ?? !list().includes(c); this.className = [...list().filter((x) => x !== c), ...(on ? [c] : [])].join(' '); return on; } };
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    removeAttribute(k) { this.attributes.delete(k); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...extra }); }
    click() { this.dispatch('click'); }
    querySelectorAll(sel) {
      const out = [];
      const match = (e) => (sel.startsWith('[') ? e.attributes.has(sel.slice(1, -1)) : e.tagName === sel.toUpperCase());
      const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (match(c)) out.push(c); walk(c); } });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  const doc = { createElement: (t) => new Element(t), createTextNode: (t) => new Text(String(t)) };
  doc.body = new Element('body');
  return doc;
}

const elements = (n, out = []) => { if (n.nodeType === 1) { out.push(n); n.childNodes.forEach((c) => elements(c, out)); } return out; };
// Node boundaries become line breaks so adjacent table cells never read as one number.
// Source titles/notes (li[data-source]) are quoted verbatim from the data files and skipped.
const textOf = (n) => (n.nodeType === 3 ? n.data : n.dataset.source !== undefined ? '' : n.childNodes.map(textOf).join('\n'));
const flush = () => new Promise((r) => setTimeout(r, 0));

// data-k is a bundle path, or derived:<path|number>(<op><path|number>)* evaluated left to right (copy.js header).
const resolvePath = (b, path) => path.split('.').reduce((cur, s) => (cur == null ? undefined : cur[s]), b);
function resolveKey(bundles, k) {
  if (!k.startsWith('derived:')) return resolvePath(bundles, k);
  let acc = null, op = null;
  for (const tok of k.slice('derived:'.length).split(/([+\-*/])/)) {
    if (/^[+\-*/]$/.test(tok)) { op = tok; continue; }
    const x = /^\d+(\.\d+)?$/.test(tok) ? Number(tok) : resolvePath(bundles, tok);
    if (typeof x !== 'number') return undefined;
    acc = acc == null ? x : op === '+' ? acc + x : op === '-' ? acc - x : op === '*' ? acc * x : acc / x;
  }
  return acc;
}
const hiddenUp = (e) => { for (let x = e; x; x = x.parentNode) if (x.hidden === true) return true; return false; };
// Every visible number with data-k/data-v resolves to exactly that raw value (slider readouts and @ path reads excepted).
function assertKeysResolve(roots, bundles, where) {
  for (const [name, root] of Object.entries(roots)) {
    for (const e of elements(root)) {
      const { k, v } = e.dataset;
      if (k == null || v === undefined || hiddenUp(e) || k.startsWith('decomp.split') || k.includes('@')) continue;
      const r = resolveKey(bundles, k);
      assert.equal(typeof r, 'number', `${name}/${where}: data-k ${k} resolves to ${Array.isArray(r) ? 'an array' : typeof r} (text ${e.textContent})`);
      assert.ok(Math.abs(r - Number(v)) <= 1e-9 * Math.max(1, Math.abs(r)), `${name}/${where}: data-k ${k} is ${r} but data-v ${v} (text ${e.textContent})`);
    }
  }
}

test('sections render real bundles for every rule into a fake DOM', async (t) => {
  const doc = fakeDocument();
  globalThis.document = doc;
  t.after(() => { delete globalThis.document; });

  const chartNames = ['areaDiverging', 'lineChart', 'frontier', 'stackedArea', 'ternary', 'twoAssetPanels', 'weightBar', 'barCell', 'coverageStrip'];
  const real = {};
  for (const n of chartNames) real[n] = await import(`../docs/assets/js/charts/${n}.js`).catch(() => null);
  const calls = [];
  const charts = Object.fromEntries(chartNames.map((n) => [n, {
    create: () => ({ update: (p) => calls.push([n, p]), destroy() {} }),
    toTable: (p) => real[n]?.toTable?.(p) ?? { columns: [], rows: [] },
    render: (td, o) => { td.textContent = o.format(o.value); },
  }]));
  let state = { ...DEF.state };
  const patches = [], toasts = [];
  const api = { getState: () => state, setState: (p) => patches.push(p), toast: (m) => toasts.push(m), scrollTo() {},
    format, charts, engine: { decomp: decompEngine, bbg: bbgEngine }, data };

  const roots = {}, handles = {};
  for (const name of SECTION_FILES) {
    const root = doc.createElement('section');
    root.appendChild(doc.createElement(name === 'hero' ? 'h1' : 'h2'));
    const mountEl = doc.createElement('div');
    mountEl.setAttribute('data-mount', '');
    root.appendChild(mountEl);
    const { mount } = await import(`../docs/assets/js/ui/sections/${name}.js?v=20260912`);
    roots[name] = root;
    handles[name] = mount(root, api);
  }
  const latest = DEF.bundles.sample.sample.end;
  const view = (st, b, extra = {}) => ({ state: st, latest, bundles: b, pending: {}, progress: { robust: null }, errors: {}, ...extra });

  // first paint: nothing computed yet
  for (const h of Object.values(handles)) h.render(view(state, { context: null, sample: null, alloc: null, robust: null }, { pending: { context: true, sample: true, alloc: true, robust: true } }));

  for (const rule of RULE_IDS) {
    const cur = rule === 'isoVolTe' ? DEF : run({ rule }, ['alloc', 'robust']);
    state = { ...DEF.state, rule };
    const b = { ...DEF.bundles, alloc: cur.bundles.alloc, robust: cur.bundles.robust };
    const from = calls.length;
    for (const h of Object.values(handles)) h.render(view(state, b));
    await flush();
    for (const [name, root] of Object.entries(roots)) {
      assertTypography(textOf(root), `${name}/${rule}`);
      for (const e of elements(root)) {
        if (e.dataset.v !== undefined) {
          assert.ok(e.dataset.k, `${name}/${rule}: data-v without data-k`);
          assert.ok(Number.isFinite(Number(e.dataset.v)), `${name}/${rule}: data-v ${e.dataset.v}`);
        }
      }
    }
    assert.ok(!roots.hero.textContent.includes('计算中'), `hero complete for ${rule}`);
    assertKeysResolve(roots, b, rule);
    if (rule === 'tangency') {
      // §4 walk-forward weights: risky weights stack to 100% (no clipping), leverage rides along, the table lists rebalance months
      const wf = b.robust.byRule.tangency.walkForward;
      const p = calls.slice(from).filter(([n, q]) => n === 'stackedArea' && q.xFormat === 'month').at(-1)?.[1];
      assert.ok(p, 'walk-forward weights chart updated');
      for (let i = 0; i < p.x.length; i++) assert.ok(Math.abs(p.series.reduce((s, se) => s + se.values[i], 0) - 1) < 1e-6, `stack at ${p.x[i]}`);
      assert.equal(p.extra[0].label, '杠杆倍数');
      const tbl = real.stackedArea.toTable(p);
      assert.deepEqual(tbl.rows.map((r) => r[0]), wf.weights.map((w) => w.month));
      assert.equal(tbl.rows[0].at(-1), `${format.fmtNum(wf.weights[0].L, 2)}倍`);
      assert.match(roots.robust.textContent, /杠杆 \d\.\d{2}～\d\.\d{2}倍（最近 \d{4}-\d{2} \d\.\d{2}倍）/);
    }
  }

  assert.ok(calls.length > 0, 'charts received props');
  for (const [n, p] of calls) {
    assert.ok(p.key !== undefined, `${n} props carry a key`);
    if (real[n]?.toTable) assert.doesNotThrow(() => real[n].toTable(p), `${n}.toTable accepts section props`);
  }

  // asked-table row click selects the matching tab
  const rows = elements(roots.allocation).filter((e) => e.tagName === 'TR' && e.attributes.has('tabindex'));
  const iso = rows.find((r) => r.textContent.startsWith('同波动·收益最高'));
  iso.click();
  assert.deepEqual(patches.at(-1), { rule: 'isoVolTe' });

  // 你问过的组合: 标普500 / 纳指100 / 60/40 carry out-of-sample CAGR from the 同波动 walk-forward; the levered row names the assets
  for (const ref of ['spx', 'ndx', 'sixty40']) {
    assert.ok(elements(roots.allocation).some((e) => e.dataset.k === `robust.byRule.isoVolTe.walkForward.stats.${ref}.cagr`), `OOS for ${ref}`);
  }
  assert.match(roots.allocation.textContent, /纳指 \d+ \/ 标普 \d+ \/ 美债 \d+（\d\.\d倍杠杆）/);
  // hero meta chip reads as one run; KPI cells carry column names for the stacked mobile layout
  assert.match(roots.hero.textContent, /含估算股息：纳指100年化 ±\d\.\d{2}个百分点/);
  assert.ok(elements(roots.compare).some((e) => e.tagName === 'TD' && e.dataset.label === '差值'), 'KPI data-label');
  // decade rows show their period once; recovery wording follows the engine (trough → recovery)
  for (const th of elements(roots.compare).filter((e) => e.tagName === 'TH' && /^\d{4}-\d{2}～\d{4}-\d{2}/.test(e.textContent))) {
    assert.ok(!/(\d{4}-\d{2}～\d{4}-\d{2}).*\1/.test(th.textContent), `period shown once: ${th.textContent}`);
  }
  assert.match(roots.compare.textContent, /谷底后 \d+ 个月回本/);

  // errors surface inline; pending keeps content with .is-pending
  handles.allocation.render(view(state, DEF.bundles, { errors: { alloc: { code: 'E_INFEASIBLE', message: '测试错误' } }, pending: { alloc: true } }));
  assert.ok(roots.allocation.textContent.includes('计算失败：测试错误'));
  assert.ok(elements(roots.allocation).some((e) => e.classList.contains('is-pending')));

  // a robust job still running (or failed) never lends the previous state's out-of-sample numbers to hero or §3
  state = { ...DEF.state };
  for (const extra of [{ pending: { robust: true } }, { errors: { robust: { code: 'E_TEST', message: '测试' } } }]) {
    for (const name of ['hero', 'allocation']) handles[name].render(view(state, DEF.bundles, extra));
    await flush();
    for (const name of ['hero', 'allocation']) {
      // hidden tab panels re-render when their tab is shown (their render key includes the robust readiness)
      const shown = elements(roots[name]).filter((e) => !hiddenUp(e));
      assert.deepEqual(shown.map((e) => e.dataset.k).filter((k) => k?.startsWith('robust.')), [], `${name}: ${JSON.stringify(extra)}`);
    }
    assert.match(roots.hero.textContent, extra.pending ? /样本外计算中…/ : /样本外计算失败/);
    assert.match(roots.allocation.textContent, extra.pending ? /计算中…/ : /计算失败/);
  }
  // 50/50 reads walkForward.stats.ndxSpx5050 when the engine provides it
  const with5050 = clone(DEF.bundles.robust);
  with5050.byRule.isoVolTe.walkForward.stats.ndxSpx5050 = { ...with5050.byRule.isoVolTe.walkForward.stats.spx, cagr: 0.1234 };
  handles.allocation.render(view(state, { ...DEF.bundles, robust: with5050 }));
  await flush();
  assert.ok(elements(roots.allocation).some((e) => e.dataset.k === 'robust.byRule.isoVolTe.walkForward.stats.ndxSpx5050.cagr' && e.textContent.startsWith('12.34%')), '50/50 OOS cell');

  // copy branches outside the default: 标普500+美债, c* below rf (2016-08), de-levered tangency (价格口径), infeasible 同波动
  for (const over of [{ rule: 'twoAsset', pair: [1, 2] }, { start: '2016-08', rule: 'tangency' }, { basis: 'pr', rule: 'tangency' }, { volMult: 0.7, teCap: 0.02 }]) {
    const cur = run(over);
    state = cur.state;
    for (const h of Object.values(handles)) h.render(view(state, cur.bundles));
    await flush();
    const where = JSON.stringify(over);
    for (const [name, root] of Object.entries(roots)) assertTypography(textOf(root), `${name}/${where}`);
    assertKeysResolve(roots, cur.bundles, where);
    if (over.volMult) assert.ok(roots.robust.textContent.includes('重抽样无可行解') && !/0～0（中位 0）/.test(roots.robust.textContent), roots.robust.textContent);
  }
});

test('loadChart resolves create() charts and the render-only barCell helper', async () => {
  const { loadChart } = await import('../docs/assets/js/ui/sections/common.js?v=20260912');
  const bar = { render() {} }, chart = { create() {} };
  assert.equal(await loadChart({ charts: { barCell: () => Promise.resolve(bar) } }, 'barCell'), bar);
  assert.equal(await loadChart({ charts: { frontier: () => Promise.resolve(chart) } }, 'frontier'), chart);
  assert.equal(await loadChart({ charts: { lazy: () => Promise.resolve({ default: chart }) } }, 'lazy'), chart);
});

test('chart CSV cells are machine-readable numbers', async () => {
  const { csvValue, toCsv } = await import('../docs/assets/js/ui/table.js?v=20260912');
  assert.deepEqual(['−0.7', '+1.6', '12.45%', '−3.8个百分点', '×2.88', '—', '1996-01', '纳指 39 / 标普 44 / 美债 17', 0.5].map(csvValue),
    ['-0.7', '1.6', '12.45%', '-3.8', '2.88', '', '1996-01', '纳指 39 / 标普 44 / 美债 17', 0.5]);
  assert.equal(toCsv(['a', 'b'], [['x,y', 1]]), '﻿a,b\r\n"x,y",1\r\n');
});

test('two-asset copy when every mix beats 标普500 Sharpe; levered notional label', () => {
  const ta = run({ basis: 'pr', rule: 'twoAsset', pair: [0, 1] }, ['alloc']).bundles.alloc.rules.twoAsset;
  if (ta.status === 'none') {
    const s = text(C.twoAssetStatus(ta, [0, 1]));
    assert.match(s, /^任意配比夏普都高于标普500 0\.\d{3}：最高 0\.\d{3}（纳指100 \d+%）$/);
    assertTypography(s, 'two-asset none above');
  }
  assert.equal(C.K.notional([0.2558, 0.5305, 0.9233], 1.7096), '纳指 26 / 标普 53 / 美债 92（1.7倍杠杆）');
});

test('bootstrap rows when no draw is feasible; integer percents of missing values', () => {
  assert.equal(C.K.int(null), '—');
  assert.equal(C.K.int(undefined), '—');
  assert.equal(C.K.int(0.345), '35');
  const inf = run({ volMult: 0.7, teCap: 0.02 }, ['robust']).bundles.robust.byRule.isoVolTe.bootstrap;
  assert.equal(inf.nFeasible, 0, 'fixture: vm=0.7 te=2% has no feasible draw');
  const rows = C.bootstrapRows(inf, 'isoVolTe');
  assert.deepEqual(rows.map(text), [`重抽样无可行解（可行 0/${inf.B}）`]);
  assert.deepEqual(C.probLine(inf, 'isoVolTe'), []);
  assert.equal(C.bootstrapRows(DEF.bundles.robust.byRule.isoVolTe.bootstrap, 'isoVolTe').length, 3);
});

test('CAPM caption: an implied intercept below the risk-free rate carries no cost of not levering', () => {
  const alloc = run({ start: '2016-08', rule: 'tangency' }, ['alloc']).bundles.alloc;
  const t = alloc.rules.tangency;
  assert.ok(t.implied.c < t.cRf, 'fixture: c* below rf for a 2016-08 start');
  const s = text(C.capmCaption(alloc));
  assertTypography(s, 'capm c* < rf');
  assert.ok(!s.includes('不能加杠杆的代价'), s);
  assert.ok(s.includes(`隐含截距 ${format.fmtPct(t.implied.c)}，低于无风险利率 ${format.fmtPct(t.cRf)}`), s);
  if (C.leverBasis(t)?.kind === 'lend') assert.ok(s.startsWith('CAPM 的切点默认可按无风险利率借贷：') && !s.includes('默认你会加杠杆'), s);
  assert.ok(!/年化[少多] 0\.00个百分点/.test(s), s);
});

test('card 1 explains a dividend-driven Sharpe flip only when there is one', () => {
  const sb = DEF.bundles.sample;
  const { priceBasis: pb, divContribution: dc, ndx, spx } = sb.h2h;
  assert.ok((pb.ndxSharpe > pb.spxSharpe) !== (ndx.sharpe > spx.sharpe), 'fixture: the default sample flips');
  const line = text(C.card1(sb).lines[0]);
  const [hi, lo] = pb.ndxSharpe > pb.spxSharpe ? [pb.ndxSharpe, pb.spxSharpe] : [pb.spxSharpe, pb.ndxSharpe];
  assert.ok(line.includes(`夏普更高（${format.fmtNum(hi, 3)} 对 ${format.fmtNum(lo, 3)}）`), line);
  assert.ok(line.includes(`股息每年多 ${format.fmtNum(Math.abs(dc.spx - dc.ndx) * 100, 2)}个百分点，含息后反超`), line);
  const pr = run({ basis: 'pr' }, ['sample']).bundles.sample;
  assert.ok(!text(C.card1(pr).lines[0]).includes('价格口径'));
  const same = clone(sb);
  Object.assign(same.h2h.priceBasis, { ndxSharpe: 0.4, spxSharpe: 0.5 }); // price-basis leader = total-return leader
  assert.equal(C.divFlip(same), null);
  // 3 dp: the printed Sharpes subtract to the printed gap
  const a = text(C.heroAnswer(sb));
  const [s1, s2] = /夏普 ([\d.]+) 对 ([\d.]+)/.exec(a).slice(1).map(Number);
  const gap = Number(format.fmtNumSigned(sb.h2h.sharpeDiffCI.point, 3).replace('−', '-'));
  assert.ok(Math.abs(Math.abs(s1 - s2) - Math.abs(gap)) <= 0.001 + 1e-12, `${a} vs ${gap}`);
});

test('displayed identities add up: §2 answer, card 3 and every bar-table row', () => {
  const ctx = DEF.bundles.context;
  const num = (s) => Number(s.replace('−', '-'));
  const ans = text(C.decompAnswer(ctx)[0]);
  const m = /价格差每年 ([+−]?[\d.]+)个百分点：EPS ([+−]?[\d.]+)、估值 ([+−]?[\d.]+)/.exec(ans);
  assert.ok(m, ans);
  assert.equal((num(m[2]) + num(m[3])).toFixed(2), num(m[1]).toFixed(2), ans);
  const c3 = C.card3(ctx);
  const big = text(c3.big), l1 = text(c3.lines[0]);
  const eps = num(/EPS ×([\d.]+)/.exec(big)[1]), pe = num(/估值 ×([\d.]+)/.exec(big)[1]), price = num(/价格比 ×([\d.]+)/.exec(l1)[1]);
  assert.equal((Math.round(eps * pe * 100) / 100).toFixed(2), price.toFixed(2), `${big} / ${l1}`);
  assert.ok(Math.abs(pe - ctx.decomp.full.factors.pe) < 0.001, 'valuation factor within 0.001 of the engine value');
  const rows = [...ctx.decomp.rows, ctx.decomp.full, run({ m0: 2.4 }, ['context']).bundles.context.decomp.full];
  for (const r of rows) {
    const u = C.decompUnits(r, 2);
    assert.equal(u.price_lp_yr, u.pe_lp_yr + u.eps_lp_yr, `${r.label} price`);
    if (Number.isInteger(u.tr_lp_yr)) assert.equal(u.tr_lp_yr, u.price_lp_yr + u.div_lp_yr, `${r.label} total return`);
    for (const key of Object.keys(u)) assert.ok(Math.abs(u[key] - r[key] * 100) <= 1.5, `${r.label} ${key}`);
  }
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 20;
  for (let i = 0; i < 2000; i++) {
    const b = rnd(), c = rnd(), a = b + c;
    const [ua, ub, uc] = addUp([a, b, c], 2, [Math.round(a * 100)]);
    assert.equal(ua, ub + uc);
    assert.ok(Math.abs(ub - b * 100) <= 1.5 && Math.abs(uc - c * 100) <= 1.5, `${a} = ${b} + ${c}`);
  }
});

test('intercept caption: exact 10年期 point when the engine has it, thresholds rounded up, c* listed', () => {
  const alloc = DEF.bundles.alloc;
  const t = alloc.rules.tangency, path = alloc.tangencyPath;
  const ic = text(C.interceptCaption(alloc));
  assert.ok(ic.includes(`${format.fmtPct(t.implied.c, 2)}（隐含）→ 美债 ${format.roundWeights(t.implied.w)[2]}%`), ic);
  for (const [key, label] of [['cUstUnder50', '美债低于一半'], ['cZeroUst', '美债为0'], ['cAllNdx', '纳指100全仓']]) {
    if (!Number.isFinite(path[key])) continue;
    const hit = new RegExp(`≥([\\d.]+)% ${label}`).exec(ic);
    assert.ok(hit && +hit[1] >= path[key] * 100 - 1e-9 && +hit[1] - path[key] * 100 < 0.01, `${key}: ${ic}`);
  }
  const withY10 = clone(alloc);
  withY10.rules.tangency.atY10 = { w: [0.3, 0.29, 0.41] };
  const segs = C.interceptCaption(withY10).flat(Infinity);
  assert.equal(segs.find((s) => s?.k === 'alloc.rules.tangency.atY10.w.2')?.t, '41%');
  assert.ok(!segs.some((s) => s?.k === 'alloc.tangencyPath@cY10'));
});

test('bootstrap corner share names the asset; card 2 decade Sharpe; robust note names the pair; cash leg', () => {
  const bs = DEF.bundles.robust.byRule.isoVolTe.bootstrap;
  const cs = C.cornerByAsset(bs);
  assert.ok(Math.abs(cs.by.reduce((a, b) => a + b, 0) - bs.probCorner) <= 2 / bs.nFeasible, 'per-asset corners add up to probCorner');
  const s = text(C.probLine(bs, 'isoVolTe'));
  const hits = cs.by.map((x, i) => [x, i]).filter(([x]) => x > 0);
  if (hits.length === 1) assert.ok(s.includes(` · 100% ${['纳指100', '标普500', '10年美债'][hits[0][1]]}：${format.fmtPct(bs.probCorner)}`), s);
  const eng = { ...bs, probCorner: 0.15, probCornerByAsset: [0.1, 0.05, 0] };
  assert.ok(text(C.probLine(eng, 'isoVolTe')).includes('全仓单一资产：15.0%（纳指100 10.0% · 标普500 5.0%）'));

  const ctx = DEF.bundles.context;
  assert.match(text(C.card2(ctx).lines[1]), /十年夏普：(\d{4}-\d{2} 前|每个十年都是|\d+\/\d+ 个十年)/);
  const allSpx = clone(ctx);
  for (const r of allSpx.decades) if (Number.isFinite(r.ndx.sharpe)) r.spx.sharpe = r.ndx.sharpe + 0.1;
  assert.match(text(C.decadeSharpe(allSpx)), /^十年夏普：每个十年都是标普500更高（最近十年 /);
  assert.match(text(C.rollingAnnotation(ctx)), /中位 [+−]\d\.\d个百分点\/年 · 最差买入 \d{4}-\d{2}（[+−]\d\.\d个百分点\/年）/);

  assert.equal(C.robustNote('twoAsset', [1, 2]), '标普500+10年美债是固定配比，下方样本外与重抽样为同波动·收益最高。');
  const pr = run({ basis: 'pr' }, ['alloc']).bundles.alloc;
  const lev = pr.rules.tangency.levered;
  assert.ok(lev.L < 1, 'fixture: the price-basis tangency de-levers');
  const n = C.K.notional(lev.notional, lev.L);
  assert.match(n, /^纳指 \d+ \/ 标普 \d+ \/ 美债 \d+ \+ 现金 \d+（不加杠杆）$/);
  assertTypography(n, 'cash leg');
  assert.equal(C.leveredLabel(pr.rules.tangency, '切点×杠杆到标普波动'), '切点+现金到标普波动');
});

// regression (verify phase): engine impliedIntercept intervals carry openAbove; a bounded one must not print ≥cLow.
test('tangentLine: bounded implied-intercept interval reads cLow～cHigh; only an open-above interval reads ≥', () => {
  const w = [0, 1, 0];
  const iso = (ii) => ({ w, pure: { w, impliedIntercept: ii } });
  const bounded = text(C.tangentLine(iso({ kind: 'interval', cLow: -0.0023, cHigh: 0.0196, vertex: 1, openAbove: false })));
  assert.ok(!bounded.includes('≥'), bounded);
  assert.equal(bounded, `当前组合即截距 ${C.K.pct(-0.0023)}～${C.K.pct(0.0196)} 的切点`);
  const open = text(C.tangentLine(iso({ kind: 'interval', cLow: 0.03, cHigh: null, vertex: 2, openAbove: true })));
  assert.equal(open, `当前组合即截距 ≥${C.K.pct(0.03)} 的切点`);
  const short = run({ start: '2024-08' });
  const line = text(C.tangentLine(short.bundles.alloc.rules.isoVolTe) ?? []);
  const ii = short.bundles.alloc.rules.isoVolTe.pure.impliedIntercept;
  if (ii?.kind === 'interval' && ii.openAbove === false) assert.ok(!line.includes('≥') && line.includes('～'), line);
});
