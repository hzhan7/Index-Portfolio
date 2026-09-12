// §3 怎么配: 你问过的组合, rule tabs + params, result card, frontier + ternary.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { createCopy, RULE_LABELS } from '../copy.js?v=20260912';
import { tableBlock } from '../table.js?v=20260912';
import { mountPoint, statusLine, applyStatus, chartSlot, segControl, selectControl, robustReady, ASSETS } from './common.js?v=20260912';
import { createParams } from './allocation-params.js?v=20260912';

const TABS = ['isoVolTe', 'maxSharpeCagrFloor', 'tangency', 'twoAsset', 'custom'];
const ROW_RULE = { ndxUstSharpeEqSpx: 'twoAsset', ndxUstCagrEqSpx: 'twoAsset', maxSharpeCagrFloor: 'maxSharpeCagrFloor', isoVolTe: 'isoVolTe', tangencyLevered: 'tangency' };
const OOS_RULE = { isoVolTe: 'isoVolTe', maxSharpeCagrFloor: 'maxSharpeCagrFloor', tangencyLevered: 'tangency' };
const OOS_REF = { spx: 'spx', ndx: 'ndx', sixty40: 'sixty40', ndxSpx5050: 'ndxSpx5050' }; // walkForward.stats series on the same OOS months
const REFERENCE_IDS = new Set(['sixty40', 'ndxSpx5050']);
const MARKERS = [['isoVolTe', 'star', '同波动·收益最高'], ['maxSharpeCagrFloor', 'diamond', '收益≥标普·夏普最高'], ['tangency', 'triangle', '切点组合'],
  ['gmv', 'square', '最小方差'], ['twoAssetNdxUst', 'triangleDown', '纳指100+美债·夏普=标普500'], ['custom', 'ring', '自定义'], ['sixty40', 'cross', '60/40'], ['ndxSpx5050', 'plus', '50/50']];
const METRICS = [['cagr', '年化复合收益'], ['sharpe', '夏普比率'], ['vol', '年化波动'], ['mdd', '最大回撤'], ['worst12m', '最差12个月']];
const fin = Number.isFinite;

const dot = (a, w) => a.reduce((s, x, i) => s + x * w[i], 0);
const quad = (cov, w) => w.reduce((s, wi, i) => s + wi * dot(Array.from(cov[i]), w), 0);

function headlineIndex(ta) {
  const pts = ta?.points ?? [];
  const i = pts.findIndex((p) => fin(ta.headline) && Math.abs(p.x - ta.headline) < 1e-6);
  return i >= 0 ? i : pts.findIndex((p) => String(p.ids ?? p.id).includes('sharpeEqSpx'));
}
const headlinePoint = (ta) => ta?.points?.[headlineIndex(ta)] ?? null;

// Active-tab portfolio shown in the result card, with the bundle paths its numbers come from.
function activeResult(alloc, rule) {
  const r = alloc.rules[rule];
  if (!r) return null;
  if (rule === 'tangency') {
    const u = r.unlevered, b = 'alloc.rules.tangency';
    return { ...r, w: u?.w ?? r.w, stats: u?.stats ?? r.stats, vsSpx: u?.vsSpx ?? r.vsSpx,
      wPath: u?.w ? `${b}.unlevered.w` : `${b}.w`, statsPath: u?.stats ? `${b}.unlevered.stats` : `${b}.stats`,
      vsPath: u?.vsSpx ? `${b}.unlevered.vsSpx` : r.vsSpx ? `${b}.vsSpx` : null };
  }
  if (rule === 'twoAsset' && !r.w) {
    const i = headlineIndex(r);
    const p = r.points?.[i];
    const b = `alloc.rules.twoAsset.points.${i}`;
    return p ? { ...r, w: p.w, stats: p.stats, vsSpx: p.vsSpx ?? null, status: 'ok', wPath: `${b}.w`, statsPath: `${b}.stats`, vsPath: p.vsSpx ? `${b}.vsSpx` : null }
      : { ...r, status: r.status === 'ok' ? 'undefined' : r.status };
  }
  const b = `alloc.rules.${rule}`;
  return { ...r, wPath: `${b}.w`, statsPath: `${b}.stats`, vsPath: r.vsSpx ? `${b}.vsSpx` : null };
}

