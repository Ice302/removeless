// Native inference host, run as an Electron utilityProcess. The renderer's matte worker
// talks to it over a dedicated MessagePort (frames never pass through the main process).
//
// Protocol (request → response, matched by `id`):
//   { op: 'create', file, keep: [outputNames] }   → { session, inputNames, outputNames }
//   { op: 'run', session, feeds }                 → { [output]: { data, dims, type } | { handle, dims, type } }
//   { op: 'fetch', handle }                       → { data, dims, type }
//   { op: 'release', handles }                    (no response)
// Feeds are { type, data, dims } or { handle } for tensors kept here between calls — used
// for RVM's recurrent state so it never round-trips through the renderer.
const path = require('node:path');

// onnxruntime-node has no build for every platform (e.g. Intel macOS). Report the failure
// per request so the renderer falls back to onnxruntime-web instead of hanging.
let ort = null, loadError = null;
try {
  if (process.env.REMOVELESS_NO_NATIVE) throw new Error('disabled by REMOVELESS_NO_NATIVE');
  ort = require('onnxruntime-node');
} catch (e) { loadError = e; }

let modelDir = null;
const sessions = new Map();
const handles = new Map();
let nextSession = 1;
let nextHandle = 1;

const plain = (t) => {
  const d = t.data;
  // Hand back a compact copy: native output buffers may be views over larger allocations.
  const data = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d : d.slice();
  return { data, dims: t.dims, type: t.type };
};

async function handle(port, m) {
  try {
    if (!ort) throw new Error(`native runtime unavailable: ${loadError?.message}`);
    switch (m.op) {
      case 'create': {
        const file = path.join(modelDir, path.basename(m.file)); // never outside the model dir
        const s = await ort.InferenceSession.create(file, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
          intraOpNumThreads: m.threads || 0,
        });
        const id = nextSession++;
        sessions.set(id, { s, keep: new Set(m.keep || []) });
        return port.postMessage({ id: m.id, result: { session: id, inputNames: s.inputNames, outputNames: s.outputNames } });
      }
      case 'run': {
        const entry = sessions.get(m.session);
        if (!entry) throw new Error('session not found');
        const feeds = {};
        for (const [k, v] of Object.entries(m.feeds)) {
          if (v.handle) {
            const t = handles.get(v.handle);
            if (!t) throw new Error(`tensor handle ${v.handle} was released`);
            feeds[k] = t;
          } else {
            feeds[k] = new ort.Tensor(v.type, v.data, v.dims);
          }
        }
        const out = await entry.s.run(feeds);
        const result = {};
        for (const [k, t] of Object.entries(out)) {
          if (entry.keep.has(k)) {
            const h = nextHandle++;
            handles.set(h, t);
            result[k] = { handle: h, dims: t.dims, type: t.type };
          } else {
            result[k] = plain(t);
          }
        }
        return port.postMessage({ id: m.id, result });
      }
      case 'fetch': {
        const t = handles.get(m.handle);
        if (!t) throw new Error('tensor handle not found');
        return port.postMessage({ id: m.id, result: plain(t) });
      }
      case 'release':
        for (const h of m.handles || []) handles.delete(h);
        return;
      default:
        throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    port.postMessage({ id: m.id, error: e?.message || String(e) });
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data;
  if (msg.type === 'init') modelDir = msg.modelDir;
  if (msg.type === 'port') {
    const port = e.ports[0];
    port.on('message', (ev) => handle(port, ev.data));
    port.start();
  }
});
