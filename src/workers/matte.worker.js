// Matte worker: runs neural inference + refine stack off the UI thread.
import * as ort from 'onnxruntime-web/webgpu';
import { MattePipeline } from '../engine/matte-pipeline.js';
import { connectRemote } from '../engine/remote-ort.js';

let pipe = null;
let backdrop = null;          // { bitmap, cache: Map<"wxh", Uint8ClampedArray> }
let canvas = null, ctx = null;

function surface(w, h) {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return ctx;
}

function backdropFor(w, h) {
  if (!backdrop) return null;
  const k = `${w}x${h}`;
  if (!backdrop.cache.has(k)) {
    const c = new OffscreenCanvas(w, h).getContext('2d');
    // Cover-fit the image into the frame.
    const s = Math.max(w / backdrop.bitmap.width, h / backdrop.bitmap.height);
    const bw = backdrop.bitmap.width * s, bh = backdrop.bitmap.height * s;
    c.drawImage(backdrop.bitmap, (w - bw) / 2, (h - bh) / 2, bw, bh);
    backdrop.cache.set(k, c.getImageData(0, 0, w, h).data);
  }
  return backdrop.cache.get(k);
}

self.onmessage = async ({ data: m }) => {
  try {
    switch (m.type) {
      case 'init': {
        ort.env.wasm.wasmPaths = m.wasmBase;
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(m.threads ?? 4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
        ort.env.logLevel = 'error';
        pipe = new MattePipeline({
          ort,
          remote: m.inferPort ? connectRemote(m.inferPort) : null,
          preferGpu: m.preferGpu !== false,
          loadBytes: async (file) => {
            const r = await fetch(m.modelBase + file);
            if (!r.ok) throw new Error(`Model ${file} missing (HTTP ${r.status})`);
            return new Uint8Array(await r.arrayBuffer());
          },
        });
        self.postMessage({ type: 'ready', gpu: !!self.navigator?.gpu, threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated });
        break;
      }
      case 'warmup': {
        const backend = await pipe.warmup(m.engine);
        self.postMessage({ type: 'warm', engine: m.engine, backend, gpuRejected: !!pipe.gpuRejected, gpuCheck: pipe.gpuCheck });
        break;
      }
      case 'reset':
        pipe.reset();
        break;
      case 'backdrop':
        backdrop = m.bitmap ? { bitmap: m.bitmap, cache: new Map() } : null;
        break;
      case 'frame': {
        const { id, w, h } = m;
        let rgba;
        if (m.bitmap) {
          const c = surface(w, h);
          c.drawImage(m.bitmap, 0, 0, w, h);
          m.bitmap.close();
          rgba = c.getImageData(0, 0, w, h).data;
        } else {
          rgba = new Uint8ClampedArray(m.rgba);
        }
        const r = await pipe.process(rgba, w, h, m.params, {
          t: m.t, strokes: m.strokes || [], backdropImage: backdropFor(w, h), forExport: m.mode === 'export',
        });
        if (m.mode === 'export') {
          self.postMessage({ type: 'frame', id, rgba: r.rgba.buffer, stats: r.stats }, [r.rgba.buffer]);
        } else {
          const c = surface(w, h);
          c.putImageData(new ImageData(r.rgba, w, h), 0, 0);
          const bitmap = canvas.transferToImageBitmap();
          self.postMessage({ type: 'frame', id, bitmap, stats: r.stats }, [bitmap]);
        }
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
  }
};