function markerWeights(alloc, sample) {
  const ref = (id) => sample.references?.find((x) => x.id === id)?.w;
  const ok = (r) => (r && r.status !== 'infeasible' && r.w ? r.w : null);
  return {
    isoVolTe: ok(alloc.rules.isoVolTe), maxSharpeCagrFloor: ok(alloc.rules.maxSharpeCagrFloor), tangency: alloc.rules.tangency?.unlevered?.w ?? ok(alloc.rules.tangency),
    gmv: sample.frontier?.gmv?.w, twoAssetNdxUst: headlinePoint(alloc.rules.twoAssetNdxUst)?.w, custom: ok(alloc.rules.custom), sixty40: ref('sixty40'), ndxSpx5050: ref('ndxSpx5050'),
  };
}

export function mount(rootEl, api) {
  const C = createCopy(api.format);
  const { K, N } = C;
  const host = mountPoint(rootEl);
  const status = statusLine();
  const params = createParams(api, C);

  const askedBox = el('div', { class: 'asked' });
  const tabButtons = new Map(TABS.map((id) => [id, el('button', { type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': 'false', title: id === 'isoVolTe' ? '默认' : null }, [RULE_LABELS[id]])]));
  const tablist = el('div', { class: 'tabs alloc-tabs', role: 'tablist', 'aria-label': '配置规则' }, [...tabButtons.values()]);
  // Roving focus: arrows / Home / End select a tab and move focus with the selection (WAI-ARIA tabs).
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(api.getState().rule);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const id = TABS[(next + TABS.length) % TABS.length];
    api.setState({ rule: id });
    tabButtons.get(id)?.focus();
  });
  for (const [id, b] of tabButtons) b.addEventListener('click', () => api.setState({ rule: id }));
  const tabSelect = selectControl({ label: '配置规则', cls: 'alloc-tabs-select', onChange: (v) => api.setState({ rule: v }) });

  const cardTitle = el('h3', { class: 'card__eyebrow' });
  const cardWeights = el('p', { class: 'card__value result__weights' });
  const bar = chartSlot(api, 'weightBar', { ariaLabel: '配置权重', table: false, cls: 'result__bar' });
  const chips = el('div', { class: 'result__chips' });
  const metricsHead = el('p', { class: 'note result__head' });
  const metrics = el('div', { class: 'result__metrics' });
  const extra = el('p', { class: 'card__line result__extra' });
  const card = el('article', { class: 'card result', 'aria-live': 'polite' }, [cardTitle, cardWeights, bar.root, chips, metricsHead, metrics, extra]);
  const panel = el('div', { class: 'alloc-panel', role: 'tabpanel' }, [params.root, card]);

  const frontier = chartSlot(api, 'frontier', { ariaLabel: '有效前沿与各配置规则', filename: 'frontier.csv' });
  const ternary = chartSlot(api, 'ternary', { ariaLabel: '三资产权重三角图', filename: 'ternary.csv' });
  const metricSeg = segControl({ label: '三角图指标', options: [{ value: 'sharpe', label: '夏普比率' }, { value: 'cagr', label: '年化复合收益' }], onSelect: (v) => api.setState({ ternaryMetric: v }) });

  host.appendChild(status);
  host.appendChild(el('h3', { class: 'subhead' }, ['你问过的组合']));
  host.appendChild(askedBox);
  host.appendChild(el('div', { class: 'alloc-tabbar' }, [tablist, tabSelect.root]));
  host.appendChild(panel);
  // marker legends live inside the frontier and ternary charts (one per chart; no third copy below them)
  host.appendChild(el('div', { class: 'grid-2 alloc-charts' }, [frontier.root, el('div', { class: 'alloc-ternary' }, [metricSeg.root, ternary.root])]));

  const sig = {};
  const changed = (name, key) => (sig[name] === key ? false : ((sig[name] = key), true));

  // 设为自定义 with one-click 撤销 back to the previous rule and weights.
  function applyCustom(w) {
    const { rule, customW, fill: fillIdx } = api.getState();
    api.setState({ rule: 'custom', customW: K.roundWeights(w).map((x) => x / 100) });
    api.toast(`已设为自定义：${K.weights(w)}`, { actionLabel: '撤销', onAction: () => api.setState({ rule, customW, fill: fillIdx }) });
  }

  function pick(row) {
    const rule = ROW_RULE[row.id];
    if (rule) return api.setState(rule === 'twoAsset' ? { rule, pair: [0, 2] } : { rule });
    if (row.w) applyCustom(row.w);
  }

  // 样本外年化: rule rows from their own walk-forward; reference rows from the 同波动 walk-forward (same OOS months).
  // robust is null while a newer robust job runs (never the previous state's numbers).
  function oosCell(a, robust, headOos, failed) {
    const ruleId = OOS_RULE[a.id], refId = OOS_REF[a.id];
    if (!ruleId && !refId) return { t: '—' };
    if (!robust) return { t: failed ? '计算失败' : '计算中…' };
    const src = ruleId ?? 'isoVolTe', series = ruleId ? 'rule' : refId;
    const wf = robust.byRule?.[src]?.walkForward;
    const s = wf?.status === 'ok' ? wf.stats?.[series] : null;
    if (!s) return { t: '—' };
    // windows without a feasible solution hold 标普500 (engine); when every window is infeasible nothing rule-specific is left
    const inf = ruleId ? wf.infeasibleWindows ?? 0 : 0, windows = wf.weights?.length ?? 0;
    if (inf && inf >= windows) return { t: '—', sub: '每年均无可行解' };
    const subs = [headOos && wf.firstOos !== headOos ? `${wf.firstOos}起` : null, inf ? `${inf}/${windows}年按标普500` : null].filter(Boolean);
    return { t: K.pct(s.cagr, 2), k: `robust.byRule.${src}.walkForward.stats.${series}.cagr`, v: s.cagr, sub: subs.join(' · ') || null };
  }

  // A4 has two NDX+UST mixes with 标普500's Sharpe; the row shows the headline, the sub-line the other one.
  function otherRoot(alloc, a) {
    if (a.id !== 'ndxUstSharpeEqSpx' || !a.w) return null;
    const pts = alloc.rules.twoAssetNdxUst?.points ?? [];
    const k = pts.findIndex((q) => q.w && q.stats && String(q.ids ?? q.id).includes('sharpeEqSpx') && Math.abs(q.w[0] - a.w[0]) > 1e-6);
    if (k < 0) return null;
    const q = pts[k], kp = `alloc.rules.twoAssetNdxUst.points.${k}`;
    return ['另一解 ', N(K.weights(q.w), `${kp}.w`), '（年化 ', N(K.pct(q.stats.cagr, 2), `${kp}.stats.cagr`, q.stats.cagr), '）'];
  }

  function drawAsked(alloc, robust, active, failed) {
    const isoWf = robust?.byRule?.isoVolTe?.walkForward;
    const firstOos = isoWf?.status === 'ok' ? isoWf.firstOos : null;
    let divider = false;
    const rows = [];
    alloc.asked.forEach((a, i) => {
      if (REFERENCE_IDS.has(a.id) && !divider) {
        divider = true;
        rows.push({ cls: 'group-row', cells: [{ t: '参考', colspan: 8, th: true, scope: 'colgroup' }] });
      }
      const k = `alloc.asked.${i}`;
      const s = a.stats ?? {};
      const L = a.L ?? alloc.rules.tangency?.levered?.L;
      const cell = (m, t) => ({ t, k: `${k}.stats.${m}`, v: s[m] });
      const label = a.id === 'tangencyLevered' ? C.leveredLabel(alloc.rules.tangency, a.label) : a.label;
      rows.push({
        cls: ROW_RULE[a.id] === active ? 'is-active' : null,
        attrs: { tabindex: '0', title: ROW_RULE[a.id] ? `查看「${RULE_LABELS[ROW_RULE[a.id]]}」` : '设为自定义' },
        on: { click: () => pick(a), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(a); } } },
        cells: [{ t: label, th: true, sub: otherRoot(alloc, a) }, a.notional ? { t: K.notional(a.notional, L), k: `${k}.notional` } : { t: a.w ? K.weights(a.w) : '—', k: `${k}.w` },
          cell('cagr', K.pct(s.cagr, 2)), cell('sharpe', K.sharpe(s.sharpe)), cell('vol', K.pct(s.vol, 2)), cell('mdd', K.pct(s.mdd, 2)), cell('worst12m', K.pct(s.worst12m, 2)),
          oosCell(a, robust, firstOos, failed)],
      });
    });
    const head = [['组合', '配置（纳指/标普/美债）', '年化', '夏普', '波动', '最大回撤', '最差12个月', firstOos ? `样本外年化（${firstOos}起）` : '样本外年化']];
    fill(askedBox, [tableBlock({ caption: '你问过的组合（点击行查看对应规则）', captionHidden: true, head, rows, className: 'table table--asked' })]);
  }

  function drawCard(view, robust) {
    const { alloc, sample } = view.bundles;
    const st = view.state;
    const active = st.rule;
    const r = activeResult(alloc, active);
    fill(cardTitle, active === 'twoAsset' ? [`${(st.pair ?? [0, 2]).map((i) => ASSETS[i].label).join('+')} · 夏普=标普500`] : [RULE_LABELS[active]]);
    const spx = sample?.h2h?.spx;
    const ok = r && r.status === 'ok' && r.w && r.stats;
    fill(chips, ok ? C.bindingChips(r).map((t) => el('span', { class: 'chip' }, [t])) : []);
    bar.root.hidden = !ok;
    if (!ok) {
      fill(cardWeights, ['—']);
      fill(metrics, []);
      fill(metricsHead, active === 'isoVolTe' && r ? C.isoInfeasible(r, st) : active === 'twoAsset' && r ? (C.twoAssetStatus(r, st.pair) ?? []) : ['没有可行组合']);
      fill(extra, []);
      return;
    }
    fill(cardWeights, [N(K.weights(r.w), r.wPath)]);
    const boot = robust?.byRule?.[active]?.bootstrap;
    // no whiskers without a feasible draw; none either when the bootstrap is of the levered kinked CAL (tangency, §4),
    // which is a different portfolio from the unlevered point on this card
    const bs = boot?.nFeasible > 0 && boot.variant !== 'levered' ? boot.weights : null;
    bar.update({ key: `${keyOf(alloc)}|${active}|${bs ? keyOf(robust) : ''}`, w: Array.from(r.w), whiskers: bs ? { p10: bs.p10, p50: bs.p50, p90: bs.p90 } : undefined });
    fill(metricsHead, st.mu === 'y10bond' && sample ? [el('span', { class: 'chip chip--warn' }, ['假设']), ' ', C.y10Header(sample, alloc)]
      : sample ? ['对标普500（', N(sample.sample.start, 'sample.sample.start'), '～', N(sample.sample.end, 'sample.sample.end'), '）'] : []);
    fill(metrics, METRICS.map(([m, label]) => {
      const v = r.stats[m];
      const eng = r.vsSpx?.[m];
      const d = fin(eng) ? eng : spx && fin(spx[m]) && fin(v) ? v - spx[m] : null;
      const dl = C.delta(d, m === 'sharpe' ? 'sharpe' : 'pct', fin(eng) ? `${r.vsPath}.${m}` : `derived:${r.statsPath}.${m}-sample.h2h.spx.${m}`);
      return el('div', { class: 'metric' }, [el('span', { class: 'metric__label' }, [label]),
        el('span', { class: 'metric__value' }, [N(m === 'sharpe' ? K.sharpe(v) : K.pct(v, 1), `${r.statsPath}.${m}`, v)]),
        dl ? el('span', { class: `metric__delta ${dl.cls}`.trim() }, dl.segs) : null]);
    }).concat(r.vsSpx && fin(r.vsSpx.te) ? [el('div', { class: 'metric' }, [el('span', { class: 'metric__label' }, ['跟踪误差 / 信息比率']),
      el('span', { class: 'metric__value' }, [N(K.pct(r.vsSpx.te, 1), `${r.vsPath}.te`, r.vsSpx.te), ' / ', N(K.num(r.vsSpx.ir, 2), `${r.vsPath}.ir`, r.vsSpx.ir)])])] : []));
    fill(extra, active === 'isoVolTe' ? (C.muShiftLine(r) ?? []) : []);
  }

  function markerList(alloc, sample, active, muVec, cov) {
    const ws = markerWeights(alloc, sample);
    return MARKERS.filter(([id]) => ws[id]).map(([id, shape, label]) => {
      const w = Array.from(ws[id]);
      return { id, shape, label, w, mu: dot(muVec, w), vol: Math.sqrt(quad(cov, w)), active: id === active };
    });
  }

  function drawCharts(view) {
    const { alloc, sample } = view.bundles;
    const st = view.state;
    const mom = sample.moments;
    const muVec = Array.from(alloc.ctx.muUsed ?? mom.mu); // y10bond: markers, frontier and path share the μ used for weights
    const markers = markerList(alloc, sample, st.rule, muVec, mom.cov);
    const volOf = (w) => Math.sqrt(quad(mom.cov, Array.from(w)));
    const muOf = (w) => dot(muVec, Array.from(w));
    const mk = `${keyOf(sample)}|${keyOf(alloc)}|${st.rule}|${st.intercept}`;
    if (changed('frontier', mk)) {
      const iso = alloc.rules.isoVolTe;
      const tw = alloc.rules.tangency?.unlevered?.w;
      const tc = alloc.rules.tangency?.c;
      frontier.setTitle(['有效前沿与配置规则', st.mu === 'y10bond' ? '（美债预期收益=10年期收益率）' : '']);
      frontier.update({
        key: mk, xLabel: '年化波动', yLabel: '算术年化收益（月均×12）',
        frontier: (alloc.frontier ?? sample.frontier).frontier.map((p) => ({ mu: p.mu, vol: p.vol })),
        assets: ASSETS.map((a, i) => ({ id: a.id, label: a.label, mu: muVec[i], vol: Math.sqrt(mom.cov[i][i]), colorVar: a.colorVar })),
        spx: { mu: muVec[1], vol: Math.sqrt(mom.cov[1][1]) },
        region: { volMax: Math.sqrt(mom.cov[1][1]), muMin: muVec[1], label: '均值≥标普500 且 波动≤标普500' },
        tePath: iso?.path?.length ? iso.path.map((p) => ({ k: p.k, mu: muOf(p.w), vol: volOf(p.w) })) : null,
        markers,
        // at the implied intercept the tangent touches the frontier at the 同波动 point without the TE cap
        tangent: tw && fin(tc) ? { c: tc, mu: muOf(tw), vol: volOf(tw), label: st.intercept === 'implied' ? `切线（截距 ${K.pct(tc)}，切于同波动·跟踪误差不限）` : null } : null,
      });
    }
    const lat = sample.lattice;
    metricSeg.set(st.ternaryMetric);
    const tk = `${mk}|${st.ternaryMetric}|${(st.customW ?? []).join(',')}`;
    if (lat && changed('ternary', tk)) {
      ternary.setTitle(['三资产组合：', st.ternaryMetric === 'cagr' ? '年化复合收益' : '夏普比率']);
      ternary.update({
        key: tk, step: lat.step, i: lat.i, j: lat.j, values: lat[st.ternaryMetric], metric: st.ternaryMetric, spxValue: lat.spx[st.ternaryMetric],
        contours: [{ values: lat.cagr, level: lat.spx.cagr, label: '收益=标普500', dashed: false }, { values: lat.sharpe, level: lat.spx.sharpe, label: '夏普=标普500', dashed: true }],
        markers, pinned: st.rule === 'custom' && st.customW ? Array.from(st.customW) : null,
        onPin: () => {},
        onApply: (w) => applyCustom(w),
      });
    }
  }

  return {
    render(view) {
      applyStatus(host, status, view, ['sample', 'alloc']);
      const st = view.state;
      for (const [id, b] of tabButtons) {
        b.setAttribute('aria-selected', String(id === st.rule));
        b.tabIndex = id === st.rule ? 0 : -1;
      }
      panel.setAttribute('aria-labelledby', `tab-${st.rule}`);
      tabSelect.set(TABS.map((id) => ({ value: id, label: RULE_LABELS[id] })), st.rule);
      params.render(view);
      const { alloc, sample } = view.bundles;
      if (!alloc) return;
      const robust = robustReady(view);
      const failed = !!view.errors?.robust;
      const rk = `${keyOf(alloc)}|${keyOf(robust)}|${!!robust}|${failed}|${st.rule}`;
      if (alloc.asked && changed('asked', rk)) drawAsked(alloc, robust, st.rule, failed);
      if (changed('card', `${rk}|${keyOf(sample)}|${st.mu}|${(st.pair ?? []).join('-')}`)) drawCard(view, robust);
      if (sample) drawCharts(view);
    },
  };
}
