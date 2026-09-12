// Minimal DOM builders. Never touches `document` at import time; text only via textContent.

const PROPS = new Set(['hidden', 'disabled', 'value', 'checked', 'selected', 'htmlFor', 'tabIndex']);

export function el(tag, props = {}, children = []) {
  const node = globalThis.document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    else if (PROPS.has(k)) node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

// A copy segment is a string or {t, k, v}: t = display text, k = bundle path, v = raw decimal.
export function segNode(seg) {
  if (seg == null) return null;
  if (typeof seg === 'string' || typeof seg === 'number') return globalThis.document.createTextNode(String(seg));
  if (seg.nodeType) return seg;
  const span = globalThis.document.createElement('span');
  span.textContent = seg.t;
  if (seg.k) span.dataset.k = seg.k;
  if (seg.v != null && Number.isFinite(seg.v)) span.dataset.v = String(seg.v);
  return span;
}

export function append(node, children) {
  for (const c of [children].flat(Infinity)) {
    const n = segNode(c);
    if (n) node.appendChild(n);
  }
  return node;
}

export function fill(node, children) {
  node.replaceChildren();
  return append(node, children);
}

export const keyOf = (bundle) => (bundle == null ? '' : typeof bundle.key === 'string' ? bundle.key : JSON.stringify(bundle.key ?? null));
