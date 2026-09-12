// Singleton chart tooltip (#chart-tooltip). Values lead, labels follow; textContent only.
import { ensureStyles, keySwatch } from './core.js?v=20260912';

let node = null;
let owner = null;
let pinned = false;
let onUnpin = null;
let listeners = null;

const cssColor = (c) => (typeof c === 'string' && c.startsWith('--') ? `var(${c})` : c || 'currentColor');

function getNode() {
  const doc = globalThis.document;
  if (node?.isConnected) return node;
  ensureStyles(doc);
  node = doc.getElementById('chart-tooltip');
  if (!node) {
    node = doc.createElement('div');
    node.id = 'chart-tooltip';
    doc.body.appendChild(node);
  }
  node.setAttribute('role', 'tooltip');
  node.hidden = true;
  return node;
}

function place(el, x, y) {
  const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
  const { width, height } = el.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + width > vw - 8) left = x - 14 - width;
  if (top + height > vh - 8) top = y - 14 - height;
  left = Math.max(8, Math.min(left, vw - width - 8));
  top = Math.max(8, Math.min(top, vh - height - 8));
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function detach() {
  if (!listeners) return;
  const doc = globalThis.document;
  doc.removeEventListener('pointerdown', listeners.down, true);
  doc.removeEventListener('keydown', listeners.key, true);
  doc.removeEventListener('scroll', listeners.scroll, true);
  listeners = null;
}

function attach() {
  detach();
  const doc = globalThis.document;
  const down = (e) => { if (!node.contains(e.target) && !owner?.contains?.(e.target)) unpin(); };
  const key = (e) => { if (e.key === 'Escape') unpin(); };
  // the node is position:fixed; once anything scrolls, a pinned tooltip would float over unrelated content
  const scroll = () => unpin();
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('scroll', scroll, true);
  listeners = { down, key, scroll };
}

/**
 * show({x, y, title, rows:[{colorVar?, shape?, value, label}], owner?, pin?, actions?:[{label, onClick}], onUnpin?})
 * x/y are viewport coordinates of the anchor. A pinned tooltip ignores hover updates until unpinned.
 */
export function show({ x, y, title = '', rows = [], owner: who = null, pin = false, actions = [], onUnpin: cb = null } = {}) {
  const el = getNode();
  if (pinned && !pin) return;
  if (pinned && pin && who !== owner) unpin();
  const doc = el.ownerDocument;
  owner = who;
  pinned = !!pin;
  onUnpin = pinned ? cb : null;
  el.replaceChildren();
  if (title) {
    const t = doc.createElement('div');
    t.className = 'ip-tt__title';
    t.textContent = title;
    el.appendChild(t);
  }
  for (const r of rows) {
    const row = doc.createElement('div');
    row.className = 'ip-tt__row';
    if (r.colorVar || r.shape) {
      const kind = r.shape && r.shape !== 'line' ? (r.shape === 'rect' || r.shape === 'dash' ? r.shape : 'shape') : 'line';
      const sw = keySwatch(doc, { kind, shape: r.shape, color: 'currentColor' });
      sw.style.color = cssColor(r.colorVar ?? '--ink');
      row.appendChild(sw);
    }
    const v = doc.createElement('span');
    v.className = 'ip-tt__value';
    v.textContent = r.value ?? '';
    row.appendChild(v);
    if (r.label) {
      const l = doc.createElement('span');
      l.className = 'ip-tt__label';
      l.textContent = r.label;
      row.appendChild(l);
    }
    el.appendChild(row);
  }
  if (pinned && actions.length) {
    const bar = doc.createElement('div');
    bar.className = 'ip-tt__actions';
    for (const a of actions) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick?.(); });
      bar.appendChild(b);
    }
    el.appendChild(bar);
  }
  if (pinned) { el.setAttribute('data-pinned', ''); attach(); } else { el.removeAttribute('data-pinned'); detach(); }
  el.hidden = false;
  place(el, x, y);
}

/** Hide unless pinned; with an owner, only hides that owner's tooltip. */
export function hide(who = null) {
  if (!node || pinned) return;
  if (who && owner && who !== owner) return;
  node.hidden = true;
  owner = null;
}

export function unpin(who = null) {
  if (!node || !pinned || (who && who !== owner)) return;
  pinned = false;
  detach();
  node.removeAttribute('data-pinned');
  node.hidden = true;
  const cb = onUnpin;
  onUnpin = null;
  owner = null;
  cb?.();
}

export const isPinned = (who = null) => pinned && (!who || who === owner);

/** Drop any tooltip (pinned or not) owned by a chart that is being destroyed. */
export function release(who) {
  if (!node || owner !== who) return;
  if (pinned) unpin(who); else hide(who);
}
