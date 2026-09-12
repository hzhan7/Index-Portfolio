// §2 超额从哪来: answer, identity, bar-table, 1985-01 P/E-ratio slider, Bloomberg import.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { createCopy } from '../copy.js?v=20260912';
import { buildTable } from '../table.js?v=20260912';
import { mountPoint, statusLine, applyStatus, loadChart, rangeControl, debounce } from './common.js?v=20260912';

const NUM_COLS = [['price_lp_yr', '价格差'], ['pe_lp_yr', '估值'], ['eps_lp_yr', 'EPS'], ['div_lp_yr', '股息'], ['tr_lp_yr', '总回报差']];
const HEAD = [['期间', ...NUM_COLS.map((c) => c[1]), 'EPS占价格差', '来源']];
const EXTRA_TIERS = { user: '自定义', user_export: '你的数据' };
const M0_MIN = 0.5, M0_MAX = 4;
const frac = (m) => (m - M0_MIN) / (M0_MAX - M0_MIN);
const pos = (m) => `${(frac(m) * 100).toFixed(2)}%`;

// Decomposition rows → bar-table spec; barCell (CHARTS) is applied after the table is in the DOM.
function barTable({ rows, spliceRow, full, total }, { C, tiers, prefix, caption }) {
  const { K } = C;
  const list = [...rows.map((r, i) => ({ r, k: `${prefix}.rows.${i}` }))];
  if (spliceRow) list.push({ splice: spliceRow, k: `${prefix}.spliceRow` });
  if (full) list.push({ r: full, k: `${prefix}.full`, cls: 'row-total' });
  if (total) list.push({ r: total, k: `${prefix}.total`, cls: 'row-total' });
  const domains = NUM_COLS.map(([key]) => {
    const vals = list.flatMap(({ r }) => (r && Number.isFinite(r[key]) ? [r[key]] : []));
    const m = Math.max(1e-9, ...vals.map(Math.abs));
    return [Math.min(0, ...vals, -m * 0.05), Math.max(0, ...vals, m * 0.05)];
  });
  const bars = [];
  const tierText = (r) => [...new Set([r.startTier, r.endTier].map((t) => tiers[t] ?? EXTRA_TIERS[t] ?? t))].join('→') + (r.splice ? '（拼接）' : '');
  const specRows = list.map(({ r, splice, k, cls }) => {
    if (splice) {
      return { cls: 'row-splice', cells: [{ t: `${splice.label}（按全期年数摊）`, th: true }, { t: '—' },
        { t: K.lp(splice.lp_yr, 2), k: `${k}.lp_yr`, v: splice.lp_yr }, { t: K.lp(-splice.lp_yr, 2), k: `derived:0-${k}.lp_yr`, v: -splice.lp_yr }, { t: '—' }, { t: '—' }, { t: '—' }, { t: '口径差' }] };
    }
    // displayed terms add up: 价格差 = 估值 + EPS and 总回报差 = 价格差 + 股息 at 2 dp (data-v stays raw)
    const u = C.decompUnits(r, 2);
    const numCells = NUM_COLS.map(([key], j) => {
      const v = r[key];
      const cell = { t: Number.isInteger(u[key]) ? K.lp(u[key] / 100, 2) : Number.isFinite(v) ? K.lp(v, 2) : '—', k: `${k}.${key}`, v };
      if (Number.isFinite(v)) {
        const bar = { value: v, domain: domains[j], k: cell.k, td: null, text: cell.t };
        cell.ref = (td) => { bar.td = td; };
        bars.push(bar);
      }
      return cell;
    });
    const share = r.sharesPrice?.eps;
    return {
      cls,
      cells: [{ t: r.label, sub: r.id === 'full' || cls ? `${r.start}～${r.end}` : null, th: true }, ...numCells,
        Number.isFinite(share) ? { t: K.pct(share, 2), k: `${k}.sharesPrice.eps`, v: share } : { t: 'n/m' }, { t: tierText(r) }],
    };
  });
  return { spec: { caption, head: HEAD, rows: specRows, className: 'table table--bars' }, bars };
}

async function renderBars(api, bars, K) {
  let mod;
  try { mod = await loadChart(api, 'barCell'); } catch { return; }
  if (!mod?.render) return;
  for (const b of bars) if (b.td) mod.render(b.td, { value: b.value, domain: b.domain, k: b.k, format: (v) => b.text ?? K.lp(v, 2) });
}

