// Bring-your-own Bloomberg export, parsed only in the browser (nothing is uploaded): NDX/SPX relative P/E vs relative EPS.
// Identity (P/E > 0): ln(R_b/R_a) = ln(M_b/M_a) + ln(E_b/E_a) with R = NDX_px/SPX_px, M = NDX_pe/SPX_pe, E = R/M;
// total return adds D = Δln(NDX_tr/NDX_px) − Δln(SPX_tr/SPX_px). Hand-written CSV/TSV parsing (no d3 parsers).
import { identityRow, splitAtM0 } from './decomp.js?v=20260912';
import { DECADES } from './periods.js?v=20260912';
import { addMonths, monthDiff } from './series.js?v=20260912';

export const CANON = ['ndx_px', 'spx_px', 'ndx_pe', 'spx_pe', 'ndx_eps', 'spx_eps', 'ndx_tr', 'spx_tr', 'ndx_pe_fwd', 'spx_pe_fwd'];
export const USER_TIER = 'user_export';
const SEC_FIELD_MAP = {
  'NDX Index|PX_LAST': 'ndx_px', 'SPX Index|PX_LAST': 'spx_px',
  'NDX Index|PE_RATIO': 'ndx_pe', 'SPX Index|PE_RATIO': 'spx_pe',
  'NDX Index|T12_EPS_AGGTE': 'ndx_eps', 'SPX Index|T12_EPS_AGGTE': 'spx_eps',
  'XNDX Index|PX_LAST': 'ndx_tr', 'SPXT Index|PX_LAST': 'spx_tr',
  'NDX Index|TOT_RETURN_INDEX_GROSS_DVDS': 'ndx_tr', 'SPX Index|TOT_RETURN_INDEX_GROSS_DVDS': 'spx_tr',
  'NDX Index|BEST_PE_RATIO': 'ndx_pe_fwd', 'SPX Index|BEST_PE_RATIO': 'spx_pe_fwd',
};
const PAIR = ['ndx_px', 'spx_px', 'ndx_pe', 'spx_pe'];
const SHORT_YEARS = 3, TROUGH_PE = 60, STALE_MONTHS = 3, PRICE_MOVE_LN = 0.02, EPS_JUMP_LN = 0.25;
const RETURN_TOL = 0.005, LEVEL_DRIFT = 0.02, LEVEL_CONST = 0.005, CLOSURE_TOL = 0.01, MONTH_END_DAYS = 3;
const DATE_ORDER_LABEL = { iso: 'ISO 或 Excel 序列号', dm: '日/月/年', md: '月/日/年' };

const pos = v => v != null && v > 0;
const count = (s, ch) => s.split(ch).length - 1;

// ------------------------------------------------------------------------------------------------ parsing
function splitLine(line, sep) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (c === sep && !quoted) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Separator = the most frequent of comma, tab and semicolon outside quotes in the first line (ties keep the earlier one).
function detectSeparator(line) {
  let best = ',', most = 0;
  for (const sep of [',', '\t', ';']) { const k = splitLine(line, sep).length - 1; if (k > most) { best = sep; most = k; } }
  return best;
}

