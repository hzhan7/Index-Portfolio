// Sticky bar (sample selects, 快捷 menu, basis toggle), 数据设置 drawer, mobile bottom sheet, copy link, toasts.
import { FIRST_MONTH, PRESETS, activePresetId, presetRange, rangeProblem, serialise } from './state.js?v=20260912';

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const WHT_NOTE = '新加坡投资者：美国上市ETF 30%；爱尔兰UCITS基金层面约15%（参数示例，非税务建议）';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name === 'text') el.textContent = value;
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

/** toast(message, {actionLabel, onAction, duration}) into an aria-live region; identical visible messages are not repeated. */
export function createToaster(region, { max = 3, timeout = 5000 } = {}) {
  return function toast(message, { actionLabel, onAction, duration = timeout } = {}) {
    if (!region || !message || [...region.children].some((el) => el.dataset.message === message)) return;
    const item = h('div', { class: 'toast', 'data-message': message }, h('span', { class: 'toast__msg', text: message }));
    const close = () => item.remove();
    if (actionLabel) {
      const action = h('button', { type: 'button', class: 'toast__btn', text: actionLabel });
      action.addEventListener('click', () => { close(); onAction?.(); });
      item.append(action);
    }
    const dismiss = h('button', { type: 'button', class: 'toast__btn', 'aria-label': '关闭提示', text: '×' });
    dismiss.addEventListener('click', close);
    item.append(dismiss);
    region.append(item);
    while (region.children.length > max) region.firstElementChild.remove();
    if (duration > 0) {
      let timer = setTimeout(close, duration);
      const hold = () => clearTimeout(timer);
      const resume = () => { clearTimeout(timer); timer = setTimeout(close, duration / 2); };
      item.addEventListener('pointerenter', hold);
      item.addEventListener('focusin', hold);
      item.addEventListener('pointerleave', resume);
      item.addEventListener('focusout', resume);
    }
  };
}

// Modal <dialog>: Esc and backdrop close, Tab wraps inside, focus returns to the opener.
function modal(dialog) {
  let opener = null;
  let restoreFocus = true;
  const focusables = () => [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  const finish = () => {
    opener?.setAttribute?.('aria-expanded', 'false');
    if (restoreFocus) opener?.focus?.({ preventScroll: true });
    opener = null;
  };
  function open(from) {
    if (dialog.open) return;
    opener = from ?? document.activeElement;
    restoreFocus = true;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    opener?.setAttribute?.('aria-expanded', 'true');
    focusables()[0]?.focus();
  }
  function close({ returnFocus = true } = {}) {
    if (!dialog.open) return;
    restoreFocus = returnFocus;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    finish();
  }
  // Every close path (Esc via the browser's close watcher, backdrop, buttons) resets aria-expanded once:
  // Chrome can close a modal on Esc without dispatching `close`, so also watch the open attribute.
  dialog.addEventListener('close', finish);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (!dialog.open) finish(); }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => close());
  return { open, close };
}

// Year/month selects (never type=month). Invalid ranges show an inline hint and are not committed.
function sampleFields({ prefix, latest, setState, label = false }) {
  const years = [];
  for (let y = Number(FIRST_MONTH.slice(0, 4)); y <= Number(latest.slice(0, 4)); y += 1) years.push(String(y));
  const hintId = `${prefix}-sample-hint`;
  const select = (name, text, values) => h('select', { class: 'select', id: `${prefix}-${name}`, 'aria-label': text, 'aria-describedby': hintId },
    values.map((v) => h('option', { value: v, text: v })));
  const sy = select('sy', '起点年份', years);
  const sm = select('sm', '起点月份', MONTHS);
  const ey = select('ey', '终点年份', years);
  const em = select('em', '终点月份', MONTHS);
  const hint = h('span', { class: 'sample__hint', id: hintId, role: 'status' });
  const el = h('div', { class: 'sample', role: 'group', 'aria-label': '样本区间' },
    label && h('span', { class: 'bar__label sample__label', 'aria-hidden': 'true', text: '样本' }),
    h('span', { class: 'sample__part' }, sy, sm),
    h('span', { class: 'sample__arrow', 'aria-hidden': 'true', text: '→' }),
    h('span', { class: 'sample__part' }, ey, em),
    hint);

  const limit = (ys, ms) => {
    for (const option of ms.options) {
      const month = `${ys.value}-${option.value}`;
      option.disabled = month < FIRST_MONTH || month > latest;
    }
    if (ms.selectedOptions[0]?.disabled) ms.value = ys.value === latest.slice(0, 4) ? latest.slice(5) : FIRST_MONTH.slice(5);
  };
  const show = (problem) => {
    hint.textContent = problem ?? '';
    for (const s of [sy, sm, ey, em]) s.setAttribute('aria-invalid', String(Boolean(problem)));
  };
  const put = (ys, ms, month) => {
    ys.value = month.slice(0, 4);
    limit(ys, ms);
    ms.value = month.slice(5);
  };
  const onChange = () => {
    limit(sy, sm);
    limit(ey, em);
    const start = `${sy.value}-${sm.value}`;
    const end = `${ey.value}-${em.value}`;
    const problem = rangeProblem(start, end, { latest });
    show(problem);
    if (!problem) setState({ start, end: end === latest ? null : end });
  };
  for (const s of [sy, sm, ey, em]) s.addEventListener('change', onChange);
  return {
    el,
    sync(state) {
      put(sy, sm, state.start);
      put(ey, em, state.end ?? latest);
      show(null);
    },
  };
}

