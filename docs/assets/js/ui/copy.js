// Pure copy templates: bundles → Chinese segments. A segment is a string or {t, k, v}
// (display text, bundle path for data-k, raw decimal for data-v). No DOM, no data-derived literals.
// data-k is a bundle path, or `derived:<path>(<op><path|number>)*` (ops + − * /, left to right) for a value the UI
// computes from bundle fields; data-v is always the raw value that key resolves to.

const MINUS = '−';
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const SHARPE_DP = 3; // 2 dp breaks visible subtraction (0.61 − 0.58 ≠ −0.04)

export const RULE_LABELS = {
  isoVolTe: '同波动·收益最高', maxSharpeCagrFloor: '收益≥标普·夏普最高', tangency: '切点组合', twoAsset: '纳指+美债', custom: '自定义',
};
export const ASSET_SHORT = ['纳指', '标普', '美债'];
export const ASSET_LABEL = ['纳指100', '标普500', '10年美债'];
export const TE_CHIPS = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];

export const text = (segs) => [segs].flat(Infinity).map((s) => (s == null ? '' : typeof s === 'object' ? s.t : String(s))).join('');

function largestRemainder(w) {
  const raw = w.map((x) => Math.max(0, x) * 100);
  const base = raw.map(Math.floor);
  const rest = 100 - base.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(0, rest)).forEach(([, i]) => { base[i] += 1; });
  return base;
}

// Integer display units of x at dp decimals (toPrecision guard as in lib/format.js).
const units = (x, dp) => Math.round(Number((x * 10 ** dp).toPrecision(12))) + 0; // + 0 drops −0

/**
 * Display rounding that keeps a = b + c true on screen. Terms round normally (locked[i], integer units, is kept);
 * when the rounded terms miss, the unlocked term whose shifted value stays closest to its raw value moves.
 * Returns integer units [a, b, c] at dp decimals.
 */
export function addUp(values, dp, locked = []) {
  const raw = values.map((x) => x * 10 ** dp);
  const u = values.map((x, i) => (Number.isInteger(locked[i]) ? locked[i] : units(x, dp)) + 0);
  const miss = u[0] - u[1] - u[2];
  if (!miss) return u;
  const moves = [0, 1, 2].filter((i) => !Number.isInteger(locked[i]))
    .map((i) => { const next = u[i] + (i === 0 ? -miss : miss); return { i, next, cost: Math.abs(next - raw[i]) }; })
    .sort((p, q) => p.cost - q.cost);
  if (moves.length) u[moves[0].i] = moves[0].next;
  return u.map((x) => x + 0);
}

// Local fallbacks with the lib/format.js names; the real namespace (api.format) overrides them.
function signed(x, dp, plus) {
  if (!fin(x)) return '—';
  const s = Math.abs(x).toFixed(dp);
  return Number(s) === 0 ? s : `${x < 0 ? MINUS : plus ? '+' : ''}${s}`;
}
const LOCAL_FORMAT = {
  fmtNum: (x, dp = 2) => signed(x, dp, false),
  fmtNumSigned: (x, dp = 2) => signed(x, dp, true),
  fmtPct: (x, dp = 1) => (fin(x) ? `${signed(x * 100, dp, false)}%` : '—'),
  fmtPctSigned: (x, dp = 1) => (fin(x) ? `${signed(x * 100, dp, true)}%` : '—'),
  fmtPp: (x, dp = 1) => (fin(x) ? `${signed(x * 100, dp, true)}个百分点` : '—'),
  fmtLpBare: (x, dp = 1) => signed(x, dp, true),
  fmtRatio: (x, dp = 2) => (fin(x) ? `×${signed(x, dp, false)}` : '—'),
  roundWeights: largestRemainder,
};

// Formatting kit (§3.4) over lib/format.js.
export function formatKit(fmt = {}) {
  const F = { ...LOCAL_FORMAT, ...fmt };
  const fixed = (x, dp, sign = false) => (sign ? F.fmtNumSigned(x, dp) : F.fmtNum(x, dp));
  const roundWeights = (w) => F.roundWeights(Array.from(w));
  const weights = (w) => roundWeights(w).map((v, i) => `${ASSET_SHORT[i]} ${v}`).join(' / ');
  return {
    fixed,
    roundWeights,
    num: fixed,
    sharpe: (x, sign = false) => fixed(x, SHARPE_DP, sign),
    pct: (x, dp = 1, sign = false) => (sign ? F.fmtPctSigned(x, dp) : F.fmtPct(x, dp)),
    pp: (x, dp = 1) => F.fmtPp(x, dp),
    ppYr: (x, dp = 1) => (fin(x) ? `${F.fmtPp(x, dp)}/年` : '—'),
    lp: (v, dp = 1) => F.fmtLpBare(v, dp),
    ratio: (x, dp = 2) => F.fmtRatio(x, dp),
    int: (x) => (fin(x) ? fixed(x * 100, 0) : '—'),
    weights,
    // L > 1: notional weights with the leverage; L < 1: tangency share plus the cash leg (sums to 100).
    notional: (n, L) => {
      const arr = Array.from(n);
      if (fin(L) && L < 1 - 1e-6) {
        const ints = roundWeights([...arr, 1 - L]);
        return `${arr.map((_, i) => `${ASSET_SHORT[i]} ${ints[i]}`).join(' / ')} + 现金 ${ints[3]}（不加杠杆）`;
      }
      if (!fin(L) || L <= 1 + 1e-6) return weights(arr);
      return `${arr.map((x, i) => `${ASSET_SHORT[i]} ${fixed(x * 100, 0)}`).join(' / ')}（${fixed(L, 1)}倍杠杆）`;
    },
    range: (a, b) => (a === b ? a : `${a}～${b}`),
  };
}