// Decimal mark voted over number-like cells. A cell whose only separator has exactly three digits after it ("1,234",
// "1.234") could be thousands or decimals and does not vote. Comma-separated files always use '.'; a tie on a
// semicolon file means the European convention (',' decimals).
const DOT_DECIMAL = /^[-+]?(\d{1,3}(,\d{3})+|\d*)\.(\d+)$/, COMMA_DECIMAL = /^[-+]?(\d{1,3}([.\s ']\d{3})+|\d*),(\d+)$/;
function decimalMark(grid, sep) {
  if (sep === ',') return '.';
  let dot = 0, comma = 0, m;
  for (const row of grid) for (const cell of row) {
    if ((m = DOT_DECIMAL.exec(cell))) { if (m[2] || m[3].length !== 3) dot++; }
    else if ((m = COMMA_DECIMAL.exec(cell)) && (m[2] || m[3].length !== 3)) comma++;
  }
  return comma > dot ? ',' : dot > comma ? '.' : sep === ';' ? ',' : '.';
}

function parseNumber(s, decimal = '.') {
  let t = String(s ?? '').trim();
  if (!t || /^#N\/A|^N\/A$|^--$/i.test(t)) return null;
  t = t.replace(/[\s ']/g, '');
  t = decimal === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, SLASH = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/;
const DATE_LABEL = /^(dates?|日期)$/i;
const pad = s => String(s).padStart(2, '0');
const fullYear = y => (y.length === 2 ? String((+y < 50 ? 2000 : 1900) + +y) : y); // two-digit years: 85 → 1985, 26 → 2026

function parseDate(cell, order) {
  if (!cell) return null;
  let y, mo, d, m;
  if ((m = ISO.exec(cell))) [, y, mo, d] = m;
  else if (/^\d{5}$/.test(cell)) return new Date(Date.UTC(1899, 11, 30) + Number(cell) * 864e5).toISOString().slice(0, 10);
  else if ((m = SLASH.exec(cell))) [y, mo, d] = order === 'dm' ? [fullYear(m[3]), m[2], m[1]] : [fullYear(m[3]), m[1], m[2]];
  else return null;
  return +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** Date column: slash dates resolved by majority day > 12 votes; a tie prefers the reading whose days look like month-ends. */
function parseDateColumn(cells) {
  let slash = 0, dm = 0, md = 0;
  for (const c of cells) {
    const m = SLASH.exec(c || '');
    if (m) { slash++; if (+m[1] > 12) dm++; if (+m[2] > 12) md++; }
  }
  const read = order => cells.map(c => parseDate(c, order));
  if (!slash) return { dates: read('md'), order: 'iso', ambiguous: false };
  if (dm !== md) { const order = dm > md ? 'dm' : 'md'; return { dates: read(order), order, ambiguous: false }; }
  const monthEnds = order => read(order).filter(d => d && +d.slice(8) >= 25).length;
  const order = monthEnds('dm') > monthEnds('md') ? 'dm' : 'md';
  return { dates: read(order), order, ambiguous: true };
}

/** Template A (wide CSV, first header 'date') or Template B (Bloomberg block paste: row 1 securities, row 2 fields).
 *  Comma, tab or semicolon separated; decimal comma is detected on tab/semicolon files. `format` feeds validate()'s diagnosis. */
export function parseExport(text) {
  const meta = {}, lines = [];
  for (const raw of String(text).replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    if (/^\s*#/.test(raw)) {
      const m = /^\s*#\s*([\w.-]+)\s*:\s*(.*)$/.exec(raw);
      if (m) meta[m[1]] = m[2];
    } else if (raw.trim()) lines.push(raw);
  }
  if (!lines.length) throw Object.assign(new Error('输入为空'), { code: 'E_EMPTY_INPUT' });
  const sep = detectSeparator(lines[0]);
  const grid = lines.map(l => splitLine(l, sep));
  const decimal = decimalMark(grid.slice(1), sep), num = cell => parseNumber(cell, decimal);
  const format = { sep, decimal, dataLines: 0, datedLines: 0, recognisedColumns: 0 };
  const notes = [], byMonth = new Map();
  if (sep === ';') notes.push('分隔符：分号');
  if (decimal === ',') notes.push('数字格式：逗号为小数点');
  const noteOrder = p => notes.push(`日期格式：${DATE_ORDER_LABEL[p.order]}${p.ambiguous ? '（无法从数值判断，按月末日期推断）' : ''}`);
  const put = (date, key, value) => {
    if (!date || value == null) return;
    const month = date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, { month, date, seen: {} });
    const row = byMonth.get(month);
    if (row.seen[key] && date < row.seen[key]) return; // keep the last observation inside a month
    row.seen[key] = date;
    row[key] = value;
    if (date > row.date) row.date = date;
  };

  const header = grid[0].map(s => s.toLowerCase());
  if (DATE_LABEL.test(header[0])) {
    const parsed = parseDateColumn(grid.slice(1).map(r => r[0]));
    noteOrder(parsed);
    Object.assign(format, { dataLines: grid.length - 1, datedLines: parsed.dates.filter(Boolean).length,
      recognisedColumns: header.filter((name, j) => j && CANON.includes(name)).length });
    header.forEach((name, j) => { if (j && !CANON.includes(name)) notes.push(`忽略列：${name}`); });
    grid.slice(1).forEach((r, i) => header.forEach((name, j) => { if (j && CANON.includes(name)) put(parsed.dates[i], name, num(r[j])); }));
  } else {
    const securities = grid[0], fields = grid[1] || [], body = grid.slice(2);
    format.dataLines = body.length;
    let security = null, dateCol = null;
    for (let j = 0; j < Math.max(securities.length, fields.length); j++) {
      if (securities[j]) security = securities[j];
      const cells = body.map(r => r[j]);
      // a BDH date column has no field mnemonic above it, or only a Date label (a mnemonic above a column also stops
      // 5-digit index levels being read as Excel serials)
      const parsed = fields[j] && !DATE_LABEL.test(fields[j]) ? null : parseDateColumn(cells);
      if (parsed && cells.some(Boolean) && parsed.dates.filter(Boolean).length >= 0.8 * cells.filter(Boolean).length) {
        dateCol = parsed;
        format.datedLines = Math.max(format.datedLines, parsed.dates.filter(Boolean).length);
        noteOrder(parsed);
        continue;
      }
      if (!dateCol || !fields[j]) continue;
      const key = SEC_FIELD_MAP[`${security}|${fields[j].toUpperCase()}`];
      if (!key) { notes.push(`未识别的数据块：${security}｜${fields[j]}`); continue; }
      format.recognisedColumns++;
      body.forEach((r, i) => put(dateCol.dates[i], key, num(r[j])));
    }
  }
  const months = [...byMonth.keys()].sort();
  return { meta, notes: [...new Set(notes)], months, rows: months.map(m => { const { seen, ...row } = byMonth.get(m); return row; }), format };
}

// ------------------------------------------------------------------------------------------------ validation
/** reference: site history doc (or its observations) for the price cross-check. */
export function validate(parsed, reference = null) {
  const errors = [], warnings = [], info = [];
  const R = parsed.rows, fmt = parsed.format;
  // Data lines that yielded no month: name the likely cause rather than listing every column as missing.
  if (!R.length && fmt?.dataLines) {
    const cause = !fmt.datedLines ? '无法识别日期列或分隔符：支持逗号、制表符、分号分隔；日期如 2024-12-31、31/12/2024、12/31/24 或 Excel 序列号'
      : !fmt.recognisedColumns ? '未识别任何数据列：模板 A 首行应为 date,ndx_px,spx_px,ndx_pe,spx_pe；模板 B 第 1 行为证券名、第 2 行为字段代码' : null;
    if (cause) return { status: 'NO_PE', firstPeMonth: null, errors: [cause], warnings, info, coverage: {} };
  }
  const has = k => R.some(r => r[k] != null);
  for (const k of ['ndx_px', 'spx_px']) if (!has(k)) errors.push(`缺少必需列 ${k}`);
  if (!has('ndx_pe') || !has('spx_pe')) errors.push('缺少 ndx_pe 或 spx_pe：无法拆分估值与 EPS（价格与总回报仍可计算）');

  const coverage = {};
  for (const k of CANON) {
    const hit = R.filter(r => r[k] != null);
    if (hit.length) coverage[k] = { first: hit[0].month, last: hit.at(-1).month, n: hit.length };
  }
  const early = R.filter(r => {
    const d = new Date(`${r.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + MONTH_END_DAYS + 1);
    return d.getUTCMonth() === Number(r.date.slice(5, 7)) - 1;
  });
  if (early.length) warnings.push(`${early.length} 行日期距月末超过 ${MONTH_END_DAYS} 天（首个 ${early[0].date}）：请用 period=cm 或每月最后一个交易日`);
  for (const r of R) {
    for (const k of ['ndx_pe', 'spx_pe']) if (r[k] != null && r[k] <= 0) warnings.push(`${r.month} ${k} ≤ 0：按缺失处理（亏损或无意义）`);
    for (const k of ['ndx_px', 'spx_px']) if (r[k] != null && r[k] <= 0) errors.push(`${r.month} ${k} ≤ 0`);
  }

  for (const [pe, px] of [['ndx_pe', 'ndx_px'], ['spx_pe', 'spx_px']]) {
    let run = 0;
    for (let i = 1; i < R.length; i++) {
      const a = R[i - 1], b = R[i];
      const priceMoved = pos(a[px]) && pos(b[px]) && Math.abs(Math.log(b[px] / a[px])) > PRICE_MOVE_LN;
      run = pos(a[pe]) && a[pe] === b[pe] && priceMoved ? run + 1 : 0;
      if (run === STALE_MONTHS) warnings.push(`${pe} 截至 ${b.month} 连续 ${STALE_MONTHS} 个月不变而价格在动：疑似向前填充，请去掉填充选项`);
      if ([a[pe], b[pe], a[px], b[px]].every(pos)) {
        const jump = Math.log((b[px] / b[pe]) / (a[px] / a[pe]));
        if (Math.abs(jump) > EPS_JUMP_LN) warnings.push(`${pe}：${b.month} 隐含 EPS 变动 ${(100 * jump).toFixed(0)} 个对数点（口径变化、剔除亏损或重述？）`);
      }
    }
  }
  for (const [pe, px, eps] of [['ndx_pe', 'ndx_px', 'ndx_eps'], ['spx_pe', 'spx_px', 'spx_eps']]) {
    const gaps = R.filter(r => pos(r[pe]) && pos(r[px]) && r[eps] != null).map(r => Math.abs(r[px] / (r[pe] * r[eps]) - 1)).sort((x, y) => x - y);
    if (!gaps.length) continue;
    const med = gaps[Math.floor(gaps.length / 2)];
    info.push(`${pe} 闭合检验 |价格 ÷ (市盈率 × EPS) − 1| 中位数 ${(100 * med).toFixed(2)}%：`
      + (med > CLOSURE_TOL ? '不是总市值 ÷ 总盈利口径（可能剔除亏损或 EPS 口径不同），拆分使用市盈率隐含 EPS' : '口径一致'));
  }

  const refRows = Array.isArray(reference) ? reference : reference?.observations;
  if (refRows) {
    const ref = new Map(refRows.map(o => [o.month, o]));
    for (const [k, rk] of [['ndx_px', 'NDX'], ['spx_px', 'SPX']]) {
      const bad = [], ratios = [];
      for (let i = 1; i < R.length; i++) {
        const a = R[i - 1], b = R[i], ra = ref.get(a.month), rb = ref.get(b.month);
        if (![a[k], b[k], ra?.[rk], rb?.[rk]].every(pos) || monthDiff(a.month, b.month) !== 1) continue;
        const d = Math.log(b[k] / a[k]) - Math.log(rb[rk] / ra[rk]);
        if (Math.abs(d) > RETURN_TOL) bad.push(`${b.month}（${(100 * d).toFixed(2)}个百分点）`);
        ratios.push(b[k] / rb[rk]);
      }
      if (bad.length > 3) errors.push(`${k}：${bad.length} 个月的月收益与本站相差超过 ${100 * RETURN_TOL} 个百分点（代码、币种或不是月末？），例如 ${bad.slice(0, 3).join('、')}`);
      else if (bad.length) warnings.push(`${k}：与本站月收益不一致 ${bad.join('、')}`);
      if (ratios.length) {
        const lo = Math.min(...ratios), hi = Math.max(...ratios);
        if (Math.abs(hi / lo - 1) > LEVEL_DRIFT) warnings.push(`${k}：与本站指数水平之比在 ${lo.toFixed(3)}～${hi.toFixed(3)} 间漂移（重新定基或拼接？）`);
        else if (Math.abs(lo - 1) > LEVEL_CONST) info.push(`${k}：与本站指数水平之比恒为 ${lo.toFixed(4)}（基期不同，不影响结果）`);
      }
    }
  }
  const pe = R.filter(r => pos(r.ndx_pe) && pos(r.spx_pe));
  const firstPeMonth = pe[0]?.month ?? null;
  const status = !pe.length ? 'NO_PE' : firstPeMonth <= addMonths(DECADES[0], 1) ? 'FULL_FROM_1985' : `PARTIAL_FROM_${firstPeMonth}`;
  return { status, firstPeMonth, errors, warnings, info, coverage };
}

// ------------------------------------------------------------------------------------------------ decomposition
/** One window a → b (month strings). tolMonths lets an endpoint move to the nearest month with prices and both P/Es. */
export function decompose(parsed, a, b, { tolMonths = 0 } = {}) {
  const idx = new Map(parsed.rows.map(r => [r.month, r]));
  const usable = r => r && PAIR.every(k => pos(r[k]));
  const pick = m => {
    for (let k = 0; k <= tolMonths; k++) for (const s of k ? [-k, k] : [0]) { const r = idx.get(addMonths(m, s)); if (usable(r)) return r; }
    return null;
  };
  const A = pick(a), B = pick(b);
  if (!A || !B || A.month >= B.month) {
    return { start: a, end: b, computable: false, reason: !A || !B ? `${!A ? a : b} 缺少价格或市盈率` : '区间无效', flags: [] };
  }
  const years = monthDiff(A.month, B.month) / 12;
  const lnR = Math.log((B.ndx_px / B.spx_px) / (A.ndx_px / A.spx_px));
  const lnM = Math.log((B.ndx_pe / B.spx_pe) / (A.ndx_pe / A.spx_pe));
  const hasTr = [A.ndx_tr, A.spx_tr, B.ndx_tr, B.spx_tr].every(pos);
  const lnD = hasTr ? Math.log((B.ndx_tr / B.ndx_px) / (A.ndx_tr / A.ndx_px)) - Math.log((B.spx_tr / B.spx_px) / (A.spx_tr / A.spx_px)) : null;
  const row = identityRow({ years, lnR, lnM, lnD });
  const flags = [];
  if (!hasTr) flags.push('两端缺少总回报指数：未计算股息项');
  if (!row.sharesPrice) flags.push('总变动太小：占比无意义，请看对数点');
  if (Math.sign(lnM) !== Math.sign(lnR - lnM)) flags.push('估值项与 EPS 项符号相反：占比可能小于 0 或超过 100%');
  if (years < SHORT_YEARS) flags.push(`区间短于 ${SHORT_YEARS} 年：TTM EPS 滞后 1～2 个季度，拆分不可靠`);
  for (const [side, r] of [['起点', A], ['终点', B]]) {
    for (const k of ['ndx_pe', 'spx_pe']) if (r[k] > TROUGH_PE) flags.push(`${side} ${k} = ${r[k].toFixed(1)}：盈利低谷端点，拆分由分母主导`);
  }
  if (A.month !== a || B.month !== b) flags.push(`端点已移到最近可用月份（${A.month}～${B.month}）`);
  return { start: A.month, end: B.month, computable: true, M_start: A.ndx_pe / A.spx_pe, M_end: B.ndx_pe / B.spx_pe,
    price_lp: 100 * lnR, pe_lp: 100 * lnM, eps_lp: 100 * (lnR - lnM), div_lp: hasTr ? 100 * lnD : null, tr_lp: hasTr ? 100 * (lnR + lnD) : null,
    ...row, flags };
}

/** Contiguous windows; totals add log points and include the dividend term only when every window has it. */
export function chain(parsed, endpoints, opts) {
  const segments = endpoints.slice(1).map((e, i) => decompose(parsed, endpoints[i], e, opts));
  const flags = [];
  if (!segments.length || !segments.every(s => s.computable)) {
    flags.push('部分区间无法计算：不给合计');
    return { segments, total: null, flags };
  }
  if (segments.some((s, i) => i && s.start !== segments[i - 1].end)) flags.push('区间端点不连续：合计含缺口');
  const withDiv = segments.every(s => s.div_lp != null);
  if (!withDiv) flags.push('股息项不完整');
  const sum = k => segments.reduce((t, s) => t + s[k], 0);
  const years = segments.reduce((t, s) => t + s.years, 0);
  const lnR = sum('price_lp') / 100, lnM = sum('pe_lp') / 100, lnD = withDiv ? sum('div_lp') / 100 : null;
  const total = { start: segments[0].start, end: segments.at(-1).end, M_start: segments[0].M_start, M_end: segments.at(-1).M_end,
    price_lp: 100 * lnR, pe_lp: 100 * lnM, eps_lp: 100 * (lnR - lnM), div_lp: withDiv ? 100 * lnD : null, tr_lp: withDiv ? 100 * (lnR + lnD) : null,
    ...identityRow({ years, lnR, lnM, lnD }) };
  return { segments, total, flags };
}

/** A computable window in the anchorDecomposition row shape. */
export function toDecompRow(seg, { id = `${seg.start}_${seg.end}`, label = `${seg.start}～${seg.end}`, tier = USER_TIER } = {}) {
  if (!seg?.computable) return null;
  const { start, end, years, M_start, M_end, price_lp_yr, pe_lp_yr, eps_lp_yr, div_lp_yr, tr_lp_yr, factors, sharesPrice, sharesTr } = seg;
  return { id, label, start, end, years, M_start, M_end, startTier: tier, endTier: tier, splice: false,
    price_lp_yr, pe_lp_yr, eps_lp_yr, div_lp_yr, tr_lp_yr, factors, sharesPrice, sharesTr };
}

/** Decade table from an export: DECADES boundaries inside the months where both P/Es exist (±2 months tolerance).
 *  A boundary within tolMonths of either end is absorbed into its neighbour row, so no row spans only 1–2 months. */
export function decadeRows(parsed, { tolMonths = 2 } = {}) {
  const pe = parsed.rows.filter(r => PAIR.every(k => pos(r[k])));
  if (pe.length < 2) return { rows: [], total: null, flags: ['市盈率数据不足两个月'], coverage: null };
  const first = pe[0].month, last = pe.at(-1).month;
  const inner = DECADES.slice(0, -1).filter(m => monthDiff(first, m) > tolMonths && monthDiff(m, last) > tolMonths);
  const ends = [first, ...inner, last];
  const { segments, total, flags } = chain(parsed, ends, { tolMonths });
  return { rows: segments.map(s => toDecompRow(s, { id: `u${s.start}`, label: `${s.start}～${s.end}` })), total, flags, coverage: { from: first, to: last } };
}

/** Unknown start relative P/E: break-even M0 values and the split for each M0 in grid. */
export function sensitivity(R0, RT, M_end, years, grid = [0.6, 0.8, 1.0, 1.2, 1.5, 1.9, 2.5, 3.0]) {
  const lnR = Math.log(RT / R0);
  const be = { R0, RT, lnR, years, M_end, m0ForPeShare: { p0: M_end, p25: M_end * Math.exp(-0.25 * lnR), p50: M_end * Math.exp(-0.5 * lnR) } };
  return { ...be, rows: grid.map(M0 => ({ M0, ...splitAtM0(be, M0) })) };
}

// ------------------------------------------------------------------------------------------------ user-facing recipe
const END_TOKEN = '{END}';

export const RECIPE_TEXT = `彭博导出步骤：纳指100/标普500 市盈率 vs EPS 拆分（文件只在你的浏览器本地读取，不上传）

语法核实：BDH(证券, 字段, 开始日期, 结束日期, [选项]) 与 period=cm（月末）已由公开指南核实
（bettersolutions.com 示例 =BDH("IBM equity","last_price","10/01/07","10/31/07","Currency=GBP, period=cm")）。
字段 PE_RATIO、T12_EPS_AGGTE、BEST_PE_RATIO、TOT_RETURN_INDEX_GROSS_DVDS、INDX_MWEIGHT_HIST 为候选字段，使用前在 FLDS <GO> 逐一确认。
SPX 的 T12_EPS_AGGTE 可回溯至 1954（philosophicaleconomics.com，2013）；INDX_MWEIGHT_HIST + END_DATE_OVERRIDE 用法见 blp Python 文档（matthewgilbert.github.io/blp）。

第 0 步 · 先查覆盖区间（约 2 分钟，决定全样本还是部分样本）
  终端：NDX Index GP → 字段改为 PE_RATIO（市盈率）→ 区间 Max，记下最早日期；SPX Index 同样操作。
  终端：FLDS <GO> → 搜索 PE_RATIO → 打开定义 → 复制说明（负盈利处理、TTM 口径）。
  Excel 按年快速探查：=BDH("NDX Index","PE_RATIO","19850101","20051231","period=cy")
  最早有值年份晚于 1985 时，网站按部分样本计算并给出 1985 敏感性区间；照样可以导出。

第 1 步 · 模板 B（分块布局，推荐；复制整个已用区域粘贴到网站）
  第 1 行 = 证券名，第 2 行 = 数值列上方的字段代码，第 3 行 = 日期列里的公式。
  块与块之间留一个空列。数值不要改格式；日期可保留 Excel 区域格式（能识别 日/月/年）。

  A1: NDX Index    B2: PX_LAST         A3: =BDH("NDX Index","PX_LAST","19850101","${END_TOKEN}","period=cm")
  D1: NDX Index    E2: PE_RATIO        D3: =BDH("NDX Index","PE_RATIO","19850101","${END_TOKEN}","period=cm")
  G1: SPX Index    H2: PX_LAST         G3: =BDH("SPX Index","PX_LAST","19850101","${END_TOKEN}","period=cm")
  J1: SPX Index    K2: PE_RATIO        J3: =BDH("SPX Index","PE_RATIO","19850101","${END_TOKEN}","period=cm")
  可选（总回报 → 股息项）：
  M1: XNDX Index   N2: PX_LAST         M3: =BDH("XNDX Index","PX_LAST","19850101","${END_TOKEN}","period=cm")
  P1: SPXT Index   Q2: PX_LAST         P3: =BDH("SPXT Index","PX_LAST","19850101","${END_TOKEN}","period=cm")
  可选（闭合检验：市盈率是否等于 价格 ÷ 总 EPS，还是剔除了亏损）：
  S1: NDX Index    T2: T12_EPS_AGGTE   S3: =BDH("NDX Index","T12_EPS_AGGTE","19850101","${END_TOKEN}","period=cm")
  V1: SPX Index    W2: T12_EPS_AGGTE   V3: =BDH("SPX Index","T12_EPS_AGGTE","19850101","${END_TOKEN}","period=cm")
  可选（预期市盈率单独成组，不与 TTM 混用）：
  Y1: NDX Index    Z2: BEST_PE_RATIO   Y3: =BDH("NDX Index","BEST_PE_RATIO","19850101","${END_TOKEN}","period=cm")
  AB1: SPX Index   AC2: BEST_PE_RATIO  AB3: =BDH("SPX Index","BEST_PE_RATIO","19850101","${END_TOKEN}","period=cm")

  不要加向前填充数值的选项；若默认模板会填充，网站会提示“连续 3 个月不变而价格在动”。
  早期日期返回 #N/A 时保留即可（按缺失处理，不当作 0）。

第 2 步 · 可选模板 A（宽表 CSV）：见导出模板，日期列用 =TEXT(date,"yyyy-mm-dd")。

第 3 步 · NDX 的 PE_RATIO 晚于 1985 才有数据时（按成本从低到高）
  (a) 接受部分样本：网站从首个共同月份起精确拆分，并给出 1985 敏感性区间。
  (b) Datastream / LSEG Workspace 的纳指100 指数市盈率（BetaShares 2016 图表注明 1985–2016 数据来自 Bloomberg、Thomson Reuters）：
      导出月度市盈率作为 ndx_pe，并加一行 "# pe_field: DATASTREAM PE"（网站视为独立来源，分段链接并报告重叠期拼接差）。
  (c) 成分股重建（数周）：每个年末 =BDS("NDX Index","INDX_MWEIGHT_HIST","END_DATE_OVERRIDE","19851231")，
      先测成分历史能回溯多远，再取公司 TTM EPS 与股本；只有需要 1985–2002 子区间归因时才值得做。
`;

/** RECIPE_TEXT with the BDH end date set to the last calendar day of `endMonth` ('YYYY-MM'). */
export function recipeText(endMonth) {
  const [y, m] = endMonth.split('-').map(Number);
  const end = `${y}${pad(m)}${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  return RECIPE_TEXT.replaceAll(END_TOKEN, end);
}

export const EXPORT_TEMPLATE_CSV = [
  '# 模板 A（宽表）：UTF-8、逗号分隔，每个月末一行，日期 yyyy-mm-dd；空单元格或 #N/A 视为缺失。',
  '# 必填列 date, ndx_px, spx_px, ndx_pe, spx_pe；可选列 ndx_eps, spx_eps, ndx_tr, spx_tr, ndx_pe_fwd, spx_pe_fwd。',
  '# 下列说明行可选，会被读取；FLDS 定义文字可原样贴在 flds_pe_definition 之后。',
  '# pe_field: PE_RATIO',
  '# eps_field: T12_EPS_AGGTE',
  '# tr_source: XNDX Index / SPXT Index PX_LAST',
  '# periodicity: period=cm',
  '# exported: YYYY-MM-DD',
  '# flds_pe_definition:',
  'date,ndx_px,spx_px,ndx_pe,spx_pe,ndx_eps,spx_eps,ndx_tr,spx_tr,ndx_pe_fwd,spx_pe_fwd',
  '',
].join('\n');