// 快捷▾ — WAI-ARIA menu button with menuitemradio items.
function presetMenu({ latest, onPick }) {
  const button = h('button', { type: 'button', class: 'btn', id: 'preset-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'preset-menu' },
    '快捷', h('span', { class: 'btn__caret', 'aria-hidden': 'true', text: '▾' }));
  const items = PRESETS.map((p) => h('li', { role: 'menuitemradio', tabindex: '-1', 'aria-checked': 'false', 'data-preset': p.id },
    h('span', { text: p.label }),
    h('span', { class: 'menu__meta', text: `${presetRange(p, { latest }).start}～${latest}` })));
  const menu = h('ul', { class: 'menu', id: 'preset-menu', role: 'menu', 'aria-labelledby': 'preset-button', hidden: true }, items);
  const el = h('div', { class: 'menu-wrap' }, button, menu);

  const focusAt = (i) => items[(i + items.length) % items.length].focus();
  const outside = (e) => { if (!el.contains(e.target)) close(false); };
  function open(at) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const checked = items.findIndex((li) => li.getAttribute('aria-checked') === 'true');
    focusAt(at ?? Math.max(checked, 0));
    document.addEventListener('pointerdown', outside, true);
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) button.focus();
  }
  const pick = (li) => {
    close();
    onPick(li.dataset.preset);
  };
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    open(e.key === 'ArrowDown' ? 0 : items.length - 1);
  });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('[role="menuitemradio"]');
    if (li) pick(li);
  });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') focusAt(i + 1);
    else if (e.key === 'ArrowUp') focusAt(i - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(items.length - 1);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Enter' || e.key === ' ') {
      if (i >= 0) pick(items[i]);
    } else {
      if (e.key === 'Tab') close(false);
      return;
    }
    e.preventDefault();
  });
  return {
    el,
    sync(state) {
      const active = activePresetId(state, { latest });
      for (const li of items) li.setAttribute('aria-checked', String(li.dataset.preset === active));
    },
  };
}

function presetChips({ latest, onPick }) {
  const buttons = PRESETS.map((p) => h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: p.label }));
  buttons.forEach((b, i) => b.addEventListener('click', () => onPick(PRESETS[i].id)));
  return {
    el: h('div', { class: 'chips', role: 'group', 'aria-label': '快捷样本' }, buttons),
    sync(state) {
      const active = activePresetId(state, { latest });
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(PRESETS[i].id === active)));
    },
  };
}

function segmented({ label, options, get, set }) {
  const buttons = options.map(([, text]) => h('button', { type: 'button', 'aria-pressed': 'false', text }));
  buttons.forEach((b, i) => b.addEventListener('click', () => set(options[i][0])));
  return {
    el: h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons),
    sync(state) {
      const current = get(state);
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === current)));
    },
  };
}

function dividendSource(history) {
  const segment = history?.coverage?.find((c) => c.id === 'NDX_TR')?.segments?.find((s) => s.status === 'estimated');
  const title = segment && history.sources?.[segment.source_id]?.title;
  return `来源：${title ?? 'QQQ 招股书（SEC）中的纳指100年末股息率'}`;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API missing or denied (e.g. http): fall back to a selected textarea.
  }
  const active = document.activeElement;
  const area = h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  (document.querySelector('dialog[open]') ?? document.body).append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

