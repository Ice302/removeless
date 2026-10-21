// Promise-based clients for the matte and audio workers.
const BASE = new URL(import.meta.env.BASE_URL || './', location.href).href;

// `?gpu=0` forces CPU inference (troubleshooting / safe mode).
const GPU_DEFAULT = new URLSearchParams(location.search).get('gpu') !== '0';

// Desktop: ask the main process for a MessagePort to the native inference host. The preload
// relays it with window.postMessage (ports can't cross contextBridge directly).
const portWaiters = [];
window.addEventListener('message', (e) => {
  if (e.source === window && e.data === 'removeless:infer-port' && e.ports[0]) portWaiters.shift()?.(e.ports[0]);
});
function inferencePort() {
  if (!window.native?.connectInference) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    portWaiters.push((p) => { clearTimeout(timer); resolve(p); });
    window.native.connectInference();
  });
}

export class MatteClient {
  constructor({ preferGpu = GPU_DEFAULT, threads = 4 } = {}) {
    this.worker = new Worker(new URL('./matte.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'ready') return resolve(m);
        if (m.type === 'warm') {
          this.gpuRejected = m.gpuRejected;
          if (m.gpuCheck) console.info('[matte] GPU check', JSON.stringify(m.gpuCheck));
          m = { ...m, id: `warm:${m.engine}`, value: m.backend };
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m.type === 'warm' ? m.value : m);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Matte worker failed to start'));
    });
    inferencePort().then((inferPort) => {
      const init = { type: 'init', modelBase: `${BASE}models/`, wasmBase: `${BASE}ort/`, preferGpu, threads, inferPort };
      this.worker.postMessage(init, inferPort ? [inferPort] : []);
    });
  }

  // Loads the model for `engine`; resolves with the backend actually used (webgpu | wasm).
  // Rejects after `timeoutMs` so callers can fall back (e.g. to single-threaded WASM).
  warmup(engine, timeoutMs = 0) {
    const id = `warm:${engine}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error('warmup timed out')); }, timeoutMs) : 0;
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.worker.postMessage({ type: 'warmup', engine, id });
    });
  }

  frame(msg, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'frame', id, ...msg }, transfer);
    });
  }

  reset() { this.worker.postMessage({ type: 'reset' }); }
  setBackdrop(bitmap) { this.worker.postMessage({ type: 'backdrop', bitmap }, bitmap ? [bitmap] : []); }
  terminate() { this.worker.terminate(); }
}

export class AudioClient {
  constructor() {
    this.worker = new Worker(new URL('./audio.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onProgress = null;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'ready') return resolve(m);
        if (m.type === 'progress') return this.onProgress?.(m);
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Audio worker failed to start'));
    });
    this.worker.postMessage({ type: 'init' });
  }

  call(type, payload = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...payload }, transfer);
    });
  }

  setSource(channels) {
    const copies = channels.map((c) => c.slice().buffer);
    return this.call('source', { channels: copies }, copies);
  }

  // Only the newest request resolves; older ones are dropped by the worker.
  process(params) {
    for (const [id, p] of this.pending) { if (p.kind === 'process') { p.resolve(null); this.pending.delete(id); } }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, kind: 'process' });
      this.worker.postMessage({ type: 'process', id, params });
    });
  }

  wav(params, start, end, bitDepth = 24) { return this.call('wav', { params, start, end, bitDepth }); }
}
