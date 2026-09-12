// §2 bar-table cell helper: number + thin bar diverging from the column zero (pos --c-pos, neg --c-neg).
import { ensureStyles, isNum, clamp } from './core.js?v=20260912';
import { fmtNum, fmtNumSigned, fmtPct, fmtPp, fmtLpBare, fmtRatio, MISSING } from '../lib/format.js?v=20260912';

export const FORMATS = {
  lp: (v) => fmtLpBare(v),
  pct: (v) => fmtPct(v, 2),
  pp: (v) => fmtPp(v),
  num: (v) => fmtNum(v, 2),
  signed: (v) => fmtNumSigned(v, 1),
  ratio: (v) => fmtRatio(v),
};

/** Column domain always containing zero. */
export function domainOf(values) {
  let lo = 0, hi = 0;
  for (const v of values ?? []) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return [lo, hi];
}

/** Bar placement in percent of the cell width. */
export function barGeometry(value, domain) {
  const lo = Math.min(0, domain?.[0] ?? 0), hi = Math.max(0, domain?.[1] ?? 0), span = hi - lo;
  const zero = span > 0 ? (-lo / span) * 100 : 0;
  if (!isNum(value) || !(span > 0)) return { zero, left: zero, width: 0, sign: 0 };
  const pos = ((clamp(value, lo, hi) - lo) / span) * 100;
  return { zero, left: Math.min(zero, pos), width: Math.abs(pos - zero), sign: Math.sign(value) };
}

export function render(td, { value, domain = [0, 0], format = 'num', k = null } = {}) {
  const doc = td.ownerDocument;
  ensureStyles(doc);
  const fmt = typeof format === 'function' ? format : FORMATS[format] ?? FORMATS.num;
  const wrap = doc.createElement('div');
  wrap.className = 'ip-barcell';
  const num = doc.createElement('span');
  num.className = 'num ip-barcell__num';
  num.textContent = isNum(value) ? fmt(value) : MISSING;
  if (k) num.dataset.k = k;
  if (isNum(value)) num.dataset.v = String(value);
  const geo = barGeometry(value, domain);
  const track = doc.createElement('span');
  track.className = 'ip-barcell__track';
  track.setAttribute('aria-hidden', 'true');
  const bar = doc.createElement('span');
  bar.className = 'ip-barcell__bar';
  Object.assign(bar.style, { left: `${geo.left}%`, width: `${geo.width}%`, background: geo.sign < 0 ? 'var(--c-neg, #eb6834)' : 'var(--c-pos, #2a78d6)' });
  const zero = doc.createElement('span');
  zero.className = 'ip-barcell__zero';
  zero.style.left = `${geo.zero}%`;
  track.append(bar, zero);
  wrap.append(num, track);
  td.replaceChildren(wrap);
  return wrap;
}
