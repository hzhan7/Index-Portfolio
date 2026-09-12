// §4 权重靠得住吗: walk-forward figure (relative line + aligned weights) + stats, bootstrap ranges.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { createCopy, RULE_LABELS } from '../copy.js?v=20260912';
import { tableBlock } from '../table.js?v=20260912';
import { mountPoint, statusLine, applyStatus, chartSlot, segControl, addMonths, ASSETS } from './common.js?v=20260912';

const STAGES = { wf: '样本外', walkForward: '样本外', bs: '重抽样', bootstrap: '重抽样' };
const stageLabel = (s = '') => { const [type, rule] = String(s).split(':'); return `${STAGES[type] ?? type}${RULE_LABELS[rule] ? `·${RULE_LABELS[rule]}` : ''}`; };
const MARGINS = { top: 12, right: 16, bottom: 28, left: 56 };
const WF_ROWS = [['rule', '规则'], ['spx', '标普500'], ['ndx', '纳指100'], ['sixty40', '60/40']];
const STAT_COLS = [['cagr', '年化复合收益'], ['sharpe', '夏普'], ['vol', '年化波动'], ['mdd', '最大回撤'], ['worst12m', '最差12个月']];
const fin = Number.isFinite;
// Tangency robustness (walk-forward and bootstrap) is the levered kinked CAL (engine robustVariant 'levered'), i.e. the
// 切点×杠杆 row of 你问过的组合, not the unlevered tangency on the §3 card.
const robustLabel = (id) => (id === 'tangency' ? '切点×杠杆' : RULE_LABELS[id]);

export const wfRuleFor = (active, robust) => (active === 'custom' && robust?.byRule?.custom?.walkForward ? 'custom'
  : active === 'twoAsset' || active === 'custom' ? 'isoVolTe' : active);
export const bsRuleFor = (active, robust) => ((active === 'maxSharpeCagrFloor' || active === 'tangency') && robust?.byRule?.[active]?.bootstrap ? active : 'isoVolTe');

// Weights held between rebalances on the monthly x axis of the relative-wealth line: the risky weights (sum 1, so the
// 100% stack never clips) and, for levered rules, that rebalance's leverage L.
export function heldWeights(weights, x) {
  let j = 0;
  return x.map((m) => {
    while (j + 1 < weights.length && weights[j + 1].month <= m) j += 1;
    const w = weights[j];
    return { w: Array.from(w.w), L: fin(w.L) ? w.L : null };
  });
}

