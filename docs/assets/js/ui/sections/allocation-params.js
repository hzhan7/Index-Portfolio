// §3 per-tab parameter panels and tab-only charts (同波动 / 收益≥标普 / 切点 / 纳指+美债 / 自定义).
import { el, fill, keyOf } from './dom.js?v=20260912';
import { tableBlock } from '../table.js?v=20260912';
import { TE_CHIPS, ASSET_LABEL } from '../copy.js?v=20260912';
import { chartSlot, segControl, selectControl, rangeControl, robustReady, ASSETS } from './common.js?v=20260912';

const PAIRS = [[[0, 2], '纳指100+美债'], [[1, 2], '标普500+美债'], [[0, 1], '纳指100+标普500']];
const POINT_LABELS = { sharpeEqSpx: '夏普=标普500', cagrEqSpx: '收益=标普500', volEqSpx: '波动=标普500', maxSharpeCagrFloor: '收益≥标普·夏普最高' };
const IC_MAX = 20; // custom intercept input range, % (state.js accepts 0～0.2)
const fin = Number.isFinite;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pointIds = (p) => p.ids ?? (Array.isArray(p.id) ? p.id : String(p.id).split(/[+,|]/));
export const pointLabel = (p) => pointIds(p).map((id) => POINT_LABELS[id] ?? id).join(' · ');

