// Simplified-Chinese number formatting shared by charts and sections.
// Rules: U+2212 for negatives, no space before %, ranges joined with ～, "—" for missing values.

export const MINUS = '−';
export const RANGE_SEP = '～';
export const MISSING = '—';
export const ASSET_SHORT = ['纳指', '标普', '美债'];
export const ASSET_NAMES = ['纳指100', '标普500', '10年美债'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Round |x| to dp decimals; toPrecision(12) first so 12.45 → "12.5" instead of float-artefact "12.4".
function fixed(abs, dp) {
  const p = 10 ** dp;
  return (Math.round(Number((abs * p).toPrecision(12))) / p).toFixed(dp);
}

function signedText(x, dp, withPlus) {
  const body = fixed(Math.abs(x), dp);
  if (Number(body) === 0) return body;
  return (x < 0 ? MINUS : withPlus ? '+' : '') + body;
}

export const fmtNum = (x, dp = 2) => (isNum(x) ? signedText(x, dp, false) : MISSING);
export const fmtNumSigned = (x, dp = 2) => (isNum(x) ? signedText(x, dp, true) : MISSING);

/** Decimal → percent: 0.1477 → "14.8%". */
export const fmtPct = (x, dp = 1) => (isNum(x) ? `${signedText(x * 100, dp, false)}%` : MISSING);
export const fmtPctSigned = (x, dp = 1) => (isNum(x) ? `${signedText(x * 100, dp, true)}%` : MISSING);

/** Decimal difference → percentage points: 0.029 → "+2.9个百分点". */
export const fmtPp = (x, dp = 1) => (isNum(x) ? `${signedText(x * 100, dp, true)}个百分点` : MISSING);
export const fmtPpBare = (x, dp = 1) => (isNum(x) ? signedText(x * 100, dp, true) : MISSING);

/** Log points per year, input already in lp (100·ln units): −0.83 → "−0.8个百分点/年". */
export const fmtLp = (x, dp = 1) => (isNum(x) ? `${signedText(x, dp, true)}个百分点/年` : MISSING);
export const fmtLpBare = (x, dp = 1) => (isNum(x) ? signedText(x, dp, true) : MISSING);

/** Growth multiple: 2.882 → "×2.88". */
export const fmtRatio = (x, dp = 2) => (isNum(x) ? `×${signedText(x, dp, false)}` : MISSING);

/** "YYYY-MM" from a month string, ISO date string or Date. */
export function fmtMonth(s) {
  if (s instanceof Date && !Number.isNaN(s.getTime())) {
    return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})/.exec(s.trim()) : null;
  return m ? `${m[1]}-${m[2]}` : MISSING;
}

export const fmtMonths = (n) => (isNum(n) ? `${Math.round(n)}个月` : MISSING);

/** fmtRange(−0.22, 0.17, fmtNumSigned) → "−0.22～+0.17". */
export const fmtRange = (lo, hi, fmt = fmtNum) => `${fmt(lo)}${RANGE_SEP}${fmt(hi)}`;

/** ▲ / ▼ / "" for a delta; eps lets callers treat values that round to zero as flat. */
export const deltaArrow = (x, eps = 0) => (!isNum(x) ? '' : x > eps ? '▲' : x < -eps ? '▼' : '');

/** Integer percents summing to 100 (largest remainder; ties go to the lower index). */
export function roundWeights(w) {
  const v = Array.from(w ?? [], (x) => (isNum(x) && x > 0 ? x : 0));
  const total = v.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return v.map(() => 0);
  const raw = v.map((x) => (x / total) * 100);
  const out = raw.map((x) => Math.floor(x + 1e-9));
  const order = raw.map((x, i) => [x - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]] += 1;
  return out;
}

/** "纳指 39 / 标普 44 / 美债 17". */
export const fmtWeights = (w, labels = ASSET_SHORT) =>
  roundWeights(w).map((v, i) => `${labels[i] ?? ''} ${v}`.trim()).join(' / ');