export function mount(rootEl, api) {
  const C = createCopy(api.format);
  const { K, N } = C;
  const host = mountPoint(rootEl);
  // app.js mounts into the section's [data-mount]; the <h2> sits beside it in the section
  const heading = rootEl.querySelector?.('h2') ?? rootEl.closest?.('section')?.querySelector('h2') ?? null;
  const status = statusLine();
  const progress = el('p', { class: 'note robust__progress', 'aria-live': 'polite' });
  const note = el('p', { class: 'note', hidden: true });
  const windowSeg = segControl({ label: '估计窗口', options: [{ value: 'trailing', label: '过去10年' }, { value: 'expanding', label: '全部历史' }], onSelect: (v) => api.setState({ wfWindow: v }) });
  const line = chartSlot(api, 'lineChart', { ariaLabel: '规则相对标普500净值（样本外）', filename: 'walk_forward.csv' });
  const weights = chartSlot(api, 'stackedArea', { ariaLabel: '样本外每年1月重估的权重', filename: 'walk_forward_weights.csv' });
  const wfStatus = el('p', { class: 'note', hidden: true });
  const statsBox = el('div', { class: 'robust__stats' });
  const wfExtra = el('p', { class: 'note' });
  const bsRows = el('div', { class: 'whisker-rows' });
  const bsProb = el('p', { class: 'card__line' });
  const wfFigure = el('div', { class: 'robust__wf' }, [line.root, weights.root]);

  host.appendChild(status);
  host.appendChild(progress);
  host.appendChild(note);
  host.appendChild(el('h3', { class: 'subhead' }, ['样本外：每年1月重估']));
  host.appendChild(el('div', { class: 'param-row' }, [el('span', { class: 'param-label' }, ['估计窗口']), windowSeg.root]));
  host.appendChild(wfStatus);
  host.appendChild(wfFigure);
  host.appendChild(statsBox);
  host.appendChild(wfExtra);
  const bsHead = el('h3', { class: 'subhead' }, ['重抽样权重区间（p10～p90）']);
  host.appendChild(bsHead);
  host.appendChild(bsRows);
  host.appendChild(bsProb);

  const sig = {};
  const changed = (name, key) => (sig[name] === key ? false : ((sig[name] = key), true));

  // 杠杆 {min}～{max}倍（最近 {month} {L}倍）, each number keyed to its rebalance.
  function leverageNote(wf, p) {
    const Ls = wf.weights.map((w, j) => [w.L, j]).filter(([L]) => fin(L));
    if (!Ls.length) return [];
    const lo = Ls.reduce((a, b) => (b[0] < a[0] ? b : a)), hi = Ls.reduce((a, b) => (b[0] > a[0] ? b : a)), last = Ls[Ls.length - 1];
    const n = ([L, j]) => N(K.num(L, 2), `${p}.weights.${j}.L`, L);
    return ['杠杆 ', n(lo), '～', n(hi), '倍（最近 ', N(wf.weights[last[1]].month, `${p}.weights.${last[1]}.month`), ' ', n(last), '倍）'];
  }

  function drawWalkForward(wf, id, robust) {
    const ok = wf?.status === 'ok';
    wfStatus.hidden = ok;
    wfFigure.hidden = !ok;
    statsBox.hidden = !ok;
    if (!ok) {
      fill(wfStatus, [wf ? '样本外不足36个月' : '样本外计算中…']);
      fill(wfExtra, []);
      return;
    }
    const p = `robust.byRule.${id}.walkForward`;
    const rel = Array.from(wf.relToSpx);
    // wealth[0] sits at the month before the first OOS return; engine oosMonths lists the n return months.
    const oosMonths = [wf.oosMonths, wf.months].find((m) => Array.isArray(m) && m.length === rel.length - 1 && m.length > 0);
    const x = oosMonths ? [addMonths(oosMonths[0], -1), ...oosMonths] : rel.map((_, k) => addMonths(wf.firstOos, k - 1));
    const ndx = Array.from(wf.series.ndx), spx = Array.from(wf.series.spx);
    const label = robustLabel(id);
    const key = `${keyOf(robust)}|${id}`;
    line.setTitle([`${label} ÷ 标普500（对数，1=持平）`]);
    line.update({ key, x, yScale: 'log', yFormat: 'ratio', baseline: 1, bands: [], margins: MARGINS,
      series: [{ id: 'rule', label: `${label} ÷ 标普500`, colorVar: '--ink', values: rel, emphasis: true },
        { id: 'ndx', label: '纳指100 ÷ 标普500', colorVar: '--muted', values: ndx.map((v, i) => v / spx[i]), emphasis: false }] });
    const held = heldWeights(wf.weights, x);
    const levered = wf.weights.some((w) => fin(w.L));
    weights.setTitle([levered ? '风险资产权重（杠杆倍数另列）' : '权重']);
    weights.update({ key: `${key}|w`, x, xFormat: 'month', margins: MARGINS, markers: [], tableX: wf.weights.map((w) => w.month),
      series: ASSETS.map((a, i) => ({ id: a.id, label: a.label, colorVar: a.colorVar, values: held.map((h) => h.w[i]) })),
      extra: levered ? [{ id: 'L', label: '杠杆倍数', values: held.map((h) => h.L), format: 'multiple' }] : [] });
    const statCells = (s, rowKey) => STAT_COLS.map(([m]) => ({ t: m === 'sharpe' ? K.sharpe(s?.[m]) : K.pct(s?.[m], 2), k: `${rowKey}.${m}`, v: s?.[m] }));
    const rows = WF_ROWS.filter(([r]) => wf.stats[r]).map(([r, name]) => [{ t: r === 'rule' ? label : name, th: true }, ...statCells(wf.stats[r], `${p}.stats.${r}`)]);
    const iss = wf.inSampleStatic;
    if (iss?.stats) {
      const sub = iss.notional && fin(iss.L) ? [N(K.notional(iss.notional, iss.L), `${p}.inSampleStatic.notional`)] : [N(K.weights(iss.w), `${p}.inSampleStatic.w`)];
      rows.push({ cls: 'row-muted', cells: [{ t: '样本内静态（含未来信息）', th: true, sub }, ...statCells(iss.stats, `${p}.inSampleStatic.stats`)] });
    }
    fill(statsBox, [tableBlock({ caption: `样本外（${wf.firstOos}起）`, head: [['组合', ...STAT_COLS.map((c) => c[1])]], rows, className: 'table table--wf' })]);
    const years = wf.weights.length;
    const ustArr = Array.isArray(wf.ustOver50Years);
    const ust = ustArr ? wf.ustOver50Years.length : wf.ustOver50Years;
    const extra = [];
    const sep = () => (extra.length ? ' · ' : '');
    if (wf.y2022) extra.push(`2022年：${label} `, N(K.pct(wf.y2022.rule, 1), `${p}.y2022.rule`, wf.y2022.rule), ' · 标普500 ', N(K.pct(wf.y2022.spx, 1), `${p}.y2022.spx`, wf.y2022.spx));
    if (fin(ust)) extra.push(sep(), N(String(ust), `${p}.ustOver50Years${ustArr ? '.length' : ''}`, ust), '/', N(String(years), `${p}.weights.length`, years), ' 年美债超过一半');
    if (wf.infeasibleWindows) extra.push(sep(), N(String(wf.infeasibleWindows), `${p}.infeasibleWindows`, wf.infeasibleWindows), `/${years} 年无可行解，按标普500持有`);
    if (levered) extra.push(sep(), ...leverageNote(wf, p));
    fill(wfExtra, extra);
  }

  function drawBootstrap(bs, id) {
    bsHead.textContent = bs?.variant === 'levered' ? '重抽样风险资产权重区间（p10～p90，未乘杠杆）' : '重抽样权重区间（p10～p90）';
    if (!bs) {
      fill(bsRows, [el('p', { class: 'note' }, ['重抽样计算中…'])]);
      fill(bsProb, []);
      return;
    }
    fill(bsRows, C.bootstrapRows(bs, id).map((segs) => el('p', { class: 'whisker-row' }, segs)));
    const prob = C.probLine(bs, id);
    bsProb.hidden = !prob.length;
    fill(bsProb, prob);
  }

  return {
    render(view) {
      applyStatus(host, status, view, ['robust']);
      const st = view.state;
      const robust = view.bundles.robust;
      windowSeg.set(st.wfWindow);
      const pr = view.progress?.robust;
      progress.hidden = !(view.pending?.robust && pr);
      if (pr) fill(progress, [`计算中：${stageLabel(pr.stage)} ${pr.done ?? 0}/${pr.total ?? 0}`]);
      const wfId = wfRuleFor(st.rule, robust);
      const bsId = bsRuleFor(st.rule, robust);
      if (heading) heading.textContent = C.robustHeading(robustLabel(wfId));
      const n = C.robustNote(st.rule, st.pair);
      note.hidden = !n;
      note.textContent = n ?? '';
      if (!changed('all', `${keyOf(robust)}|${!!robust}|${wfId}|${bsId}`)) return;
      drawWalkForward(robust?.byRule?.[wfId]?.walkForward ?? null, wfId, robust);
      drawBootstrap(robust?.byRule?.[bsId]?.bootstrap ?? null, bsId);
    },
  };
}
