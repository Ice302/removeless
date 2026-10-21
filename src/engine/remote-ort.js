// Client for the native inference host (electron/infer.cjs) with an onnxruntime-like
// surface, so MattePipeline can use it in place of onnxruntime-web sessions.
class RemoteTensor {
  constructor(port, { data, dims, type, handle }) {
    this.port = port;
    this.data = data ?? null;
    this.dims = dims;
    this.type = type;
    this.handle = handle ?? null;
    this.location = handle ? 'remote' : 'cpu';
  }

  async getData() {
    if (this.data) return this.data;
    const r = await this.port.call({ op: 'fetch', handle: this.handle });
    this.data = r.data;
    return this.data;
  }

  dispose() {
    if (this.handle) this.port.send({ op: 'release', handles: [this.handle] });
    this.handle = null;
  }
}

export function connectRemote(port) {
  let nextId = 1;
  const pending = new Map();
  port.onmessage = ({ data: m }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  };
  const rpc = {
    call: (msg, timeoutMs = 0) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`native host did not answer ${msg.op}`)); }, timeoutMs) : 0;
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      port.postMessage({ ...msg, id });
    }),
    send: (msg) => port.postMessage(msg),
  };

  const serialize = (t) => (t instanceof RemoteTensor && t.handle
    ? { handle: t.handle }
    : { type: t.type, data: t.data ?? t.cpuData, dims: t.dims });

  return {
    async createSession(file, { keep = [] } = {}) {
      const { session, inputNames, outputNames } = await rpc.call({ op: 'create', file, keep }, 30000);
      return {
        inputNames,
        outputNames,
        async run(feeds) {
          const wire = {};
          for (const [k, v] of Object.entries(feeds)) wire[k] = serialize(v);
          const out = await rpc.call({ op: 'run', session, feeds: wire });
          const res = {};
          for (const [k, v] of Object.entries(out)) res[k] = new RemoteTensor(rpc, v);
          return res;
        },
        release() {},
      };
    },
  };
}
