// Section plumbing: chart slots (lazy modules), controls, pending/error state, month math.
import { el, fill } from './dom.js?v=20260912';
import { dataToggle, uid } from '../table.js?v=20260912';

export const ASSETS = [
  { id: 'ndx', short: '纳指', label: '纳指100', colorVar: '--c-ndx' },
  { id: 'spx', short: '标普', label: '标普500', colorVar: '--c-spx' },
  { id: 'ust', short: '美债', label: '10年美债', colorVar: '--c-ust' },
];

export const mountPoint = (rootEl) => rootEl.querySelector?.('[data-mount]') ?? rootEl;

// api.charts[name] may be a module, a promise of one, or a lazy () => import(...).
export async function loadChart(api, name) {
  const entry = api.charts?.[name];
  if (!entry) throw new Error(`chart module ${name} unavailable`);
  const mod = await (typeof entry === 'function' && !entry.create && !entry.render ? entry() : entry);
  // chart modules export create(); barCell is a helper that exports render() only
  return mod?.create || mod?.render ? mod : mod?.default;
}

export function chartSlot(api, name, { ariaLabel = '', filename = `${name}.csv`, table = true, cls = '' } = {}) {
  const titleEl = el('figcaption', { class: 'chart-figure__title' });
  const mount = el('div', { class: `chart chart--${name}` });
  let mod = null, inst = null, props = null, drawnKey, failed = false, loading = null;
  const toggle = table ? dataToggle({ filename, caption: ariaLabel, getTable: () => (mod?.toTable && props ? mod.toTable(props) : null) }) : null;
  const root = el('figure', { class: `chart-figure ${cls}`.trim() }, [titleEl, mount, toggle?.root]);
  const ensure = () => (loading ??= loadChart(api, name).then(
    (m) => { mod = m; inst = m.create(mount, { title: ariaLabel, ariaLabel }); },
    () => { failed = true; fill(mount, [el('p', { class: 'note is-error', text: '图表加载失败' })]); },
  ));
  return {
    root,
    setTitle: (segs) => fill(titleEl, segs),
    async update(next) {
      props = next;
      await ensure();
      if (failed || props !== next || next.key === drawnKey) return;
      inst.update(next);
      drawnKey = next.key;
      toggle?.refresh();
    },
    destroy() { inst?.destroy(); inst = null; drawnKey = undefined; },
  };
}

// Segmented buttons (.seg, aria-pressed). options: [{value, label, title?}]
export function segControl({ label, options, onSelect, cls = '' }) {
  const buttons = new Map();
  const group = el('div', { class: `seg ${cls}`.trim(), role: 'group', 'aria-label': label });
  for (const o of options) {
    const b = el('button', { type: 'button', 'aria-pressed': 'false', title: o.title, on: { click: () => onSelect(o.value) } }, [o.label]);
    buttons.set(String(o.value), b);
    group.appendChild(b);
  }
  return {
    root: group,
    set(value, { disabled = {}, titles = {}, labels = {} } = {}) {
      for (const [v, b] of buttons) {
        b.setAttribute('aria-pressed', String(v === String(value)));
        b.disabled = !!disabled[v];
        if (titles[v] !== undefined) titles[v] ? b.setAttribute('title', titles[v]) : b.removeAttribute('title');
        if (labels[v] !== undefined) fill(b, [labels[v]]); // string or copy segments (data-k numbers)
      }
    },
  };
}

export function selectControl({ label, onChange, cls = '' }) {
  const id = uid('sel');
  const select = el('select', { id, on: { change: () => onChange(select.value) } });
  const root = el('div', { class: `select ${cls}`.trim() }, [el('label', { htmlFor: id, text: label }), select]);
  let sig = '';
  return {
    root, select,
    set(options, value, { disabled = false } = {}) {
      const next = JSON.stringify(options);
      if (next !== sig) {
        sig = next;
        fill(select, options.map((o) => el('option', { value: String(o.value), disabled: o.disabled }, [o.label])));
      }
      select.value = String(value);
      select.disabled = disabled;
    },
  };
}

// Slider: head (label + output) and a track holding shaded zones given as fractions of the track.
export function rangeControl({ label, min, max, step, onInput, onCommit, cls = '' }) {
  const id = uid('rng');
  const input = el('input', { id, type: 'range', min, max, step });
  const out = el('output', { htmlFor: id, class: 'range__out' });
  input.addEventListener('input', () => onInput?.(+input.value));
  input.addEventListener('change', () => onCommit?.(+input.value));
  const head = el('div', { class: 'range__head' }, [el('label', { htmlFor: id }, [label]), out]);
  const track = el('div', { class: 'range__track' }, [input]);
  const zones = new Map();
  const zone = (name, from, to, zoneCls = '') => {
    let z = zones.get(name);
    if (!z) {
      z = el('span', { class: `range__zone ${zoneCls}`.trim(), 'aria-hidden': 'true' });
      zones.set(name, z);
      if (track.insertBefore) track.insertBefore(z, input); else track.appendChild(z);
    }
    const a = Math.max(0, Math.min(1, from)), b = Math.max(a, Math.min(1, to));
    z.hidden = !(b > a);
    z.style.setProperty('left', `${(a * 100).toFixed(2)}%`);
    z.style.setProperty('width', `${((b - a) * 100).toFixed(2)}%`);
  };
  return { root: el('div', { class: `range ${cls}`.trim() }, [head, track]), input, out, zone };
}

export const statusLine = () => el('p', { class: 'note section-error', role: 'status', hidden: true });

// Robust bundle for readers outside §4: null while a newer robust job runs or after it failed, so out-of-sample numbers
// from the previous state never sit next to this state's labels (§5 criterion 7). §4 itself keeps the dimmed old render.
export const robustReady = (view) => (view.pending?.robust || view.errors?.robust ? null : view.bundles?.robust ?? null);

export function applyStatus(mountEl, statusEl, view, kinds) {
  const err = kinds.map((k) => view.errors?.[k]).find(Boolean);
  mountEl.classList.toggle('is-pending', kinds.some((k) => view.pending?.[k]));
  mountEl.classList.toggle('is-error', !!err);
  statusEl.hidden = !err;
  statusEl.textContent = err ? `计算失败：${err.message || err.code}` : '';
}

export function debounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const monthIndex = (m) => +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1);
export const monthFrom = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, k) => monthFrom(monthIndex(m) + k);
