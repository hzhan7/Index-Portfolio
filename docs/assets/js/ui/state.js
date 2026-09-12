// Page state ⇄ URL query (§2.1 table), validation and sample presets. Pure: no DOM, Node-testable.
import { DEFAULT_STATE, RULE_IDS } from '../engine/params.js?v=20260912';

export const FIRST_MONTH = '1985-01';
export const MIN_MONTHS = 24;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const INVALID = Symbol('invalid');

export const isMonth = (s) => typeof s === 'string' && MONTH_RE.test(s);
export const monthIndex = (m) => (isMonth(m) ? Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 : NaN);
export const monthFromIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, k) => monthFromIndex(monthIndex(m) + k);
export const monthsBetween = (a, b) => monthIndex(b) - monthIndex(a);

const near = (a, b) => Math.abs(a - b) < 1e-9;
const toNumber = (s) => (NUMBER_RE.test(s) ? Number(s) : NaN);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Integer percents summing to 100 (largest remainder); inputs pre-rounded to kill 0.29*100 noise.
function wholePercents(w) {
  const raw = w.map((x) => Math.round(x * 1e8) / 1e6);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k += 1, rest -= 1) out[order[k][1]] += 1;
  return out;
}

const choice = (values) => ({
  decode: (s) => (values.includes(s) ? s : INVALID),
  valid: (v) => values.includes(v),
  encode: String,
});

// Numeric choice stored as a decimal whose URL form is value × scale (0.15 ↔ "15").
const scaled = (urlValues, scale) => {
  const find = (x) => urlValues.find((u) => near(u, x));
  return {
    decode: (s) => {
      const u = find(toNumber(s));
      return u === undefined ? INVALID : u / scale;
    },
    valid: (v) => isNum(v) && find(v * scale) !== undefined,
    canon: (v) => find(v * scale) / scale,
    encode: (v) => String(find(v * scale)),
  };
};

// Number on a grid of 1/perUnit inside [lo, hi]; strict rejects off-grid values instead of rounding.
const grid = (lo, hi, perUnit, { nullable = false, strict = false } = {}) => ({
  decode: toNumber,
  valid: (v) => (nullable && v === null)
    || (isNum(v) && v >= lo - 1e-9 && v <= hi + 1e-9 && (!strict || Math.abs(Math.round(v * perUnit) - v * perUnit) < 1e-6)),
  canon: (v) => (v === null ? null : Math.round(v * perUnit) / perUnit),
  encode: (v) => (v === null ? null : String(Math.round(v * perUnit) / perUnit)),
});

const TE_CAPS = [2, 3, 4, 5, 6, 8];
const PAIRS = ['0-2', '1-2', '0-1'];