export function mount(rootEl, api) {
  const C = createCopy(api.format);
  const { K, N } = C;
  const host = mountPoint(rootEl);
  const status = statusLine();
  const answer = el('div', { class: 'section-answer' });
  const formula = el('p', { class: 'note decomp__formula' }, ['纳指/标普价格比 = 相对市盈率 × 相对EPS；同一行内 价格差 = 估值 + EPS，总回报差 = 价格差 + 股息差（对数口径，单位：个百分点/年；各区间年数不同，年化值不能跨行相加）']);
  const tableHost = el('div', { class: 'table-scroll decomp__table', tabindex: '0', role: 'region', 'aria-label': '十年分段拆分' });
  const readout = el('p', { class: 'decomp__readout' });
  const slider = rangeControl({ label: '1985-01 纳指/标普市盈率比', min: M0_MIN, max: M0_MAX, step: 0.01, cls: 'range--m0', onInput: (m) => preview(m), onCommit: (m) => commit(m) });
  const ticks = el('div', { class: 'm0-ticks', 'aria-hidden': 'true' });
  const tickNote = el('p', { class: 'note m0-ticks__note' });
  const reset = el('button', { type: 'button', class: 'btn btn--ghost' });
  reset.addEventListener('click', () => api.setState({ m0: null }));
  const bbgBox = el('div', { class: 'bbg__body' });
  const details = el('details', { class: 'bbg' }, [el('summary', {}, ['用你的彭博数据重算（只在浏览器本地计算，不上传）']), bbgBox]);
  details.addEventListener('toggle', () => details.open && buildBbg());

  host.appendChild(status);
  host.appendChild(answer);
  host.appendChild(formula);
  host.appendChild(tableHost);
  host.appendChild(el('div', { class: 'decomp__slider' }, [slider.root, ticks, tickNote, el('div', { class: 'param-row' }, [readout, reset])]));
  host.appendChild(details);

  let ctxSig = '', view0 = null, dragging = false;
  const valuation = () => api.data?.valuation;
  const tiers = () => valuation()?.tiers ?? {};

  function drawTable(dec, prefix = 'context.decomp') {
    const { spec, bars } = barTable(dec, { C, tiers: tiers(), prefix, caption: '纳指100 − 标普500 分段拆分（个百分点/年）' });
    const table = buildTable(spec);
    fill(tableHost, [table]);
    renderBars(api, bars, K);
  }

  function setReadout(be, m) {
    const split = api.engine?.decomp?.splitAtM0?.(be, m);
    fill(readout, split ? C.sliderReadout(split) : []);
  }

  function preview(m) {
    dragging = true;
    slider.out.textContent = K.num(m, 2);
    const st = view0?.state ?? api.getState();
    const be = view0?.bundles.context?.decomp.breakEven;
    if (be) setReadout(be, m);
    const eng = api.engine?.decomp;
    if (eng?.anchorDecomposition && api.data?.history && valuation()) {
      drawTable(eng.anchorDecomposition(api.data.history, valuation(), { ndxDiv: st.ndxDiv, wht: st.wht, m0: m }));
    }
  }

  const commitNow = debounce((m) => {
    dragging = false;
    const central = valuation()?.m0_1985?.central;
    const next = Number.isFinite(central) && Math.abs(m - central) < 0.005 ? null : Math.round(m * 100) / 100;
    const same = (api.getState().m0 ?? null) === next;
    api.setState({ m0: next });
    if (same && view0) drawContext(view0, true); // unchanged job key: restore the committed table and readout
  }, 150);
  const commit = (m) => commitNow(m);

  function drawContext(view, force = false) {
    const ctx = view.bundles.context;
    if (!ctx?.decomp || (!force && keyOf(ctx) === ctxSig)) return;
    ctxSig = keyOf(ctx);
    const m = view.state.m0 ?? ctx.decomp.full.m0Used ?? valuation()?.m0_1985?.central;
    fill(answer, C.decompAnswer(ctx).map((s) => el('p', {}, s)));
    drawSliderFrame(ctx.decomp.breakEven);
    if (!dragging && Number.isFinite(m)) {
      slider.input.value = String(m);
      slider.out.textContent = K.num(m, 2);
    }
    // the readout uses the exact M0 behind the table's 全期 row (the range input snaps to 0.01)
    setReadout(ctx.decomp.breakEven, !dragging && Number.isFinite(m) ? m : Number(slider.input.value));
    drawTable(ctx.decomp);
  }

  function drawSliderFrame(be) {
    const v = valuation();
    const band = v?.m0_1985;
    if (band) {
      slider.zone('band', frac(band.low), frac(band.high), 'range__zone--band');
      reset.textContent = `恢复估算中值 ${K.num(band.central, 2)}`;
    }
    const p = be?.m0ForPeShare;
    if (p) {
      const shown = [['p0', '0%'], ['p25', '25%'], ['p50', '50%']].filter(([id]) => Number.isFinite(p[id]) && p[id] >= M0_MIN && p[id] <= M0_MAX);
      fill(ticks, shown.map(([id, label]) => {
        const tick = el('span', { class: 'm0-ticks__tick', title: `估值贡献 ${label}：${K.num(p[id], 2)}` }, [label]);
        tick.style.setProperty('--x', pos(p[id]));
        return tick;
      }));
      ticks.setAttribute('aria-label', '刻度为估值贡献 0% / 25% / 50% 时的市盈率比');
      // the ticks sit close together on the track, so their meaning is spelled out once below them
      fill(tickNote, shown.length ? ['刻度：估值贡献 ', shown.map(([, label]) => label).join(' / '), ' 对应市盈率比 ',
        ...shown.flatMap(([id], i) => [i ? ' / ' : '', N(K.num(p[id], 2), `context.decomp.breakEven.m0ForPeShare.${id}`, p[id])])] : []);
    }
  }

  // engine/bbg.js is imported on first open (api.engine.loadBbg); a preloaded api.engine.bbg is used as is.
  let bbgState = 'idle';
  async function buildBbg() {
    if (bbgState !== 'idle') return;
    bbgState = 'loading';
    fill(bbgBox, [el('p', { class: 'note' }, ['加载中…'])]);
    let bbg = api.engine?.bbg ?? null;
    try { bbg ??= await api.engine?.loadBbg?.(); } catch { bbg = null; }
    if (!bbg?.parseExport) {
      bbgState = 'idle';
      fill(bbgBox, [el('p', { class: 'note is-error' }, ['彭博导入模块加载失败：收起后重新展开可重试'])]);
      return;
    }
    bbgState = 'ready';
    const recipe = bbg.recipeText && view0?.latest ? bbg.recipeText(view0.latest) : bbg.RECIPE_TEXT;
    const template = Array.isArray(bbg.EXPORT_TEMPLATE_CSV) ? bbg.EXPORT_TEMPLATE_CSV.join('\n') : bbg.EXPORT_TEMPLATE_CSV;
    const copyBtn = (label, textValue) => el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => {
      const done = () => api.toast('已复制');
      const fail = () => api.toast('复制失败：请手动选中文本');
      globalThis.navigator?.clipboard?.writeText ? globalThis.navigator.clipboard.writeText(textValue).then(done, fail) : fail();
    } } }, [label]);
    const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': '选择彭博导出文件' });
    const paste = el('textarea', { class: 'bbg__paste', rows: 6, placeholder: '或把 Excel 中的数据区域直接粘贴到这里', 'aria-label': '粘贴彭博导出数据' });
    const run = el('button', { type: 'button', class: 'btn' }, ['计算']);
    const coverage = el('p', { class: 'note bbg__coverage' });
    const issues = el('ul', { class: 'note bbg__issues' });
    const result = el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '你的彭博数据拆分结果' });
    const compute = (input) => {
      fill(issues, []);
      fill(result, []);
      try {
        const parsed = bbg.parseExport(input);
        const ref = api.data?.history?.observations?.map((o) => ({ month: o.month, NDX: o.NDX, SPX: o.SPX }));
        const check = bbg.validate(parsed, ref ?? null);
        const dec = bbg.decadeRows(parsed);
        const cov = dec.coverage;
        fill(coverage, [cov ? `覆盖：市盈率 ${cov.from}～${cov.to}` : '覆盖：没有成对的市盈率', ` · 错误 ${check.errors.length} · 提示 ${check.warnings.length}`]);
        fill(issues, [...check.errors, ...check.warnings, ...(dec.flags ?? [])].slice(0, 5).map((t) => el('li', {}, [t])));
        const rows = dec.rows.filter(Boolean);
        if (rows.length) {
          const total = dec.total ? { ...dec.total, id: 'total', label: '合计', startTier: 'user_export', endTier: 'user_export', splice: false } : null;
          const { spec, bars } = barTable({ rows, total }, { C, tiers: tiers(), prefix: 'bbg', caption: '你的彭博数据：分段拆分（个百分点/年）' });
          const table = buildTable(spec);
          fill(result, [table]);
          renderBars(api, bars, K);
        }
      } catch (err) {
        fill(coverage, [`读取失败：${err.message}`]);
      }
    };
    file.addEventListener('change', () => file.files?.[0]?.text().then(compute, (e) => fill(coverage, [`读取失败：${e.message}`])));
    run.addEventListener('click', () => compute(paste.value));
    fill(bbgBox, [
      el('div', { class: 'param-row' }, [copyBtn('复制导出步骤', recipe), copyBtn('复制CSV模板', template)]),
      el('pre', { class: 'bbg__recipe', tabindex: '0' }, [recipe]),
      el('div', { class: 'bbg__inputs' }, [file, paste, run]),
      coverage, issues, result,
    ]);
  }

  return {
    render(view) {
      view0 = view;
      applyStatus(host, status, view, ['context']);
      drawContext(view);
    },
  };
}