export function createParams(api, C) {
  const { K, N } = C;
  const set = (patch) => api.setState(patch);
  let view = null, sigma = null;

  // 同波动·收益最高
  const volText = (m) => (fin(sigma)
    ? [K.num(m, 2), '（', N(K.pct(m * sigma), Math.abs(m - 1) < 1e-9 ? 'alloc.ctx.sigmaSpx' : `derived:alloc.ctx.sigmaSpx*${m}`, sigma * m), '）']
    : [K.num(m, 2)]);
  const vol = rangeControl({ label: '波动上限：标普500 ×', min: 0.7, max: 1.2, step: 0.05, cls: 'range--vol',
    onInput: (m) => fill(vol.out, volText(m)), onCommit: (m) => set({ volMult: Math.round(m * 20) / 20 }) });
  const te = segControl({ label: '跟踪误差上限', options: [...TE_CHIPS.map((k) => ({ value: String(k), label: K.pct(k, 0) })), { value: 'none', label: '不限' }],
    onSelect: (v) => set({ teCap: v === 'none' ? null : Number(v) }) });
  const infeasibleMsg = el('p', { class: 'note' });
  const infeasibleBtn = el('button', { type: 'button', class: 'btn' });
  const infeasible = el('div', { class: 'infeasible', role: 'status', hidden: true }, [infeasibleMsg, infeasibleBtn]);
  let minTeChip = null;
  infeasibleBtn.addEventListener('click', () => minTeChip && set({ teCap: minTeChip.value }));
  const isoSub = el('p', { class: 'note param-sub' });
  const iso = el('div', { class: 'params params--iso' }, [vol.root, el('div', { class: 'param-row' }, [el('span', { class: 'param-label' }, ['跟踪误差上限']), te.root]), infeasible, isoSub]);

  // 收益≥标普·夏普最高
  const msfNote = el('p', { class: 'note' });
  const msf = el('div', { class: 'params params--msf' }, [msfNote]);

  // 切点组合
  const icSel = selectControl({ label: '截距', onChange: (v) => set(v === 'custom' ? { intercept: v, interceptC: view?.state.interceptC ?? view?.bundles.alloc?.rules.tangency.c ?? null } : { intercept: v }) });
  const icInput = el('input', { type: 'number', min: 0, max: IC_MAX, step: 0.1, class: 'num-input', 'aria-label': `自定义截距（%，0～${IC_MAX}）` });
  const icShown = () => (fin(view?.state.interceptC) ? String(Math.round(view.state.interceptC * 1e4) / 100) : '');
  // Empty or non-numeric input restores the committed value; out-of-range values clamp to 0～20% with a toast.
  icInput.addEventListener('change', () => {
    const raw = String(icInput.value ?? '').trim();
    const x = raw === '' ? NaN : Number(raw);
    if (!fin(x)) { icInput.value = icShown(); return; }
    const c = clamp(x, 0, IC_MAX);
    if (c !== x) api.toast(`截距范围 0%～${IC_MAX}%，已按 ${c}% 计算`);
    icInput.value = String(Math.round(c * 100) / 100);
    set({ intercept: 'custom', interceptC: Math.round(c * 100) / 1e4 });
  });
  const spread = segControl({ label: '融资利差', options: [[0, '0'], [0.005, '0.5%'], [0.01, '1%']].map(([value, label]) => ({ value, label })), onSelect: (v) => set({ spread: v }) });
  const capmTable = el('div', { class: 'capm' });
  const capmCaption = el('p', { class: 'note capm__caption' });
  const pathChart = chartSlot(api, 'stackedArea', { ariaLabel: '截距与切点组合权重', filename: 'tangency_path.csv' });
  const pathCaption = el('p', { class: 'note' });
  const tan = el('div', { class: 'params params--tangency' }, [
    el('div', { class: 'param-row' }, [icSel.root, icInput, el('span', { class: 'param-label' }, ['融资利差']), spread.root]), capmTable, capmCaption, pathChart.root, pathCaption]);

  // 纳指+美债（两资产）
  const pairSel = selectControl({ label: '组合', onChange: (v) => set({ pair: v.split('-').map(Number) }) });
  const panels = chartSlot(api, 'twoAssetPanels', { ariaLabel: '两资产组合夏普与年化收益随权重变化', filename: 'two_asset.csv' });
  const pointsBox = el('div', { class: 'points' });
  const taStatus = el('p', { class: 'note' });
  const two = el('div', { class: 'params params--two' }, [pairSel.root, taStatus, panels.root, pointsBox]);

  // 自定义
  const fillSel = selectControl({ label: '补足项', onChange: (v) => set({ fill: Number(v) }) });
  let customW = [0, 0, 0], fillIdx = 2;
  const onCustom = (i, v, commit) => {
    const other = [0, 1, 2].find((j) => j !== i && j !== fillIdx);
    const w = [...customW];
    w[i] = clamp(Math.round(v), 0, 100 - w[other]);
    w[fillIdx] = 100 - w[i] - w[other];
    customW = w;
    drawCustom();
    if (commit) set({ customW: w.map((x) => x / 100) });
  };
  const sliders = ASSETS.map((a, i) => {
    const r = rangeControl({ label: a.label, min: 0, max: 100, step: 1, onInput: (v) => onCustom(i, v, false), onCommit: (v) => onCustom(i, v, true) });
    const num = el('input', { type: 'number', min: 0, max: 100, step: 1, class: 'num-input', 'aria-label': `${a.label} 权重（%）` });
    num.addEventListener('change', () => onCustom(i, +num.value, true));
    const fixedOut = el('p', { class: 'custom-row__fill', hidden: true });
    return { r, num, fixedOut, row: el('div', { class: 'custom-row' }, [r.root, num, fixedOut]) };
  });
  function drawCustom() {
    sliders.forEach((s, i) => {
      const isFill = i === fillIdx;
      s.r.root.hidden = isFill;
      s.num.hidden = isFill;
      s.fixedOut.hidden = !isFill;
      s.r.input.value = String(customW[i]);
      s.r.out.textContent = `${customW[i]}%`;
      s.num.value = String(customW[i]);
      s.fixedOut.textContent = `${ASSET_LABEL[i]} ${customW[i]}%（补足项）`;
    });
  }
  const custom = el('div', { class: 'params params--custom' }, [fillSel.root, ...sliders.map((s) => s.row)]);

  // 收益假设
  const muSel = selectControl({ label: '收益假设', onChange: (v) => set({ mu: v }) });
  const muHeader = el('p', { class: 'note param-sub', hidden: true });
  const mu = el('div', { class: 'params params--mu' }, [muSel.root, muHeader]);

  const byRule = { isoVolTe: iso, maxSharpeCagrFloor: msf, tangency: tan, twoAsset: two, custom };
  const root = el('div', { class: 'alloc-params' }, [...Object.values(byRule), mu]);
  const sig = {};
  const changed = (name, key) => (sig[name] === key ? false : ((sig[name] = key), true));

  function renderIso(alloc, st) {
    const r = alloc.rules.isoVolTe;
    sigma = alloc.ctx.sigmaSpx;
    vol.input.value = String(st.volMult);
    fill(vol.out, volText(st.volMult));
    const teU = r.pure?.teUnconstrained;
    const disabled = {}, titles = {};
    for (const k of TE_CHIPS) { disabled[String(k)] = fin(teU) && k > teU + 1e-9; titles[String(k)] = disabled[String(k)] ? '上限不生效' : ''; }
    te.set(st.teCap == null ? 'none' : String(st.teCap), { disabled, titles,
      labels: { none: fin(teU) ? ['不限（=', N(K.pct(teU, 1), 'alloc.rules.isoVolTe.pure.teUnconstrained', teU), '）'] : '不限' } });
    const minVm = r.feasibility?.minVolMultByTe?.[st.teCap == null ? 'none' : st.teCap.toFixed(2)];
    vol.zone('infeasible', 0, fin(minVm) ? (minVm - 0.7) / 0.5 : 0);
    infeasible.hidden = r.status === 'ok';
    if (r.status !== 'ok') {
      fill(infeasibleMsg, C.isoInfeasible(r, st));
      minTeChip = fin(r.feasibility?.minTeForVolCap) ? C.teChipFor(r.feasibility.minTeForVolCap) : null;
      infeasibleBtn.hidden = !minTeChip;
      infeasibleBtn.textContent = minTeChip ? `设为 ${minTeChip.label}` : '';
    }
    fill(isoSub, [`波动≤标普500${st.volMult === 1 ? '' : ` ×${K.num(st.volMult, 2)}`} · 跟踪误差≤${C.teLabel(st.teCap)}`]);
  }

  function renderTangency(alloc, robust, st, failed) {
    const t = alloc.rules.tangency;
    const p = 'alloc.rules.tangency';
    const ii = alloc.rules.isoVolTe.pure?.impliedIntercept;
    const [cStar, cStarKey] = [[t.implied?.c, `${p}.implied.c`], [ii?.c, 'alloc.rules.isoVolTe.pure.impliedIntercept.c'], [ii?.cLow, 'alloc.rules.isoVolTe.pure.impliedIntercept.cLow']]
      .find(([x]) => fin(x)) ?? [null, null];
    icSel.set([
      { value: 'implied', label: `同波动隐含截距 ${fin(cStar) ? K.pct(cStar) : '—'}（默认）` },
      { value: 'rf', label: `无风险利率 ${K.pct(t.cRf)}` },
      { value: 'y10', label: `10年美债收益率 ${K.pct(t.cY10)}` },
      { value: 'custom', label: '自定义' },
    ], st.intercept);
    icInput.hidden = st.intercept !== 'custom';
    if (st.intercept === 'custom' && fin(st.interceptC)) icInput.value = icShown();
    spread.set(st.spread);

    const oosT = robust?.byRule?.tangency?.walkForward;
    const lev = t.levered;
    const atRf = C.tangencyAtRf(alloc);
    const lb = C.leverBasis(t);
    const pct2 = (s, m, key) => ({ t: K.pct(s?.[m], 2), k: s && `${key}.stats.${m}`, v: s?.[m] });
    const row = (label, wCell, key, s, extra = [{ t: '—' }, { t: '—' }]) => [{ th: true, children: label }, wCell,
      pct2(s, 'vol', key), pct2(s, 'cagr', key), { t: K.sharpe(s?.sharpe), k: s && `${key}.stats.sharpe`, v: s?.sharpe }, pct2(s, 'mdd', key), ...extra];
    const rows = [];
    if (atRf) rows.push(row(['切点·截距=无风险利率 ', N(K.pct(t.cRf), `${p}.cRf`, t.cRf)], { t: K.weights(atRf.w), k: `${p}.${atRf.key}.w` }, `${p}.${atRf.key}`, atRf.stats));
    if (lev) {
      const levLabel = !lb ? [`加杠杆到${C.leverTarget(t)}`]
        : lb.kind === 'lend' ? [`截距=无风险利率的切点 + 现金（到${lb.target}）`]
          : lb.kind === 'frontier' ? [`前沿上波动=${lb.target}的组合（无需杠杆）`]
            : lb.atRf ? [`同一切点加杠杆到${lb.target}（融资=无风险利率）`]
              : ['融资利率 ', N(K.pct(lb.cUsed), `${p}.levered.cUsed`, lb.cUsed), ` 的切点加杠杆到${lb.target}（无风险利率+利差 `, N(K.pct(lb.spread, 1), `${p}.levered.spread`, lb.spread), '）'];
      const oos = !robust ? { t: failed ? '计算失败' : '计算中…' }
        : oosT?.status === 'ok' ? { t: K.pct(oosT.stats.rule.cagr, 2), k: 'robust.byRule.tangency.walkForward.stats.rule.cagr', v: oosT.stats.rule.cagr } : { t: '—' };
      const y22 = lev.y2022 ? { t: `${K.pct(lev.y2022.rule, 2)} 对 ${K.pct(lev.y2022.spx, 2)}`, k: `${p}.levered.y2022.rule`, v: lev.y2022.rule } : { t: '—' };
      const wCell = lev.notional ? { t: K.notional(lev.notional, lev.L), k: `${p}.levered.notional` } : { t: K.weights(lev.w), k: `${p}.levered.w` };
      rows.push(row(levLabel, wCell, `${p}.levered`, lev.stats, [oos, y22]));
    }
    if (t.implied?.w) rows.push(row(['不加杠杆·同波动隐含截距 ', fin(cStar) ? N(K.pct(cStar), cStarKey, cStar) : '—'], { t: K.weights(t.implied.w), k: `${p}.implied.w` }, `${p}.implied`, t.implied.stats));
    fill(capmTable, [tableBlock({ caption: 'CAPM 切点：加杠杆与不加杠杆', head: [['组合', '配置（纳指/标普/美债）', '年化波动', '年化复合收益', '夏普', '最大回撤', '样本外年化', '2022年']], rows, className: 'table table--capm' })]);
    fill(capmCaption, C.capmCaption(alloc));

    const path = alloc.tangencyPath;
    const pts = (path?.points ?? []).filter((q) => q.w);
    if (pts.length) {
      const markers = [[t.cRf, '无风险'], [t.cY10, '10年期'], [cStar, '隐含'], [st.intercept === 'custom' ? st.interceptC : null, '自定义']]
        .filter(([x]) => fin(x)).map(([x, label]) => ({ x, label }));
      const lo = Math.min(...markers.map((m) => m.x)) - 0.01;
      const hi = (fin(path.cAllNdx) ? path.cAllNdx : pts[pts.length - 1].c) + 0.01;
      pathChart.setTitle(['截距→切点权重']);
      pathChart.update({ key: `${keyOf(alloc)}|path`, x: pts.map((q) => q.c), xFormat: 'pct', domain: [Math.max(lo, pts[0].c), Math.min(hi, pts[pts.length - 1].c)],
        series: ASSETS.map((a, i) => ({ id: a.id, label: a.label, colorVar: a.colorVar, values: pts.map((q) => q.w[i]) })), markers });
    }
    fill(pathCaption, C.interceptCaption(alloc));
  }

  function renderTwo(alloc, sample, st) {
    const ta = alloc.rules.twoAsset;
    const pair = ta.params?.pair ?? st.pair;
    pairSel.set(PAIRS.map(([v, label]) => ({ value: v.join('-'), label })), pair.join('-'));
    fill(taStatus, C.twoAssetStatus(ta, pair) ?? []);
    const spx = sample?.h2h?.spx;
    // a key point at a trivial root (100% 标普500) is 标普500 itself
    const trivialName = (q) => ((ta.roots?.trivial ?? []).some((x0) => Math.abs(x0 - q.x) < 1e-9) ? `（即${ASSET_LABEL[q.x > 0.5 ? pair[0] : pair[1]]}本身）` : '');
    if (ta.curve) {
      panels.update({ key: `${keyOf(alloc)}|two`, x: ta.curve.x, xLabel: `${ASSET_LABEL[pair[0]]} 权重（其余为${ASSET_LABEL[pair[1]]}）`,
        panels: [{ id: 'sharpe', label: '夏普比率', values: ta.curve.sharpe, spxValue: spx?.sharpe ?? ta.spx?.sharpe, yFormat: 'num' },
          { id: 'cagr', label: '年化复合收益', values: ta.curve.cagr, spxValue: spx?.cagr ?? ta.spx?.cagr, yFormat: 'pct' }],
        guides: (ta.points ?? []).map((q) => ({ x: q.x, label: pointLabel(q) })) });
    }
    const kp = 'alloc.rules.twoAsset.points';
    const rows = (ta.points ?? []).map((q, i) => [{ t: `${pointLabel(q)}${trivialName(q)}`, th: true }, { t: K.pct(q.x, 1), k: `${kp}.${i}.x`, v: q.x },
      ...['cagr', 'sharpe', 'vol', 'mdd', 'worst12m'].map((m) => ({ t: m === 'sharpe' ? K.sharpe(q.stats?.[m]) : K.pct(q.stats?.[m], 2), k: `${kp}.${i}.stats.${m}`, v: q.stats?.[m] }))]);
    fill(pointsBox, rows.length ? [tableBlock({ caption: '两资产关键点', head: [['点', `${ASSET_LABEL[pair[0]]} 权重`, '年化', '夏普', '波动', '最大回撤', '最差12个月']], rows, className: 'table table--points' })] : []);
  }

  function renderCustom(alloc, st) {
    fillIdx = st.fill ?? 2;
    fillSel.set(ASSETS.map((a, i) => ({ value: String(i), label: a.label })), String(fillIdx));
    const w = st.customW ?? alloc.rules.custom?.w ?? alloc.rules.isoVolTe.w;
    customW = K.roundWeights(w);
    drawCustom();
  }

  return {
    root,
    render(v) {
      view = v;
      const { alloc, sample } = v.bundles;
      const robust = robustReady(v);
      const failed = !!v.errors?.robust;
      const st = v.state;
      const active = st.rule;
      for (const [id, node] of Object.entries(byRule)) node.hidden = id !== active;
      mu.hidden = !(active === 'isoVolTe' || active === 'tangency');
      muSel.set([{ value: 'hist', label: '历史均值' }, { value: 'y10bond', label: '美债=10年期收益率' }], st.basis === 'pr' ? 'hist' : st.mu, { disabled: st.basis === 'pr' });
      if (!alloc) return;
      muHeader.hidden = st.mu !== 'y10bond' || !sample;
      if (!muHeader.hidden) fill(muHeader, [el('span', { class: 'chip chip--warn' }, ['假设']), ' ', C.y10Header(sample, alloc)]);
      const base = `${keyOf(alloc)}|${keyOf(robust)}|${!!robust}|${failed}`;
      if (active === 'isoVolTe' && changed('iso', base)) renderIso(alloc, st);
      if (active === 'maxSharpeCagrFloor' && changed('msf', base)) fill(msfNote, C.maxSharpeNote(robust, st, failed));
      if (active === 'tangency' && changed('tan', `${base}|${keyOf(sample)}|${st.interceptC}`)) renderTangency(alloc, robust, st, failed);
      if (active === 'twoAsset' && changed('two', `${base}|${keyOf(sample)}`)) renderTwo(alloc, sample, st);
      if (active === 'custom' && changed('custom', `${base}|${st.fill}`)) renderCustom(alloc, st);
    },
  };
}