const FIELDS = [
  ['start', 's', {
    decode: (s) => s,
    valid: (v, { latest }) => isMonth(v) && v >= FIRST_MONTH && v <= latest,
    encode: (v) => v,
  }],
  ['end', 'e', {
    decode: (s) => s,
    valid: (v, { latest }) => v === null || (isMonth(v) && v > FIRST_MONTH && v <= latest),
    encode: (v) => v,
  }],
  ['basis', 'b', choice(['tr', 'pr'])],
  ['ndxDiv', 'd', choice(['default', 'low', 'high'])],
  ['wht', 't', scaled([0, 15, 30], 100)],
  ['rule', 'r', choice(RULE_IDS)],
  ['volMult', 'vm', grid(0.7, 1.2, 20, { strict: true })],
  ['teCap', 'te', {
    decode: (s) => (s === 'none' ? null : toNumber(s) / 100),
    valid: (v) => v === null || (isNum(v) && TE_CAPS.some((p) => near(p, v * 100))),
    canon: (v) => (v === null ? null : Math.round(v * 100) / 100),
    encode: (v) => (v === null ? 'none' : String(Math.round(v * 100))),
  }],
  ['intercept', 'ic', choice(['implied', 'rf', 'y10', 'custom'])],
  ['interceptC', 'cc', {
    decode: (s) => toNumber(s) / 100,
    valid: (v) => v === null || (isNum(v) && v >= 0 && v <= 0.2),
    canon: (v) => (v === null ? null : Math.round(v * 1e4) / 1e4),
    encode: (v) => (v === null ? null : String(Math.round(v * 1e4) / 100)),
  }],
  ['spread', 'sp', scaled([0, 0.5, 1], 100)],
  ['pair', 'pr', {
    decode: (s) => (PAIRS.includes(s) ? s.split('-').map(Number) : INVALID),
    valid: (v) => Array.isArray(v) && PAIRS.includes(v.join('-')),
    canon: (v) => v.map(Number),
    encode: (v) => v.join('-'),
  }],
  ['customW', 'w', {
    decode: (s) => {
      if (!/^\d{1,3},\d{1,3},\d{1,3}$/.test(s)) return INVALID;
      const p = s.split(',').map(Number);
      return p[0] + p[1] + p[2] === 100 ? p.map((x) => x / 100) : INVALID;
    },
    valid: (v) => v === null || (Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && x >= 0)
      && Math.abs(v[0] + v[1] + v[2] - 1) < 1e-6),
    canon: (v) => (v === null ? null : wholePercents(v).map((p) => p / 100)),
    encode: (v) => (v === null ? null : wholePercents(v).join(',')),
  }],
  ['fill', 'fl', scaled([0, 1, 2], 1)],
  ['mu', 'mu', choice(['hist', 'y10bond'])],
  ['roll', 'rw', scaled([5, 10, 15, 20], 1)],
  ['rollVm', 'rv', {
    decode: (s) => (s === '1' ? true : s === '0' ? false : INVALID),
    valid: (v) => typeof v === 'boolean',
    encode: (v) => (v ? '1' : '0'),
  }],
  ['wfWindow', 'wf', choice(['trailing', 'expanding'])],
  ['m0', 'pe', grid(0.5, 4, 100, { nullable: true })],
  ['ternaryMetric', 'tm', choice(['sharpe', 'cagr'])],
].map(([key, url, codec]) => ({ key, url, ...codec }));

export const URL_KEYS = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f.key, f.url])));

export const PRESETS = [
  { id: 'full', label: '1985-01 全样本', start: '1985-01' },
  { id: 'ndxTr', label: '1999-03 纳指含息实测起点', start: '1999-03' },
  { id: 'bubbleTop', label: '2000-03 泡沫顶', start: '2000-03' },
  { id: 'gfcLow', label: '2009-02 危机底', start: '2009-02' },
  { id: 'last20', label: '近20年', years: 20 },
  { id: 'last10', label: '近10年', years: 10 },
];

/** Preset → state patch; every preset ends at the latest data month (end:null). */
export function presetRange(preset, { latest }) {
  const p = typeof preset === 'string' ? PRESETS.find((x) => x.id === preset) : preset;
  return { start: p.start ?? addMonths(latest, -12 * p.years), end: null };
}

export function activePresetId(state, { latest }) {
  if (state.end != null && state.end !== latest) return null;
  return PRESETS.find((p) => presetRange(p, { latest }).start === state.start)?.id ?? null;
}

/** Inline hint for a candidate sample, or null when start/end are usable. */
export function rangeProblem(start, end, { latest }) {
  const last = end ?? latest;
  if (!isMonth(start) || !isMonth(last)) return '月份格式应为YYYY-MM';
  if (start < FIRST_MONTH) return `起点最早为${FIRST_MONTH}`;
  if (last > latest) return `终点最晚为${latest}`;
  if (start >= last) return '起点须早于终点';
  if (monthsBetween(start, last) < MIN_MONTHS) return `样本至少${MIN_MONTHS}个月`;
  return null;
}

