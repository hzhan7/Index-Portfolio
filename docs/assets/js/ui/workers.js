// Compute client (§2.10 / §3.6): a compute worker (context/sample/alloc) and a robust worker,
// per-kind latest-wins, robust terminate + respawn, and an in-thread fallback via engine/jobs.js.
const READY_TIMEOUT_MS = 3000;
const CHANNEL_OF = { context: 'compute', sample: 'compute', alloc: 'compute', robust: 'robust' };

export const COMPUTE_ERRORS = {
  E_WORKER: '后台计算出错，请刷新页面重试',
  E_ENGINE_LOAD: '计算模块加载失败，请刷新页面重试',
  E_INTERNAL: '计算出错，请调整设置后重试',
};

function spawnWorker(channel) {
  return channel === 'robust'
    ? new Worker(new URL('../robust.worker.js?v=20260912', import.meta.url), { type: 'module' })
    : new Worker(new URL('../compute.worker.js?v=20260912', import.meta.url), { type: 'module' });
}

const importJobs = () => import('../engine/jobs.js?v=20260912');
const nextTask = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * request(kind, state, {key}) keeps at most one in-flight job per kind; a newer request replaces the
 * queued one and the superseded result is dropped. Callbacks receive {id, kind, key, result} /
 * {id, kind, stage, done, total} / {id, kind, code, message}. spawn/loadJobs/readyTimeout are injectable for tests.
 */
export function createCompute({
  history, valuation,
  onResult = () => {}, onProgress = () => {}, onError = () => {},
  spawn = spawnWorker, loadJobs = importJobs, readyTimeout = READY_TIMEOUT_MS,
} = {}) {
  const data = { history, valuation };
  const channels = { compute: newChannel('compute'), robust: newChannel('robust') };
  let seq = 0;
  let jobs = null;

  function newChannel(name) {
    return { name, worker: null, ready: null, thread: false, inflight: new Map(), queued: new Map() };
  }

  function boot(ch) {
    if (ch.thread) return Promise.resolve(false);
    if (ch.ready) return ch.ready;
    const attempt = new Promise((resolve) => {
      let worker;
      try {
        worker = spawn(ch.name);
      } catch {
        resolve(false);
        return;
      }
      let isReady = false;
      const timer = setTimeout(() => resolve(false), readyTimeout);
      ch.worker = worker;
      worker.onmessage = ({ data: msg }) => {
        if (ch.worker !== worker) return;
        if (msg?.type !== 'ready') {
          receive(ch, msg);
          return;
        }
        isReady = true;
        clearTimeout(timer);
        resolve(true);
      };
      worker.onerror = (event) => {
        event?.preventDefault?.();
        if (ch.worker !== worker) return;
        if (isReady) {
          crash(ch);
        } else {
          clearTimeout(timer);
          resolve(false);
        }
      };
      worker.onmessageerror = worker.onerror;
      try {
        worker.postMessage({ type: 'init', ...data });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    }).then((ok) => {
      if (!ok && ch.ready === attempt) toThread(ch);
      return ok;
    });
    ch.ready = attempt;
    return attempt;
  }

  function toThread(ch) {
    ch.thread = true;
    ch.worker?.terminate();
    ch.worker = null;
  }

  function restart(ch) {
    ch.worker?.terminate();
    ch.worker = null;
    ch.ready = null;
  }

  function crash(ch) {
    const lost = [...ch.inflight.values(), ...ch.queued.values()];
    restart(ch);
    ch.inflight.clear();
    ch.queued.clear();
    for (const job of lost) onError({ id: job.id, kind: job.kind, code: 'E_WORKER', message: COMPUTE_ERRORS.E_WORKER });
  }

  async function send(ch, job) {
    ch.inflight.set(job.kind, job);
    const ok = await boot(ch);
    if (ch.inflight.get(job.kind) !== job) return;
    if (ok && ch.worker) {
      job.posted = true;
      ch.worker.postMessage({ type: 'job', id: job.id, kind: job.kind, state: job.state });
    } else {
      runInThread(ch, job);
    }
  }

  function receive(ch, msg) {
    const job = msg && ch.inflight.get(msg.kind);
    if (!job || job.id !== msg.id) return;
    if (msg.type === 'progress') {
      onProgress({ id: msg.id, kind: msg.kind, stage: msg.stage, done: msg.done, total: msg.total });
      return;
    }
    if (msg.type !== 'result' && msg.type !== 'error') return;
    ch.inflight.delete(msg.kind);
    const next = ch.queued.get(msg.kind);
    if (next) {
      ch.queued.delete(msg.kind);
      send(ch, next);
    } else if (msg.type === 'result') {
      onResult({ id: msg.id, kind: msg.kind, key: msg.key ?? msg.result?.key, result: msg.result });
    } else {
      onError({ id: msg.id, kind: msg.kind, code: msg.code ?? 'E_INTERNAL', message: msg.message ?? COMPUTE_ERRORS.E_INTERNAL });
    }
  }

  async function runInThread(ch, job) {
    const post = (msg) => receive(ch, { id: job.id, kind: job.kind, ...msg });
    try {
      jobs ??= await loadJobs();
    } catch {
      post({ type: 'error', code: 'E_ENGINE_LOAD', message: COMPUTE_ERRORS.E_ENGINE_LOAD });
      return;
    }
    await nextTask(); // let pending UI paint and newer requests supersede this one first
    if (ch.inflight.get(job.kind) !== job) return;
    job.posted = true;
    try {
      const result = await jobs.handle({ kind: job.kind, state: job.state }, data, {
        onProgress: (p) => post({ type: 'progress', ...p }),
      });
      post({ type: 'result', key: result?.key, result });
    } catch (err) {
      post({ type: 'error', code: err?.code ?? 'E_INTERNAL', message: err?.message || COMPUTE_ERRORS.E_INTERNAL });
    }
  }

  function channelFor(kind) {
    const ch = channels[CHANNEL_OF[kind]];
    if (!ch) throw new Error(`未知计算类型：${kind}`);
    return ch;
  }

  function request(kind, state, { key } = {}) {
    const ch = channelFor(kind);
    const job = { id: (seq += 1), kind, state, key, posted: false };
    const current = ch.inflight.get(kind);
    if (!current || !current.posted) {
      send(ch, job);
    } else if (key !== undefined && current.key === key) {
      ch.queued.delete(kind); // the running job already produces this key
    } else if (ch.name === 'robust' && !ch.thread) {
      restart(ch);
      send(ch, job);
    } else {
      ch.queued.set(kind, job);
    }
    return job.id;
  }

  function cancel(kind) {
    const ch = channelFor(kind);
    ch.queued.delete(kind);
    const current = ch.inflight.get(kind);
    if (!current) return;
    ch.inflight.delete(kind);
    if (ch.name === 'robust' && current.posted && !ch.thread) restart(ch);
  }

  const status = () => Object.fromEntries(Object.values(channels).map((ch) => [
    ch.name, ch.thread ? 'thread' : ch.worker ? 'worker' : 'idle',
  ]));

  boot(channels.compute);
  boot(channels.robust);
  return { request, cancel, status };
}