export function createCopy(fmt) {
  const K = formatKit(fmt);
  const N = (t, k, v) => ({ t, k, v });
  const teLabel = (k) => (k == null ? '不限' : K.pct(k, 0));
  const ciHasZero = (ci) => !(ci.lo > 0 || ci.hi < 0);
  const pick = (ndxFirst, a, b) => (ndxFirst ? [a, b] : [b, a]);
  const walkWindow = (wf, state) => ((wf?.window ?? state?.wfWindow) === 'expanding' ? '全部历史' : `过去${fin(wf?.lookbackYears) ? wf.lookbackYears : 10}年`);
  const same = (a, b, tol = 5e-4) => !!a && !!b && a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - b[i]) < tol);
  // "≥ x" thresholds round up so the statement holds at the displayed value.
  const ceilPct = (x, dp = 2) => K.pct(Math.ceil(Number((x * 10 ** (dp + 2)).toPrecision(12)) - 1e-9) / 10 ** (dp + 2), dp);
  // Volatility target m × σ_SPX as text segments.
  const volTarget = (m, sigma) => (Math.abs(m - 1) < 1e-9
    ? ['标普500 ', N(K.pct(sigma), 'alloc.ctx.sigmaSpx', sigma)]
    : ['标普500×', K.num(m, 2), '（', N(K.pct(m * sigma), `derived:alloc.ctx.sigmaSpx*${m}`, sigma * m), '）']);

  // ---------- §0 hero ----------
  function heroAnswer(sb) {
    const { ndx, spx, sharpeDiffCI: ci } = sb.h2h;
    const p = 'sample.h2h';
    const retNdx = ndx.cagr >= spx.cagr;
    const [rl, ro] = pick(retNdx, ['纳指100', ndx, 'ndx'], ['标普500', spx, 'spx']);
    const shNdx = ndx.sharpe > spx.sharpe;
    const [sl, so] = pick(shNdx, ['纳指100', ndx, 'ndx'], ['标普500', spx, 'spx']);
    const sig = !ciHasZero(ci);
    const tie = Math.abs(ndx.sharpe - spx.sharpe) < 0.5 * 10 ** -SHARPE_DP; // equal at the displayed precision
    return [
      `收益选${rl[0]}：年化 `, N(K.pct(rl[1].cagr), `${p}.${rl[2]}.cagr`, rl[1].cagr), ' 对 ', N(K.pct(ro[1].cagr), `${p}.${ro[2]}.cagr`, ro[1].cagr), '。',
      tie ? '风险调整后持平：' : shNdx === retNdx ? `风险调整后也是${sl[0]}：` : `风险调整后${sl[0]}${sig ? '更优' : '略优'}：`,
      '夏普 ', N(K.sharpe(sl[1].sharpe), `${p}.${sl[2]}.sharpe`, sl[1].sharpe), ' 对 ', N(K.sharpe(so[1].sharpe), `${p}.${so[2]}.sharpe`, so[1].sharpe),
      `（95%区间${sig ? '不含0' : '含0'}）。`,
    ];
  }

  function heroMeta(sb, state = {}) {
    const s = sb.sample;
    const wht = state.wht > 1 ? state.wht / 100 : state.wht;
    const range = [N(s.start, 'sample.sample.start'), '～', N(s.end, 'sample.sample.end')];
    const rest = [` · ${s.basis === 'pr' ? '价格口径' : '含息总回报'} · 美元 · 每月再平衡`];
    if (wht > 0) rest.push(` · 股息预扣税 ${K.pct(wht, 0)}`);
    const line = [...range, ...rest];
    const chips = [];
    const imp = sb.h2h.estimateImpact;
    const r = imp?.ndxCagr;
    if (s.basis === 'tr' && s.estimated?.ndxDiv && Array.isArray(r) && fin(r[0]) && fin(r[1])) {
      const [hi, lo] = r[1] >= r[0] ? [1, 0] : [0, 1];
      const h = (r[hi] - r[lo]) / 2;
      const sd = imp.sharpeDiff;
      chips.push({
        cls: 'chip chip--prov',
        text: ['含估算股息：纳指100年化 ±', N(K.fixed(h * 100, 2), `derived:sample.h2h.estimateImpact.ndxCagr.${hi}-sample.h2h.estimateImpact.ndxCagr.${lo}/2`, h), '个百分点'],
        title: Array.isArray(sd) ? `纳指100股息估算低/高：夏普差 ${K.sharpe(Math.min(...sd), true)}～${K.sharpe(Math.max(...sd), true)}` : null,
      });
    }
    chips.push({ cls: 'chip chip--prov', text: ['10年美债为模型'], title: '由10年期国债收益率推算的含票息月收益' });
    return { line, range, rest, chips };
  }

  // Total-return vs price-basis Sharpe leader flip, explained by the dividend gap (null when there is no flip).
  function divFlip(sb) {
    const { ndx, spx, priceBasis: pb, divContribution: dc } = sb.h2h;
    if (sb.sample.basis !== 'tr' || !pb || !dc || ![pb.ndxSharpe, pb.spxSharpe, dc.ndx, dc.spx, ndx.sharpe, spx.sharpe].every(fin)) return null;
    const trNdx = ndx.sharpe > spx.sharpe, prNdx = pb.ndxSharpe > pb.spxSharpe;
    if (trNdx === prNdx || (dc.ndx > dc.spx) !== trNdx) return null;
    const p = 'sample.h2h';
    const [a, b] = pick(prNdx, ['纳指100', 'ndxSharpe'], ['标普500', 'spxSharpe']);
    const gap = trNdx ? dc.ndx - dc.spx : dc.spx - dc.ndx;
    return [
      '价格口径', a[0], '夏普更高（', N(K.sharpe(pb[a[1]]), `${p}.priceBasis.${a[1]}`, pb[a[1]]), ' 对 ', N(K.sharpe(pb[b[1]]), `${p}.priceBasis.${b[1]}`, pb[b[1]]),
      '），', trNdx ? '纳指100' : '标普500', '股息每年多 ',
      N(K.fixed(gap * 100, 2), trNdx ? `derived:${p}.divContribution.ndx-${p}.divContribution.spx` : `derived:${p}.divContribution.spx-${p}.divContribution.ndx`, gap),
      '个百分点，含息后反超',
    ];
  }

  function card1(sb) {
    const { ndx, spx, diff, volMatched: vm, sharpeDiffCI: ci } = sb.h2h;
    const p = 'sample.h2h';
    const shNdx = ndx.sharpe > spx.sharpe;
    const [a, b] = pick(shNdx, ['纳指100', ndx, 'ndx'], ['标普500', spx, 'spx']);
    const estimated = !!(sb.sample.estimated?.ndxDiv || sb.sample.estimated?.spxConstructed);
    const flip = divFlip(sb);
    return {
      eyebrow: sb.sample.basis === 'pr' ? '风险调整后谁更好（价格口径）' : '风险调整后谁更好（含股息）',
      big: ['夏普 ', a[0], ' ', N(K.sharpe(a[1].sharpe), `${p}.${a[2]}.sharpe`, a[1].sharpe), ' · ', b[0], ' ', N(K.sharpe(b[1].sharpe), `${p}.${b[2]}.sharpe`, b[1].sharpe)],
      lines: [
        ['年化 纳指100 ', N(K.pct(ndx.cagr), `${p}.ndx.cagr`, ndx.cagr), ' · 标普500 ', N(K.pct(spx.cagr), `${p}.spx.cagr`, spx.cagr), '（', N(K.pp(diff.cagr), `${p}.diff.cagr`, diff.cagr), '）',
          ...(flip ? ['；', ...flip] : [])],
        [vm.levered ? '加杠杆到标普波动后纳指100 年化 ' : '降到标普波动后纳指100 年化 ', N(K.pct(vm.ndxCagr), `${p}.volMatched.ndxCagr`, vm.ndxCagr),
          '（', N(K.pp(vm.spread), `${p}.volMatched.spread`, vm.spread), '）· 夏普差 ', N(K.sharpe(ci.point, true), `${p}.sharpeDiffCI.point`, ci.point),
          '（95%区间 ', N(K.sharpe(ci.lo, true), `${p}.sharpeDiffCI.lo`, ci.lo), '～', N(K.sharpe(ci.hi, true), `${p}.sharpeDiffCI.hi`, ci.hi), '）'],
      ],
      prov: estimated ? ['估算'] : [],
      target: 'compare',
    };
  }

  function losingText(r, p = 'context.rolling') {
    if (!r.nLose) return ['没有跑输的买入月份'];
    const top = r.losingRuns?.[0];
    if (!top) return ['跑输 ', N(String(r.nLose), `${p}.nLose`, r.nLose), '个买入月份'];
    return ['跑输主要在 ', N(K.range(top.from, top.to), `${p}.losingRuns.0`), '（', N(String(top.n), `${p}.losingRuns.0.n`, top.n), '/', N(String(r.nLose), `${p}.nLose`, r.nLose), '）'];
  }

  const rollHead = (r) => `持有${r.years}年${r.volMatched ? '·同波动调整' : ''}`;

  function rollingTitle(ctx) {
    const r = ctx.rolling;
    if (!r.n) return [`${rollHead(r)}：窗口不足`];
    return [`${rollHead(r)}：纳指100 在 `, N(K.pct(r.winRate), 'context.rolling.winRate', r.winRate), ' 的买入月份跑赢'];
  }

  const rollingStats = (r) => ['中位 ', N(K.ppYr(r.median), 'context.rolling.median', r.median), ' · 最差买入 ', N(r.worst.start, 'context.rolling.worst.start'),
    '（', N(K.ppYr(r.worst.excess), 'context.rolling.worst.excess', r.worst.excess), '）· ', losingText(r)];

  function rollingAnnotation(ctx) {
    const r = ctx.rolling;
    if (!r.n) return [];
    return ['跑赢 ', N(K.pct(r.winRate), 'context.rolling.winRate', r.winRate), ' · ', ...rollingStats(r)];
  }

  // Decade Sharpe leaders (full decades only): where the risk-adjusted lead changed hands.
  function decadeSharpe(ctx) {
    const rows = (ctx.decades ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.short && fin(r.ndx?.sharpe) && fin(r.spx?.sharpe));
    if (rows.length < 2) return null;
    const ndxLeads = ({ r }) => r.ndx.sharpe > r.spx.sharpe;
    const name = (ndxFirst) => (ndxFirst ? '纳指100' : '标普500');
    const flips = rows.filter((x, k) => k > 0 && ndxLeads(x) !== ndxLeads(rows[k - 1]));
    const last = rows[rows.length - 1];
    const lp = `context.decades.${last.i}`;
    const [hiSide, loSide] = ndxLeads(last) ? ['ndx', 'spx'] : ['spx', 'ndx'];
    const recent = ['（最近十年 ', N(K.sharpe(last.r[hiSide].sharpe), `${lp}.${hiSide}.sharpe`, last.r[hiSide].sharpe), ' 对 ',
      N(K.sharpe(last.r[loSide].sharpe), `${lp}.${loSide}.sharpe`, last.r[loSide].sharpe), '）'];
    if (!flips.length) return ['十年夏普：每个十年都是', name(ndxLeads(last)), '更高', ...recent];
    if (flips.length === 1) {
      const f = flips[0];
      return ['十年夏普：', N(f.r.from, `context.decades.${f.i}.from`), ' 前', name(!ndxLeads(f)), '更高，之后', name(ndxLeads(f)), '更高', ...recent];
    }
    return ['十年夏普：', `${rows.filter(ndxLeads).length}/${rows.length}`, ' 个十年纳指100更高', ...recent];
  }

  function card2(ctx) {
    const r = ctx.rolling;
    const lines = r.n ? [rollingStats(r)] : [];
    const second = [];
    if (r.n && !r.volMatched && fin(r.vmWinRate)) second.push('同波动调整后跑赢 ', N(K.pct(r.vmWinRate), 'context.rolling.vmWinRate', r.vmWinRate));
    const ds = decadeSharpe(ctx);
    if (ds) second.push(second.length ? ' · ' : '', ...ds);
    if (second.length) lines.push(second);
    return { eyebrow: '纳指100 优势能持续吗', big: rollingTitle(ctx).map((s) => (typeof s === 'string' ? s.replace('：纳指100 在 ', '：') : s)), lines, prov: [], target: 'compare' };
  }

  // Price identity at display precision: price and EPS at 2 dp, valuation = displayed price ÷ displayed EPS with enough
  // decimals that EPS × valuation rounds back to the displayed price.
  function priceFactors(f) {
    const pr = units(f.factors.price, 2) / 100, eps = units(f.factors.eps, 2) / 100;
    const peDp = Math.min(4, Math.max(2, Math.ceil(Math.log10(Math.max(eps, 1e-9) * 100) + 1e-9)));
    return { price: pr, eps, pe: eps > 0 ? units(pr / eps, peDp) / 10 ** peDp : null, peDp };
  }

  function card3(ctx) {
    const f = ctx.decomp.full;
    const p = 'context.decomp.full';
    const shown = priceFactors(f);
    const line1 = ['纳指/标普价格比 ', N(K.ratio(shown.price, 2), `${p}.factors.price`, f.factors.price), ' = 相对EPS × 相对市盈率'];
    if (f.sharesPrice) {
      line1.push('；EPS 占价格差 ', N(K.pct(f.sharesPrice.eps), `${p}.sharesPrice.eps`, f.sharesPrice.eps));
      const band = f.band?.epsSharePrice;
      if (band) line1.push('（', N(K.pct(band[0]), `${p}.band.epsSharePrice.0`, band[0]), '～', N(K.pct(band[1]), `${p}.band.epsSharePrice.1`, band[1]), '）');
    }
    return {
      eyebrow: ['超额从哪来（', N(f.start, `${p}.start`), '～', N(f.end, `${p}.end`), '，价格口径）'],
      big: ['EPS ', N(K.ratio(shown.eps, 2), `${p}.factors.eps`, f.factors.eps), ' · 估值 ',
        fin(shown.pe) ? N(K.ratio(shown.pe, shown.peDp), `${p}.factors.pe`, f.factors.pe) : N(K.ratio(f.factors.pe), `${p}.factors.pe`, f.factors.pe)],
      lines: [line1, ['股息差 ', N(K.lp(f.div_lp_yr), `${p}.div_lp_yr`, f.div_lp_yr), '个百分点/年 → 含息 ', N(K.ratio(f.factors.tr), `${p}.factors.tr`, f.factors.tr)]],
      prov: ['估算'],
      target: 'decomp',
    };
  }

  // Out-of-sample line; robust null = still computing (or failed when `failed`).
  function oosLine(robust, id, state, failed = false) {
    const wf = robust?.byRule?.[id]?.walkForward;
    if (!wf) return [failed ? '样本外计算失败' : '样本外计算中…'];
    if (wf.status !== 'ok') return ['样本外不足36个月'];
    const p = `robust.byRule.${id}.walkForward`;
    return [`样本外（每年1月用${walkWindow(wf, state)}重估，`, N(wf.firstOos, `${p}.firstOos`), '起）：年化 ',
      N(K.pct(wf.stats.rule.cagr), `${p}.stats.rule.cagr`, wf.stats.rule.cagr), ' 对 ', N(K.pct(wf.stats.spx.cagr), `${p}.stats.spx.cagr`, wf.stats.spx.cagr)];
  }

  function teChipFor(minTe) {
    const k = TE_CHIPS.find((c) => c >= minTe - 1e-9);
    return k == null ? { value: null, label: '不限' } : { value: k, label: K.pct(k, 0) };
  }

  function isoInfeasible(iso, state = {}) {
    const m = iso.params?.volMult ?? state.volMult ?? 1;
    const minTe = iso.feasibility?.minTeForVolCap;
    if (!fin(minTe)) return [`波动上限 ${K.num(m, 2)}× 时没有可行组合`];
    return ['波动上限 ', N(`${K.num(m, 2)}×`, 'alloc.rules.isoVolTe.params.volMult', m), ' 时跟踪误差上限至少 ', N(K.pct(minTe, 1), 'alloc.rules.isoVolTe.feasibility.minTeForVolCap', minTe)];
  }

  function flatTopLine(iso) {
    const ft = iso.flatTop;
    if (!ft || !(ft.kTo > ft.kFrom)) return null;
    const p = 'alloc.rules.isoVolTe.flatTop';
    const [lo, hi] = [[ft.ndxFrom, 'ndxFrom'], [ft.ndxTo, 'ndxTo']].sort((a, b) => a[0] - b[0]);
    const ndx = K.int(lo[0]) === K.int(hi[0]) ? [N(`${K.int(hi[0])}%`, `${p}.${hi[1]}`, hi[0])] : [N(K.int(lo[0]), `${p}.${lo[1]}`, lo[0]), '～', N(`${K.int(hi[0])}%`, `${p}.${hi[1]}`, hi[0])];
    const gap = Math.abs(ft.cagrGap);
    return ['跟踪误差 ', N(K.pct(ft.kFrom, 1), `${p}.kFrom`, ft.kFrom), '～', N(K.pct(ft.kTo, 1), `${p}.kTo`, ft.kTo), ' 之间：纳指 ', ...ndx,
      gap < 0.005 ? '，年化只差 ' : '，年化相差 ', N(K.fixed(gap * 100, 2), `${p}.cagrGap`, ft.cagrGap), '个百分点'];
  }

  // The unconstrained-TE end of the flat top is the tangency at the implied intercept c*.
  function tangentLine(iso) {
    const pure = iso.pure, ii = pure?.impliedIntercept;
    const cKey = fin(ii?.c) ? 'c' : fin(ii?.cLow) ? 'cLow' : null;
    if (!pure?.w || !cKey) return null;
    const kp = 'alloc.rules.isoVolTe.pure.impliedIntercept';
    // an interval bounded above (engine openAbove false) reads cLow～cHigh; only an open-above interval reads ≥cLow
    const c = ii.kind === 'interval' && ii.openAbove === false && fin(ii.cLow) && fin(ii.cHigh)
      ? [N(K.pct(ii.cLow), `${kp}.cLow`, ii.cLow), '～', N(K.pct(ii.cHigh), `${kp}.cHigh`, ii.cHigh)]
      : [N(`${ii.kind === 'interval' ? '≥' : ''}${K.pct(ii[cKey])}`, `${kp}.${cKey}`, ii[cKey])];
    if (same(iso.w, pure.w)) return ['当前组合即截距 ', ...c, ' 的切点'];
    return ['跟踪误差不限即截距 ', ...c, ' 的切点 ', N(K.weights(pure.w), 'alloc.rules.isoVolTe.pure.w')];
  }

  function card4(alloc, robust, state = {}, failed = false) {
    const iso = alloc.rules.isoVolTe;
    const p = 'alloc.rules.isoVolTe';
    const m = iso.params?.volMult ?? state.volMult ?? 1;
    const sigma = alloc.ctx.sigmaSpx;
    const cap = Math.abs(m - 1) < 1e-9 ? N(K.pct(sigma), 'alloc.ctx.sigmaSpx', sigma) : N(K.pct(sigma * m), `derived:alloc.ctx.sigmaSpx*${m}`, sigma * m);
    const eyebrow = ['同波动下怎么配（波动≤标普500', Math.abs(m - 1) < 1e-9 ? ' ' : ` ×${K.num(m, 2)} = `, cap, '）'];
    if (iso.status !== 'ok') return { eyebrow, big: ['—'], lines: [isoInfeasible(iso, state)], small: null, prov: ['模型'], target: 'allocation' };
    const d = iso.vsSpx;
    const ft = flatTopLine(iso), tl = tangentLine(iso);
    return {
      eyebrow,
      big: [N(K.weights(iso.w), `${p}.w`)],
      lines: [
        ['年化 ', N(K.pp(d.cagr), `${p}.vsSpx.cagr`, d.cagr), ' · 夏普 ', N(K.sharpe(d.sharpe, true), `${p}.vsSpx.sharpe`, d.sharpe), ' · 最大回撤 ', N(K.pp(d.mdd), `${p}.vsSpx.mdd`, d.mdd), '（对标普500）'],
        oosLine(robust, 'isoVolTe', state, failed),
      ],
      small: ft || tl ? [...(ft ?? []), ...(ft && tl ? ['；'] : []), ...(tl ?? [])] : null,
      prov: ['模型'],
      target: 'allocation',
    };
  }

  // ---------- §2 decomposition ----------
  // Log-point row at dp decimals with both identities intact on screen: price = 估值 + EPS and 总回报 = price + 股息.
  function decompUnits(r, dp = 2) {
    const ok = (...xs) => xs.every(fin);
    const out = {};
    if (!ok(r.price_lp_yr)) return out;
    const price = units(r.price_lp_yr, dp);
    out.price_lp_yr = price;
    if (ok(r.pe_lp_yr, r.eps_lp_yr)) [, out.pe_lp_yr, out.eps_lp_yr] = addUp([r.price_lp_yr, r.pe_lp_yr, r.eps_lp_yr], dp, [price]);
    if (ok(r.tr_lp_yr, r.div_lp_yr)) {
      const [tr, , div] = addUp([r.tr_lp_yr, r.price_lp_yr, r.div_lp_yr], dp, [undefined, price]);
      Object.assign(out, { tr_lp_yr: tr, div_lp_yr: div });
    }
    return out;
  }
  const lpText = (u, dp = 2) => K.lp(u / 10 ** dp, dp);

  function decompAnswer(ctx) {
    const { full: f, breakEven: be } = ctx.decomp;
    const p = 'context.decomp.full';
    const u = decompUnits(f, 2);
    const shown = (key) => (Number.isInteger(u[key]) ? lpText(u[key]) : K.lp(f[key], 2));
    const div = Number.isInteger(u.div_lp_yr) ? K.fixed(Math.abs(u.div_lp_yr) / 100, 2) : K.fixed(Math.abs(f.div_lp_yr), 2);
    const out = [[
      '价格差每年 ', N(shown('price_lp_yr'), `${p}.price_lp_yr`, f.price_lp_yr), '个百分点：EPS ', N(shown('eps_lp_yr'), `${p}.eps_lp_yr`, f.eps_lp_yr),
      '、估值 ', N(shown('pe_lp_yr'), `${p}.pe_lp_yr`, f.pe_lp_yr), `；股息再${f.div_lp_yr < 0 ? '减' : '加'} `, N(div, `${p}.div_lp_yr`, f.div_lp_yr), '。',
    ]];
    const mEnd = be?.M_end ?? f.M_end;
    const band = f.band;
    if (fin(mEnd) && band) {
      const s2 = [N(f.start, `${p}.start`), ' 纳指/标普市盈率比只要高于今天的 ', N(K.num(mEnd, 2), 'context.decomp.breakEven.M_end', mEnd), ' 倍，估值就是拖累；估算 ',
        N(K.num(band.m0Low, 1), `${p}.band.m0Low`, band.m0Low), '～', N(K.num(band.m0High, 1), `${p}.band.m0High`, band.m0High), ' 倍'];
      const s = band.epsSharePrice;
      if (s) s2.push(' → EPS 占价格差 ', N(K.pct(s[0]), `${p}.band.epsSharePrice.0`, s[0]), '～', N(K.pct(s[1]), `${p}.band.epsSharePrice.1`, s[1]));
      s2.push('。');
      out.push(s2);
    }
    return out;
  }

  const sliderReadout = (split) => [
    '估值 ', N(K.lp(split.pe_lp_yr, 2), 'decomp.split.pe_lp_yr', split.pe_lp_yr), ' · EPS ', N(K.lp(split.eps_lp_yr, 2), 'decomp.split.eps_lp_yr', split.eps_lp_yr),
    '（个百分点/年）', ...(fin(split.epsSharePrice) ? [' · EPS 占价格差 ', N(K.pct(split.epsSharePrice), 'decomp.split.epsSharePrice', split.epsSharePrice)] : []),
  ];

  // ---------- §3 allocation ----------
  const pathWeightsAt = (path, c) => {
    const pts = (path?.points ?? []).filter((q) => q.w);
    if (!pts.length || !fin(c)) return null;
    const i = pts.findIndex((q) => q.c >= c);
    if (i <= 0) return (i === 0 ? pts[0] : pts[pts.length - 1]).w;
    const [a, b] = [pts[i - 1], pts[i]];
    const t = (c - a.c) / (b.c - a.c || 1);
    return a.w.map((x, j) => x + t * (b.w[j] - x));
  };

  // What kinkedCal levers. Engine levered.cUsed / cUsedKind; bundles without them: inferred from mode and spread.
  // borrow = tangency at the borrowing rate (rf + spread) levered up; lend = tangency at rf plus cash; frontier = unlevered frontier point.
  const leverTarget = (t) => {
    const m = t?.levered?.volMult ?? t?.params?.volMult ?? 1;
    return Math.abs(m - 1) < 1e-9 ? '标普波动' : `标普波动×${K.num(m, 2)}`;
  };
  function leverBasis(t) {
    const lev = t?.levered;
    if (!lev?.w) return null;
    const kind = lev.cUsedKind ?? ({ lever: 'borrow', delever: 'lend' }[lev.mode] ?? 'frontier');
    const spread = fin(lev.spread) ? lev.spread : fin(t.params?.spread) ? t.params.spread : 0;
    const cUsed = fin(lev.cUsed) ? lev.cUsed : kind === 'borrow' ? t.cRf + spread : kind === 'lend' ? t.cRf : null;
    const atRf = kind === 'lend' || (kind === 'borrow' && fin(cUsed) && Math.abs(cUsed - t.cRf) < 1e-12);
    return { kind, cUsed, spread, w: lev.w, L: lev.L, atRf, target: leverTarget(t) };
  }

  // Asked-table label of the levered tangency row: 切点+现金 when kinkedCal de-levers, 前沿 when no leverage is used.
  function leveredLabel(t, fallback) {
    const lb = leverBasis(t);
    if (lb?.kind === 'lend') return `切点+现金到${lb.target}`;
    if (lb?.kind === 'frontier') return `前沿上波动=${lb.target}的组合（无需杠杆）`;
    return fallback;
  }

  // Tangency at c = RF: engine atRf; else the unlevered point when the active intercept is RF; else the levered
  // risky weights when they are the RF tangency (weights only). Never interpolated.
  function tangencyAtRf(alloc) {
    const t = alloc.rules.tangency;
    if (t.atRf?.w) return { w: t.atRf.w, stats: t.atRf.stats ?? null, key: 'atRf' };
    if (fin(t.c) && fin(t.cRf) && Math.abs(t.c - t.cRf) < 1e-12 && t.unlevered?.w) return { w: t.unlevered.w, stats: t.unlevered.stats ?? null, key: 'unlevered' };
    const lb = leverBasis(t);
    return lb?.atRf ? { w: lb.w, stats: null, key: 'levered' } : null;
  }

  // c* sentence: anchored to the vol target, split into rf + the cost of no leverage; c* < rf has no such cost.
  function impliedSentence(alloc) {
    const t = alloc.rules.tangency, imp = t.implied, p = 'alloc.rules.tangency';
    if (!imp?.w || !fin(imp.c)) return [];
    const m = t.params?.volMult ?? alloc.rules.isoVolTe?.params?.volMult ?? 1;
    const sigma = alloc.ctx?.sigmaSpx;
    const target = fin(sigma) ? volTarget(m, sigma) : [leverTarget(t)];
    const atLeast = !!imp.atLeast;
    const w = N(K.weights(imp.w), `${p}.implied.w`);
    const cSeg = N(`${atLeast ? '≥' : ''}${K.pct(imp.c)}`, `${p}.implied.c`, imp.c);
    if (!fin(t.cRf)) return ['不加杠杆、波动定在', ...target, ' 时截距 = ', cSeg, '，切点就是 ', w, '。'];
    const rf = N(K.pct(t.cRf), `${p}.cRf`, t.cRf);
    if (imp.c < t.cRf) {
      if (atLeast) return ['不加杠杆、波动定在', ...target, ' 时截距 ', cSeg, '，切点就是 ', w, '。'];
      return ['不加杠杆、波动定在', ...target, ' 的切点 ', w, ' 隐含截距 ', cSeg, '，低于无风险利率 ', rf, '：这段样本不加杠杆没有代价。'];
    }
    // rf and c* are shown elsewhere at 1 dp; the cost is their displayed difference so the sum reads true.
    const costU = units(imp.c * 100, 1) - units(t.cRf * 100, 1);
    const cost = N(`${atLeast ? '≥' : ''}${K.fixed(costU / 10, 1)}个百分点`, `derived:${p}.implied.c-${p}.cRf`, imp.c - t.cRf);
    return ['不加杠杆、波动定在', ...target, ' 时，截距 = 无风险利率 ', rf, ' + 不能加杠杆的代价 ', cost, ' = ', cSeg, '，切点就是 ', w, '。'];
  }

  // Default rule vs the c* tangency: same point, or the tangency plus the TE cap.
  function defaultVsTangent(alloc) {
    const t = alloc.rules.tangency, iso = alloc.rules.isoVolTe, imp = t.implied;
    if (iso?.status !== 'ok' || !iso.w || !iso.pure?.w || !imp?.w || !same(iso.pure.w, imp.w)) return [];
    if (same(iso.w, imp.w)) return ['默认组合（同波动·收益最高）就是这个切点。'];
    const k = iso.params?.teCap;
    const out = ['默认再加跟踪误差≤', k == null ? '不限' : N(K.pct(k, 0), 'alloc.rules.isoVolTe.params.teCap', k), ' → ', N(K.weights(iso.w), 'alloc.rules.isoVolTe.w')];
    const a = iso.stats?.cagr, b = imp.stats?.cagr;
    if (fin(a) && fin(b) && Math.abs(a - b) < 0.00005) out.push('，年化相差不到 0.01个百分点'); // below display precision
    else if (fin(a) && fin(b)) {
      out.push(`，年化${a < b ? '少' : '多'} `, N(K.fixed(Math.abs(a - b) * 100, 2), 'derived:alloc.rules.isoVolTe.stats.cagr-alloc.rules.tangency.implied.stats.cagr', a - b), '个百分点');
    }
    out.push('。');
    return out;
  }

  function capmCaption(alloc) {
    const t = alloc.rules.tangency;
    const lev = t.levered;
    const atRf = tangencyAtRf(alloc);
    const lb = leverBasis(t);
    const p = 'alloc.rules.tangency';
    const out = [lb?.kind === 'lend' ? 'CAPM 的切点默认可按无风险利率借贷：' : 'CAPM 的切点默认你会加杠杆：'];
    if (atRf) out.push('截距 ', N(K.pct(t.cRf), `${p}.cRf`, t.cRf), ' 时切点 ', N(K.weights(atRf.w), `${p}.${atRf.key}.w`), '；');
    if (lb && lev.stats) {
      const L = N(K.num(lb.L, 1), `${p}.levered.L`, lb.L);
      if (lb.kind === 'borrow' && !lb.atRf) {
        out.push('融资利率 ', N(K.pct(lb.cUsed), `${p}.levered.cUsed`, lb.cUsed), '（无风险利率 + 利差 ', N(K.pct(lb.spread, 1), `${p}.levered.spread`, lb.spread),
          '）下的切点是 ', N(K.weights(lb.w), `${p}.levered.w`), '，加 ', L, ` 倍杠杆到${lb.target}`);
      } else if (lb.kind === 'borrow') {
        out.push('加 ', L, ` 倍杠杆到${lb.target}`);
      } else if (lb.kind === 'lend') {
        out.push('切点波动高于目标：持有 ', N(K.pct(lb.L, 0), `${p}.levered.L`, lb.L), ` 切点 + 现金到${lb.target}`);
      } else {
        out.push(`${lb.target}落在两条资本线之间：不加杠杆，取前沿上同波动组合 `, N(K.weights(lb.w), `${p}.levered.w`));
      }
      out.push(' → 年化 ', N(K.pct(lev.stats.cagr), `${p}.levered.stats.cagr`, lev.stats.cagr), '、最大回撤 ', N(K.pct(lev.stats.mdd), `${p}.levered.stats.mdd`, lev.stats.mdd), '。');
    }
    out.push(...impliedSentence(alloc), ...defaultVsTangent(alloc));
    return out;
  }

  function interceptCaption(alloc) {
    const t = alloc.rules.tangency;
    const path = alloc.tangencyPath;
    const p = 'alloc.rules.tangency';
    const points = [];
    const at = (c, cKey, name, w, wKey, prefix = '') => {
      if (w && fin(c)) points.push({ c, segs: [N(`${prefix}${K.pct(c, 2)}`, cKey, c), `（${name}）→ 美债 `, N(`${K.roundWeights(w)[2]}%`, wKey, w[2])] });
    };
    const atRf = tangencyAtRf(alloc);
    // exact tangencies where the engine has them; otherwise the 截距→权重 chart's own path data (key @)
    at(t.cRf, `${p}.cRf`, '无风险', atRf?.w ?? pathWeightsAt(path, t.cRf), atRf ? `${p}.${atRf.key}.w.2` : 'alloc.tangencyPath@cRf');
    const y10 = t.atY10?.w ? { w: t.atY10.w, key: `${p}.atY10.w.2` } : { w: pathWeightsAt(path, t.cY10), key: 'alloc.tangencyPath@cY10' };
    at(t.cY10, `${p}.cY10`, '10年期', y10.w, y10.key);
    if (t.implied?.w) at(t.implied.c, `${p}.implied.c`, '隐含', t.implied.w, `${p}.implied.w.2`, t.implied.atLeast ? '≥' : '');
    if (t.params?.intercept === 'custom' && t.unlevered?.w) at(t.c, `${p}.c`, '自定义', t.unlevered.w, `${p}.unlevered.w.2`);
    points.sort((a, b) => a.c - b.c);
    const thresholds = [['cUstUnder50', '美债低于一半'], ['cZeroUst', '美债为0'], ['cAllNdx', '纳指100全仓']]
      .filter(([key]) => fin(path?.[key])).sort((a, b) => path[a[0]] - path[b[0]])
      .map(([key, label]) => ['≥', N(ceilPct(path[key]), `alloc.tangencyPath.${key}`, path[key]), ` ${label}`]);
    const parts = [...points.map((x) => x.segs), ...thresholds];
    return parts.length ? ['截距 ', ...parts.flatMap((x, i) => (i ? ['｜', x] : [x]))] : [];
  }

  function twoAssetStatus(ta, pair = [0, 2]) {
    const [i] = pair;
    const p = 'alloc.rules.twoAsset';
    const spxS = ta.spx?.sharpe ?? ta.spxSharpe;
    const spxKey = ta.spx?.sharpe != null ? `${p}.spx.sharpe` : `${p}.spxSharpe`;
    if (ta.status === 'none') {
      // No non-trivial root: every mix is either below 标普500 or (e.g. 纳指100+标普500 on 价格口径) above it.
      const xs = ta.curve?.x ?? [], ss = ta.curve?.sharpe ?? [], trivial = ta.roots?.trivial ?? [];
      let maxS = -Infinity, minS = Infinity, kMax = -1;
      for (let k = 0; k < ss.length; k++) {
        if (!fin(ss[k]) || trivial.some((x0) => Math.abs(x0 - xs[k]) < 1e-9)) continue;
        if (ss[k] > maxS) { maxS = ss[k]; kMax = k; }
        minS = Math.min(minS, ss[k]);
      }
      if (kMax < 0) return null;
      if (fin(spxS) && minS > spxS) {
        return ['任意配比夏普都高于标普500 ', N(K.sharpe(spxS), spxKey, spxS), '：最高 ', N(K.sharpe(maxS), `${p}.curve.sharpe.${kMax}`, maxS),
          `（${ASSET_LABEL[i]} `, N(K.pct(xs[kMax], 0), `${p}.curve.x.${kMax}`, xs[kMax]), '）'];
      }
      return ['夏普最高 ', N(K.sharpe(maxS), `${p}.curve.sharpe.${kMax}`, maxS), ' 仍低于标普500', ...(fin(spxS) ? [' ', N(K.sharpe(spxS), spxKey, spxS)] : []), '，配不出同夏普组合'];
    }
    const roots = ta.roots?.sharpeEqSpx ?? [];
    if (ta.status === 'all-above' && roots.length) {
      // engine: one root, and the mix between it and 100% beats 标普500; 100% is 标普500 itself when it is a trivial root
      const r = N(K.pct(roots[0], 1), `${p}.roots.sharpeEqSpx.0`, roots[0]);
      return (ta.roots?.trivial ?? []).includes(1)
        ? [`${ASSET_LABEL[i]}占比在 `, r, ' 与 100% 之间时夏普高于标普500']
        : [`${ASSET_LABEL[i]}占比 ≥ `, r, ' 时夏普高于标普500'];
    }
    if (!roots.length) return null;
    return [`夏普=标普500：${ASSET_LABEL[i]} `, ...roots.flatMap((x, j) => [j ? ' / ' : '', N(K.pct(x, 1), `${p}.roots.sharpeEqSpx.${j}`, x)])];
  }

  function maxSharpeNote(robust, state, failed = false) {
    const wf = robust?.byRule?.maxSharpeCagrFloor?.walkForward;
    if (!wf) return [failed ? '样本外计算失败' : '样本外计算中…'];
    if (wf.status !== 'ok') return ['样本外不足36个月'];
    const p = 'robust.byRule.maxSharpeCagrFloor.walkForward';
    const years = (wf.weights ?? []).length;
    const ustArr = Array.isArray(wf.ustOver50Years);
    const ust = ustArr ? wf.ustOver50Years.length : wf.ustOver50Years;
    return ['样本外 ', N(K.pct(wf.stats.rule.cagr), `${p}.stats.rule.cagr`, wf.stats.rule.cagr), ' 对标普500 ', N(K.pct(wf.stats.spx.cagr), `${p}.stats.spx.cagr`, wf.stats.spx.cagr),
      '；', fin(ust) ? N(String(ust), `${p}.ustOver50Years${ustArr ? '.length' : ''}`, ust) : '0', '/', N(String(years), `${p}.weights.length`, years), ' 年美债超过一半',
      (wf.window ?? state?.wfWindow) === 'expanding' ? '（全部历史重估）' : ''];
  }

  function delta(x, kind, k) {
    if (!fin(x)) return null;
    const zero = Math.abs(x) < (kind === 'sharpe' ? 0.5 * 10 ** -SHARPE_DP : 0.0005); // below display precision
    const arrow = zero ? '' : x > 0 ? '▲ ' : '▼ ';
    return { cls: zero ? '' : x > 0 ? 'delta-up' : 'delta-down', segs: [arrow, N(kind === 'sharpe' ? K.sharpe(x, true) : K.pp(x), k, x)] };
  }

  function muShiftLine(iso) {
    const ms = (iso.muShift ?? []).filter((m) => m.w);
    if (!ms.length) return null;
    return ms.flatMap((m, j) => [
      j ? '｜少 ' : '纳指预期收益少 ', `${K.fixed(Math.abs(m.dNdx) * 100, 0)}个百分点 → `, N(K.weights(m.w), `alloc.rules.isoVolTe.muShift.${j}.w`),
    ]);
  }

  function bindingChips(result) {
    const b = result?.binding ?? {};
    return [b.vol && '波动上限生效', b.te && '跟踪误差上限生效', b.cagrFloor && '收益下限生效'].filter(Boolean);
  }

  const y10Header = (sb, alloc) => {
    const y = alloc.ctx.muUsed?.[2];
    return ['历史回测 ', N(sb.sample.start, 'sample.sample.start'), '～', N(sb.sample.end, 'sample.sample.end'), '（权重按：美债预期收益 ', N(K.pct(y), 'alloc.ctx.muUsed.2', y), '）'];
  };

  // ---------- §4 robust ----------
  const robustHeading = (label) => `权重靠得住吗：重抽样与样本外（${label}）`;
  const robustNote = (active, pair = [0, 2]) => (active === 'twoAsset'
    ? `${(pair ?? [0, 2]).map((i) => ASSET_LABEL[i]).join('+')}是固定配比，下方样本外与重抽样为同波动·收益最高。`
    : active === 'custom' ? '自定义是固定权重：样本外按该权重持有，重抽样为同波动·收益最高。' : null);

  function bootstrapRows(bs, ruleId) {
    const p = `robust.byRule.${ruleId}.bootstrap`;
    if (!(bs.nFeasible > 0)) {
      const nf = fin(bs.nFeasible) ? bs.nFeasible : 0;
      return [['重抽样无可行解（可行 ', N(String(nf), `${p}.nFeasible`, nf), '/', N(String(bs.B), `${p}.B`, bs.B), '）']];
    }
    const w = bs.weights;
    const q = (name, i) => N(K.int(w[name][i]), `${p}.weights.${name}.${i}`, w[name][i]);
    return ASSET_SHORT.map((a, i) => [a, ' ', q('p10', i), '～', q('p90', i), '（中位 ', q('p50', i), '）']);
  }

  // Share of feasible draws at a single-asset corner (engine rule: max weight ≥ 0.99), per asset.
  function cornerByAsset(bs) {
    if (Array.isArray(bs.probCornerByAsset) && bs.probCornerByAsset.length === 3 && bs.probCornerByAsset.every(fin)) return { by: bs.probCornerByAsset, engine: true };
    const W = bs.draws;
    if (!W || !(W.length >= 3)) return null;
    const cnt = [0, 0, 0];
    let ok = 0;
    for (let b = 0; b + 2 < W.length; b += 3) {
      if (!fin(W[b])) continue;
      ok += 1;
      const j = [0, 1, 2].find((a) => W[b + a] >= 0.99);
      if (j != null) cnt[j] += 1;
    }
    return ok ? { by: cnt.map((c) => c / ok), engine: false } : null;
  }

  function probLine(bs, ruleId) {
    if (!(bs.nFeasible > 0)) return []; // bootstrapRows already states the feasible count
    const p = `robust.byRule.${ruleId}.bootstrap`;
    const out = ['美债>50%：', N(K.pct(bs.probUstOver50), `${p}.probUstOver50`, bs.probUstOver50), ' · 标普<1%：', N(K.pct(bs.probSpxUnder1), `${p}.probSpxUnder1`, bs.probSpxUnder1)];
    const total = N(K.pct(bs.probCorner), `${p}.probCorner`, bs.probCorner);
    const cs = fin(bs.probCorner) && bs.probCorner > 0 ? cornerByAsset(bs) : null;
    const hit = cs ? cs.by.map((x, i) => [x, i]).filter(([x]) => x > 0) : [];
    if (hit.length === 1) {
      out.push(` · 100% ${ASSET_LABEL[hit[0][1]]}：`, total);
    } else if (hit.length > 1) {
      out.push(' · 全仓单一资产：', total, '（', ...hit.flatMap(([x, i], j) => [j ? ' · ' : '', ASSET_LABEL[i], ...(cs.engine ? [' ', N(K.pct(x), `${p}.probCornerByAsset.${i}`, x)] : [])]), '）');
    } else {
      out.push(' · 全仓单一资产：', total);
    }
    if (fin(bs.nFeasible) && bs.nFeasible < bs.B) out.push('（可行 ', N(String(bs.nFeasible), `${p}.nFeasible`, bs.nFeasible), '/', N(String(bs.B), `${p}.B`, bs.B), '）');
    return out;
  }

  return {
    K, N, text, teLabel, teChipFor, pathWeightsAt, tangencyAtRf, leverBasis, leverTarget, leveredLabel,
    heroAnswer, heroMeta, divFlip, card1, card2, card3, card4, oosLine, isoInfeasible, flatTopLine, tangentLine, losingText,
    rollingTitle, rollingAnnotation, decadeSharpe, decompAnswer, decompUnits, priceFactors, sliderReadout, capmCaption, interceptCaption, twoAssetStatus,
    maxSharpeNote, delta, muShiftLine, bindingChips, y10Header, robustHeading, robustNote, bootstrapRows, probLine, cornerByAsset,
  };
}
