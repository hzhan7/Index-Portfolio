// Page orchestration (§4c): fetch data, URL-backed store, compute client, section mounting and rendering.
import * as format from './lib/format.js?v=20260912';
import { resolveJob } from './engine/params.js?v=20260912';
import { normaliseState, parseUrl, serialise, warningMessages } from './ui/state.js?v=20260912';
import { createControls, createToaster } from './ui/controls.js?v=20260912';
import { createCompute } from './ui/workers.js?v=20260912';

const KINDS = ['context', 'sample', 'alloc', 'robust'];

const SECTIONS = [
  ['hero', () => import('./ui/sections/hero.js?v=20260912')],
  ['compare', () => import('./ui/sections/compare.js?v=20260912')],
  ['decomp', () => import('./ui/sections/decomp.js?v=20260912')],
  ['allocation', () => import('./ui/sections/allocation.js?v=20260912')],
  ['robust', () => import('./ui/sections/robust.js?v=20260912')],
  ['methods', () => import('./ui/sections/methods.js?v=20260912')],
];

// api.charts.<name>() → Promise<module> (lazy, memoised). api.engine.decomp is preloaded because the §2 P/E
// slider calls it synchronously; api.engine.loadBbg() imports engine/bbg.js only when the 彭博 panel opens.
const CHARTS = {
  areaDiverging: () => import('./charts/areaDiverging.js?v=20260912'),
  lineChart: () => import('./charts/lineChart.js?v=20260912'),
  frontier: () => import('./charts/frontier.js?v=20260912'),
  stackedArea: () => import('./charts/stackedArea.js?v=20260912'),
  ternary: () => import('./charts/ternary.js?v=20260912'),
  twoAssetPanels: () => import('./charts/twoAssetPanels.js?v=20260912'),
  weightBar: () => import('./charts/weightBar.js?v=20260912'),
  barCell: () => import('./charts/barCell.js?v=20260912'),
  coverageStrip: () => import('./charts/coverageStrip.js?v=20260912'),
  tooltip: () => import('./charts/tooltip.js?v=20260912'),
};
const ENGINE = {
  decomp: () => import('./engine/decomp.js?v=20260912'),
};
let bbgPromise = null;
const loadBbg = () => (bbgPromise ??= import('./engine/bbg.js?v=20260912').catch((err) => {
  bbgPromise = null; // allow a retry on the next open
  throw err;
}));

const toast = createToaster(document.getElementById('toasts'));
const blank = (value) => Object.fromEntries(KINDS.map((kind) => [kind, value]));
const loadModules = async (loaders) => Object.fromEntries(await Promise.all(
  Object.entries(loaders).map(async ([name, load]) => [name, await load().catch(() => undefined)]),
));
const memo = (loaders) => Object.fromEntries(Object.entries(loaders).map(([name, load]) => {
  let promise = null;
  return [name, () => (promise ??= load())];
}));

