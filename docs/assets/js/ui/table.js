// Accessible tables, 查看数据 toggles and client-side CSV download.
import { el, fill, append } from './sections/dom.js?v=20260912';

let uidSeq = 0;
export const uid = (prefix) => `${prefix}-${++uidSeq}`;

const MINUS = '−';
const isCellObj = (c) => c && typeof c === 'object' && !Array.isArray(c) && !c.nodeType;

// Cell: string | {t, k, v, sub, cls, colspan, rowspan, th, children}. k/v mark a number (data-k / data-v).
// label → data-label (column name shown by stacked mobile layouts).
function cellEl(c, tag, label = null) {
  const lab = tag === 'td' && label ? { 'data-label': label } : {};
  if (!isCellObj(c)) return el(tag, tag === 'th' ? { scope: 'row' } : lab, [c ?? '—']);
  const numeric = c.k != null || c.v != null;
  const cls = [numeric ? 'num' : '', c.cls || ''].filter(Boolean).join(' ');
  const node = el(c.th ? 'th' : tag, {
    class: cls || null, colspan: c.colspan, rowspan: c.rowspan, scope: c.th || tag === 'th' ? c.scope || 'row' : null,
    ...(c.th || c.colspan > 1 ? {} : lab),
    dataset: numeric ? { ...(c.k ? { k: c.k } : {}), ...(Number.isFinite(c.v) ? { v: c.v } : {}) } : null,
  }, c.children ?? [c.t ?? '—']);
  if (c.sub) node.appendChild(el('span', { class: 'cell-sub' }, [c.sub]));
  c.ref?.(node);
  return node;
}

function headCell(h) {
  const o = isCellObj(h) ? h : { t: h };
  return el('th', { scope: o.scope || (o.colspan > 1 ? 'colgroup' : 'col'), colspan: o.colspan, rowspan: o.rowspan, class: o.cls }, [o.t ?? '']);
}

// head: header rows (arrays of cells, two-level allowed); rows: arrays or {cells, cls, attrs, on, divider}.
export function buildTable({ caption, captionHidden = false, head = [], rows = [], className = 'table', rowHeader = true, cellLabels = false }) {
  const table = el('table', { class: className });
  if (caption) table.appendChild(el('caption', { class: captionHidden ? 'visually-hidden' : null }, [caption]));
  const thead = el('thead');
  for (const hr of head) thead.appendChild(el('tr', {}, hr.map(headCell)));
  const labels = cellLabels && head.length === 1 ? head[0].map((h) => (isCellObj(h) ? h.t : h)) : [];
  const tbody = el('tbody');
  for (const r of rows) {
    const spec = Array.isArray(r) ? { cells: r } : r;
    const tr = el('tr', { class: spec.cls, ...(spec.attrs || {}), on: spec.on });
    spec.cells.forEach((c, i) => tr.appendChild(cellEl(c, rowHeader && i === 0 ? 'th' : 'td', labels[i])));
    tbody.appendChild(tr);
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

export const tableBlock = (opts) => el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': opts.caption || '数据表' }, [buildTable(opts)]);

// Raw chart.toTable() values → display text (U+2212 minus, ≤ 4 decimals).
export function rawText(x) {
  if (x == null || (typeof x === 'number' && !Number.isFinite(x))) return '—';
  if (typeof x !== 'number') return String(x);
  const s = Number.isInteger(x) ? String(x) : String(+x.toFixed(4));
  return s.replace('-', MINUS);
}
const colLabel = (c) => (isCellObj(c) ? c.label ?? c.id ?? '' : String(c));

// CSV cells Excel parses as numbers: ASCII minus, no plus sign or ×, 个百分点 dropped (units sit in the header), — → empty.
export function csvValue(x) {
  if (typeof x !== 'string') return x;
  const s = x.trim();
  if (s === '—') return '';
  const m = /^([+−-]?)×?(\d[\d,]*(?:\.\d+)?)(%|个百分点(?:\/年)?)?$/.exec(s);
  return m ? `${m[1] === '−' || m[1] === '-' ? '-' : ''}${m[2]}${m[3] === '%' ? '%' : ''}` : x;
}

export function toCsv(columns, rows) {
  const esc = (x) => {
    const s = x == null || (typeof x === 'number' && !Number.isFinite(x)) ? '' : String(x);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[columns, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}

export function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: filename, hidden: true });
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// getTable() → {columns, rows} (chart.toTable output) or null.
export function dataToggle({ getTable, filename = 'data.csv', caption = '图表数据', label = '查看数据' }) {
  const id = uid('data');
  const btn = el('button', { class: 'btn btn--ghost data-toggle__btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, [label]);
  const panel = el('div', { id, class: 'data-toggle__panel', hidden: true });
  let open = false;
  const render = () => {
    const t = getTable();
    if (!t?.columns?.length) return fill(panel, [el('p', { class: 'note', text: '数据计算中…' })]);
    const columns = t.columns.map(colLabel);
    const csvBtn = el('button', { class: 'btn btn--ghost', type: 'button', on: { click: () => downloadCsv(filename, toCsv(columns, t.rows.map((r) => r.map(csvValue)))) } }, ['下载CSV']);
    fill(panel, [tableBlock({ caption, head: [columns], rows: t.rows.map((r) => r.map(rawText)), className: 'table table--data' }), csvBtn]);
  };
  btn.addEventListener('click', () => {
    open = !open;
    btn.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) render();
  });
  return { root: append(el('div', { class: 'data-toggle' }), [btn, panel]), refresh: () => open && render() };
}