/** Builds header, drawer and sheet controls into index.html's mount points; update(state) re-syncs them. */
export function createControls({ latest, history, getState, setState, toast, scrollTo }) {
  const byId = (id) => document.getElementById(id);
  const drawerEl = byId('settings-drawer');
  const sheetEl = byId('settings-sheet');
  const summary = byId('bar-summary');
  const drawer = modal(drawerEl);
  const sheet = modal(sheetEl);
  const parts = [];
  const use = (part) => {
    parts.push(part);
    return part.el;
  };

  const pickPreset = (id) => setState(presetRange(id, { latest }));
  const basis = () => use(segmented({ label: '口径', options: [['tr', '含息总回报'], ['pr', '价格']], get: (s) => s.basis, set: (v) => setState({ basis: v }) }));
  const dividends = () => use(segmented({ label: '纳指100 1985～1999 股息估算', options: [['default', '默认'], ['low', '低（×0.75）'], ['high', '高（×1.25）']], get: (s) => s.ndxDiv, set: (v) => setState({ ndxDiv: v }) }));
  const withholding = () => use(segmented({ label: '股息预扣税', options: [[0, '0%（指数口径）'], [0.15, '15%'], [0.3, '30%']], get: (s) => s.wht, set: (v) => setState({ wht: v }) }));
  const field = (title, control, note) => h('div', { class: 'field' },
    h('div', { class: 'field__label', 'aria-hidden': 'true', text: title }), control, note && h('p', { class: 'note', text: note }));
  const copyButton = () => {
    const button = h('button', { type: 'button', class: 'btn', text: '复制链接' });
    button.addEventListener('click', copyLink);
    return button;
  };
  const methodsLink = (dialog) => {
    const link = h('a', { class: 'link', href: '#methods', text: '数据来源与方法 ↓' });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      dialog.close({ returnFocus: false });
      scrollTo('methods');
    });
    return link;
  };

  const drawerButton = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'aria-controls': 'settings-drawer', 'aria-expanded': 'false', text: '数据设置' });
  drawerButton.addEventListener('click', () => drawer.open(drawerButton));
  byId('bar-controls').append(
    use(sampleFields({ prefix: 'bar', latest, setState, label: true })),
    h('span', { class: 'bar__sep', 'aria-hidden': 'true' }),
    use(presetMenu({ latest, onPick: pickPreset })),
    h('span', { class: 'bar__sep', 'aria-hidden': 'true' }),
    h('span', { class: 'bar__label', 'aria-hidden': 'true', text: '口径' }),
    basis(),
    h('div', { class: 'bar__actions' }, drawerButton, copyButton()),
  );

  const source = dividendSource(history);
  drawerEl.querySelector('[data-controls]').append(
    field('纳指100 1985～1999 股息估算', dividends(), source),
    field('股息预扣税', withholding(), WHT_NOTE),
    methodsLink(drawer),
  );
  sheetEl.querySelector('[data-controls]').append(
    field('样本', use(sampleFields({ prefix: 'sheet', latest, setState }))),
    field('快捷', use(presetChips({ latest, onPick: pickPreset }))),
    field('口径', basis()),
    field('纳指100 1985～1999 股息估算', dividends(), source),
    field('股息预扣税', withholding(), WHT_NOTE),
    h('div', { class: 'dialog__actions' }, methodsLink(sheet), copyButton()),
  );
  summary.addEventListener('click', () => sheet.open(summary));
  matchMedia('(min-width: 768px)').addEventListener('change', (e) => (e.matches ? sheet : drawer).close({ returnFocus: false }));

  async function copyLink() {
    const url = `${location.href.split(/[?#]/)[0]}${serialise(getState(), { latest, vintage: true })}`;
    const ok = await writeClipboard(url);
    toast(ok ? `链接已复制（数据截至${latest}）` : `复制失败，请手动复制：${url}`, { duration: ok ? 3000 : 12000 });
  }

  function update(state) {
    for (const part of parts) part.sync(state);
    summary.querySelector('[data-summary]').textContent = `${state.start}～${state.end ?? latest} · ${state.basis === 'tr' ? '含息' : '价格'}`;
  }

  update(getState());
  return { update };
}