/** Validate and canonicalise a (partial) state. Invalid fields revert to defaults with warnings. */
export function normaliseState(input = {}, { latest }) {
  const ctx = { latest };
  const state = { ...DEFAULT_STATE, ...input };
  const warnings = [];
  for (const f of FIELDS) {
    let value = state[f.key] === undefined ? DEFAULT_STATE[f.key] : state[f.key];
    if (!f.valid(value, ctx)) {
      warnings.push({ code: 'W_STATE', key: f.key, value, message: '部分设置无效，已恢复默认' });
      value = DEFAULT_STATE[f.key];
    }
    state[f.key] = f.canon && value !== null ? f.canon(value) : value;
  }
  if (state.end === latest) state.end = null;
  // 自定义 intercept needs a value: without one (invalid or missing cc) the tangency falls back to the default intercept
  if (state.intercept === 'custom' && state.interceptC === null) {
    if (!warnings.some((w) => w.key === 'interceptC')) warnings.push({ code: 'W_STATE', key: 'intercept', value: 'custom', message: '部分设置无效，已恢复默认' });
    state.intercept = DEFAULT_STATE.intercept;
  }
  const problem = rangeProblem(state.start, state.end, { latest });
  if (problem) {
    warnings.push({ code: 'W_SAMPLE', key: 'start', message: `${problem}，已恢复${DEFAULT_STATE.start}～${latest}` });
    state.start = DEFAULT_STATE.start;
    state.end = DEFAULT_STATE.end;
  }
  if (state.mu === 'y10bond' && state.basis !== 'tr') {
    warnings.push({ code: 'W_Y10_REQUIRES_TR', key: 'mu', message: '「美债=10年期收益率」只适用于含息总回报，已改用历史均值' });
    state.mu = 'hist';
  }
  return { state, warnings };
}

const clip = (s) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);
const paramWarning = (key, value) => ({ code: 'W_PARAM', key, value, message: `链接参数 ${key}=${clip(value)} 无效，已改用默认值` });

/** location.search → {state, warnings}. `v` (data vintage) older than latest pins the end month. */
export function parseUrl(search, { latest }) {
  const params = new URLSearchParams(search ?? '');
  const input = {};
  const warnings = [];
  for (const f of FIELDS) {
    if (!params.has(f.url)) continue;
    const text = params.get(f.url);
    const value = f.decode(text);
    if (value === INVALID || !f.valid(value, { latest })) warnings.push(paramWarning(f.url, text));
    else input[f.key] = value;
  }
  const vintage = params.get('v');
  if (vintage !== null && vintage !== latest) {
    if (!isMonth(vintage) || vintage <= FIRST_MONTH) {
      warnings.push(paramWarning('v', vintage));
    } else if (vintage < latest) {
      input.end ??= vintage;
      warnings.push({ code: 'W_VINTAGE', key: 'v', value: vintage, message: `数据已更新至${latest}，终点保留为${input.end}` });
    } else {
      warnings.push({ code: 'W_VINTAGE', key: 'v', value: vintage, message: `链接数据截至${vintage}，当前数据截至${latest}` });
    }
  }
  const normal = normaliseState(input, { latest });
  return { state: normal.state, warnings: [...warnings, ...normal.warnings] };
}

/** State → search string ('' or '?k=v&…'), omitting defaults; `vintage` appends v=<latest> for shared links. */
export function serialise(state, { latest, vintage = false } = {}) {
  const parts = [];
  for (const f of FIELDS) {
    const value = state?.[f.key];
    if (value === undefined || (f.key === 'end' && value === latest)) continue;
    const text = f.encode(value);
    if (text === null || text === f.encode(DEFAULT_STATE[f.key])) continue;
    parts.push(`${f.url}=${encodeURIComponent(text).replaceAll('%2C', ',')}`);
  }
  if (vintage && latest) parts.push(`v=${latest}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Warnings → toast strings; several bad link params collapse into one line. */
export function warningMessages(warnings) {
  const params = warnings.filter((w) => w.code === 'W_PARAM');
  const others = warnings.filter((w) => w.code !== 'W_PARAM').map((w) => w.message);
  const head = params.length > 1
    ? [`链接中${params.length}个参数无效，已改用默认值：${params.map((w) => w.key).join('、')}`]
    : params.map((w) => w.message);
  return [...head, ...others];
}
