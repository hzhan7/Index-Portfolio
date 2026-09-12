// Engine constants, state → job resolution, shared error and serialisation helpers (no imports).
export const VERSION = '20260912';
export const RULE_IDS = ['isoVolTe', 'maxSharpeCagrFloor', 'tangency', 'twoAsset', 'custom'];
export const DEFAULT_STATE = { start: '1985-01', end: null /*=latest*/, basis: 'tr', ndxDiv: 'default', wht: 0,
  rule: 'isoVolTe', volMult: 1, teCap: 0.05, intercept: 'implied', interceptC: null, spread: 0.005,
  pair: [0, 2], customW: null, fill: 2, mu: 'hist', roll: 10, rollVm: false, wfWindow: 'trailing', m0: null, ternaryMetric: 'sharpe' };
export const ERROR_CODES = ['E_SHORT_SAMPLE', 'E_NULL_DATA', 'E_BAD_RANGE', 'E_INFEASIBLE', 'E_Y10_REQUIRES_TR', 'E_BAD_WEIGHTS'];

export function engineError(code, message) {
  return Object.assign(new Error(message), { code });
}

// State holds decimals; values that are clearly percents (as typed in the URL) are converted defensively.
const dec = (x, limit = 1) => (x == null || !Number.isFinite(+x) ? null : Math.abs(+x) > limit ? +x / 100 : +x);

export function normalizeWeights(w) {
  if (w == null) return null;
  const v = Array.from(w, Number);
  const sum = v.reduce((a, b) => a + b, 0);
  if (v.length !== 3 || v.some(x => !Number.isFinite(x) || x < 0) || !(sum > 0)) throw engineError('E_BAD_WEIGHTS', '权重必须是三个非负数');
  const scale = Math.abs(sum - 100) < 1e-6 ? 100 : 1;
  if (Math.abs(sum / scale - 1) > 1e-6) throw engineError('E_BAD_WEIGHTS', '权重合计必须为100%');
  return v.map(x => x / scale);
}

function normalizePair(pair) {
  const p = typeof pair === 'string' ? pair.split('-').map(Number) : Array.from(pair ?? [0, 2], Number);
  const ok = [[0, 2], [1, 2], [0, 1]].some(([i, j]) => p[0] === i && p[1] === j);
  if (!ok) throw engineError('E_BAD_RANGE', '两资产组合只能是 纳指100+美债、标普500+美债 或 纳指100+标普500');
  return p;
}

const key = obj => JSON.stringify(obj);

export const ROLL_YEARS = [5, 10, 15, 20];
const CHOICES = { basis: ['tr', 'pr'], ndxDiv: ['default', 'low', 'high'], intercept: ['implied', 'rf', 'y10', 'custom'], mu: ['hist', 'y10bond'],
  wfWindow: ['trailing', 'expanding'] };
const badState = (name, value, rule) => engineError('E_BAD_RANGE', `参数 ${name} 无效：${String(value)}（${rule}）`);

// Numeric state checks (ui/state.js validates URLs; this keeps the CLI and any direct caller from running on NaN caps).
function finite(name, x, { nullable = false, ok = () => true, rule = '须为有限数' } = {}) {
  if (x == null) { if (nullable) return null; throw badState(name, x, rule); }
  const v = typeof x === 'string' && x.trim() === '' ? NaN : typeof x === 'number' || typeof x === 'string' ? +x : NaN;
  if (!Number.isFinite(v) || !ok(v)) throw badState(name, x, rule);
  return v;
}

function validateState(s) {
  for (const [name, allowed] of Object.entries(CHOICES)) if (!allowed.includes(s[name])) throw badState(name, s[name], allowed.join('/'));
  finite('volMult', s.volMult, { ok: v => v > 0, rule: '须为正数' });
  finite('teCap', s.teCap, { nullable: true, ok: v => v >= 0, rule: '须为非负数或 none' });
  finite('interceptC', s.interceptC, { nullable: true });
  finite('spread', s.spread, { ok: v => v >= 0, rule: '须为非负数' });
  finite('wht', s.wht, { ok: v => v >= 0 && dec(v) <= 1, rule: '须在 0～100% 之间' });
  finite('m0', s.m0, { nullable: true, ok: v => v > 0, rule: '须为正数' });
  finite('roll', s.roll, { ok: v => ROLL_YEARS.includes(v), rule: ROLL_YEARS.join('/') });
  if (![true, false, 0, 1, '0', '1'].includes(s.rollVm)) throw badState('rollVm', s.rollVm, '0/1');
}

export function resolveJob(state = {}, { latest = null } = {}) {
  const defined = Object.fromEntries(Object.entries(state ?? {}).filter(([, v]) => v !== undefined));
  const s = { ...DEFAULT_STATE, ...defined };
  if (!RULE_IDS.includes(s.rule)) throw engineError('E_BAD_RANGE', `未知规则：${s.rule}`);
  if (s.mu === 'y10bond' && s.basis !== 'tr') throw engineError('E_Y10_REQUIRES_TR', '「美债=10年期收益率」只适用于含息总回报口径');
  validateState(s);
  const sample = { start: s.start, end: s.end ?? latest, basis: s.basis, ndxDiv: s.ndxDiv, wht: dec(s.wht) ?? 0 };
  const volMult = +s.volMult;
  const params = {
    isoVolTe: { volMult, teCap: dec(s.teCap) },
    maxSharpeCagrFloor: {},
    tangency: { intercept: s.intercept, interceptC: dec(s.interceptC), spread: dec(s.spread, 0.1) ?? 0, volMult },
    twoAsset: { pair: normalizePair(s.pair) },
    custom: { w: normalizeWeights(s.customW) },
  };
  const rolling = { years: +s.roll, volMatched: Boolean(+s.rollVm) };
  const wf = { window: s.wfWindow, lookbackYears: 10 };
  const m0 = s.m0 == null ? null : +s.m0;
  const allocKey = { sample, rule: s.rule, mu: s.mu, params };
  return {
    state: s, sample, mu: s.mu, rule: { id: s.rule, params: params[s.rule] }, params, rolling, wf, m0,
    keys: {
      context: key({ basis: sample.basis, ndxDiv: sample.ndxDiv, wht: sample.wht, rolling, m0 }),
      sample: key(sample),
      alloc: key(allocKey),
      robust: key({ ...allocKey, wf }),
    },
  };
}

// Typed arrays → plain arrays (recursively) for JSON output; functions are never expected in results.
export function toPlain(x) {
  if (ArrayBuffer.isView(x)) return Array.from(x);
  if (Array.isArray(x)) return x.map(toPlain);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toPlain(v)]));
  return x;
}