function note(className, text) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function flagError(root, message) {
  let box = root.querySelector(':scope > [data-shell-error]');
  if (!box) {
    box = note('is-error', '');
    box.dataset.shellError = '';
    root.prepend(box);
  }
  box.textContent = message;
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function scrollTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.querySelector(':scope > details')?.setAttribute('open', '');
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  const heading = target.querySelector('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

async function main() {
  const [history, valuation, engine] = await Promise.all([
    loadJson(new URL('../../data/history.json?v=20260912', import.meta.url)),
    loadJson(new URL('../../data/valuation.json?v=20260912', import.meta.url)).catch(() => null),
    loadModules(ENGINE),
  ]);
  const latest = history.observations.at(-1).month;
  const initial = parseUrl(location.search, { latest });
  const view = { state: initial.state, bundles: blank(null), pending: blank(false), progress: { robust: null }, errors: blank(null) };
  const requested = {};
  const sections = [];
  let renderQueued = false;
  let urlTimer = 0;

  const settle = (kind, error) => {
    view.pending[kind] = false;
    view.errors[kind] = error;
    if (kind === 'robust') view.progress.robust = null;
    scheduleRender();
  };
  const compute = createCompute({
    history,
    valuation,
    onResult: ({ kind, result }) => {
      view.bundles[kind] = result;
      settle(kind, null);
    },
    onError: ({ kind, code, message }) => settle(kind, { code, message }),
    onProgress: ({ kind, stage, done, total }) => {
      view.progress[kind] = { stage, done, total };
      scheduleRender();
    },
  });

  function writeUrl(replace, delay = replace ? 150 : 0) {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const url = new URL(location.href);
      url.search = serialise(view.state, { latest });
      try {
        window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
      } catch {
        // Safari rate-limits history writes during slider drags; the next write carries the state.
      }
    }, delay);
  }

  function setState(patch, { replace = true } = {}) {
    const { state, warnings } = normaliseState({ ...view.state, ...patch }, { latest });
    for (const message of warningMessages(warnings)) toast(message);
    if (serialise(state, { latest }) === serialise(view.state, { latest })) return;
    view.state = state;
    writeUrl(replace);
    dispatch();
  }

  // Request only the job kinds whose resolveJob key changed; renderers skip unchanged bundle keys.
  function dispatch() {
    controls.update(view.state);
    let keys;
    try {
      ({ keys } = resolveJob(view.state, { latest }));
    } catch (err) {
      for (const kind of KINDS) settle(kind, { code: err.code ?? 'E_STATE', message: err.message });
      return;
    }
    for (const kind of KINDS) {
      if (keys[kind] === requested[kind]) continue;
      requested[kind] = keys[kind];
      view.pending[kind] = true;
      view.errors[kind] = null;
      if (kind === 'robust') view.progress.robust = null;
      compute.request(kind, view.state, { key: keys[kind] });
    }
    scheduleRender();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render() {
    renderQueued = false;
    const snapshot = {
      state: view.state,
      latest,
      bundles: { ...view.bundles },
      pending: { ...view.pending },
      progress: { ...view.progress },
      errors: { ...view.errors },
    };
    for (const section of sections) {
      try {
        section.render(snapshot);
      } catch (err) {
        flagError(section.root, '本节显示出错，请调整设置或刷新页面');
        globalThis.reportError?.(err);
      }
    }
  }

  const api = {
    getState: () => view.state,
    setState,
    toast,
    scrollTo,
    format,
    charts: memo(CHARTS),
    engine: { ...engine, loadBbg },
    data: { history, valuation },
  };
  const controls = createControls({ latest, history, getState: api.getState, setState, toast, scrollTo });

  for (const node of document.querySelectorAll('[data-vintage]')) node.textContent = `数据截至${latest}`;
  for (const message of warningMessages(initial.warnings)) toast(message);
  writeUrl(true, 0);
  dispatch();

  window.addEventListener('popstate', () => {
    const next = parseUrl(location.search, { latest });
    if (serialise(next.state, { latest }) === serialise(view.state, { latest })) return;
    for (const message of warningMessages(next.warnings)) toast(message);
    view.state = next.state;
    dispatch();
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#methods') scrollTo('methods');
  });

  const mounted = await Promise.all(SECTIONS.map(async ([id, load]) => {
    const root = document.querySelector(`#${id} [data-mount]`);
    let module;
    try {
      module = await load();
    } catch {
      root.replaceChildren(note('note placeholder', '本节内容准备中'));
      return null; // module not built yet: quiet placeholder
    }
    try {
      const instance = module.mount(root, api);
      return { root, render: (snapshot) => instance.render(snapshot) };
    } catch (err) {
      flagError(root, '本节加载出错，请刷新页面');
      globalThis.reportError?.(err);
      return null;
    }
  }));
  sections.push(...mounted.filter(Boolean));
  render();

  const hash = location.hash.slice(1);
  if (SECTIONS.some(([id]) => id === hash)) requestAnimationFrame(() => scrollTo(hash));
}

main().catch((err) => {
  const message = `页面加载失败（${err?.message ?? err}），请刷新重试`;
  for (const root of document.querySelectorAll('[data-mount]')) root.replaceChildren(note('is-error', message));
  toast(message, { duration: 0 });
  globalThis.reportError?.(err);
});
