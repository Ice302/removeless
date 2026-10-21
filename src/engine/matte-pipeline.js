// Frame-by-frame matte pipeline. Owns the neural sessions and all temporal state.
// Environment-agnostic: `ort` (onnxruntime-web) and `loadBytes(file)` are injected so the
// same code runs in the app's worker and in the Node quality test.
import {
  scratch, clamp01, rgbaToTensor, resizePlane, guidedFilterColor, shiftEdge, gaussianBlur,
  levels, estimateKeyColor, colorDifferenceKey, reduceChatter, lumaOf, estimateForeground,
  spillChannel, rasterizeHints, subjectStats, parseHex, blurredFrame,
} from './matte-core.js';

export const MATTE_DEFAULTS = {
  engine: 'rvm',          // 'rvm' | 'modnet' | 'chroma' | 'off'
  quality: 'balanced',    // 'draft' | 'balanced' | 'high'
  threshold: 50,          // 0..100, 50 = neutral
  contrast: 0,            // 0..100
  shiftEdge: 0,           // −100..100 (choke ↔ spread)
  snap: 60,               // 0..100 guided-filter edge snap
  feather: 10,            // 0..100
  chatter: 50,            // 0..100 temporal smoothing
  decontam: 70,           // 0..100
  despill: 60,            // 0..100
  keyColor: null,         // [r,g,b] for chroma engine, null = auto from border
  keyBalance: 50,         // 0..100
  backdrop: 'transparent',// 'transparent' | 'color' | 'blur' | 'image'
  backdropColor: '#C0C4CA',
  backdropBlur: 40,
  view: 'composite',      // 'composite' | 'alpha' | 'overlay' | 'split' | 'contour' | 'raw'
  splitPos: 0.5,
  strokeSpan: 1.5,        // seconds a stroke stays active either side (Infinity = whole clip)
  trackStrokes: true,
};

export const MODELS = {
  rvm: { file: 'rvm_mobilenetv3_fp32.onnx', label: 'Roto Neural', temporal: true },
  modnet: { file: { webgpu: 'modnet_fp16.onnx', wasm: 'modnet_quant.onnx', native: 'modnet_fp32.onnx' }, label: 'Portrait' },
};

const QUALITY = {
  // RVM: target size of the internally downsampled pass. MODNet: short-side input size.
  draft: { rvm: 256, modnet: 320, maxIn: 1280 },
  balanced: { rvm: 384, modnet: 512, maxIn: 1920 },
  high: { rvm: 512, modnet: 640, maxIn: 2560 },
};

export class MattePipeline {
  // `remote` (desktop): native onnxruntime-node host; preferred over onnxruntime-web.
  constructor({ ort, loadBytes, preferGpu = true, remote = null }) {
    this.ort = ort;
    this.remote = remote;
    this.loadBytes = loadBytes;
    this.preferGpu = preferGpu;
    this.sessions = {};
    this.backend = null;
    this.reset();
  }

  reset() {
    this.disposeRec();
    this.prevAlpha = null;
    this.prevLuma = null;
    this.lastT = null;
    this.keyAuto = null;
  }

  // One shared creation promise per model, so concurrent callers (warmup + first frame)
  // never race to create two WebGPU sessions.
  session(name) {
    this.sessions[name] ||= this.createSession(name).catch((e) => { delete this.sessions[name]; throw e; });
    return this.sessions[name];
  }

  async createSession(name) {
    const spec = MODELS[name];
    if (this.remote) {
      try {
        const file = typeof spec.file === 'string' ? spec.file : spec.file.native;
        // RVM's recurrent outputs stay in the host process between frames.
        const s = await this.remote.createSession(file, { keep: name === 'rvm' ? ['r1o', 'r2o', 'r3o', 'r4o'] : [] });
        this.backend = 'native';
        return { s, ep: 'native' };
      } catch (e) {
        console.warn(`[matte] native inference unavailable (${e.message}); using onnxruntime-web`);
        this.remote = null;
      }
    }
    const tryCreate = async (ep, layout) => {
      const file = typeof spec.file === 'string' ? spec.file : spec.file[ep];
      const bytes = await this.loadBytes(file);
      const opts = {
        executionProviders: [ep === 'webgpu' && layout ? { name: 'webgpu', preferredLayout: layout } : ep],
        graphOptimizationLevel: 'all',
      };
      const s = await this.ort.InferenceSession.create(bytes, opts);
      return { s, ep, layout };
    };
    const cpu = await tryCreate('wasm');
    if (this.preferGpu && typeof navigator !== 'undefined' && navigator.gpu) {
      // Some GPU/driver/ORT combinations return wrong numbers from the WebGPU EP. Each
      // layout must match the CPU on a high-frequency test frame before we use it; every
      // real resolution is verified again on first use (see verifyConfig).
      for (const layout of ['NHWC', 'NCHW']) {
        let gpu;
        try {
          gpu = await tryCreate('webgpu', layout);
          const diff = await this.compareSessions(name, gpu.s, cpu.s, null, 256, 160, 0.5);
          this.gpuCheck = { ...this.gpuCheck, [`${name}:${layout}`]: Number(diff.toExponential(2)) };
          if (diff < 0.01) {
            this.backend = 'webgpu';
            return { ...gpu, cpu: cpu.s, verified: new Map() };
          }
          console.warn(`[matte] WebGPU ${layout} differs from CPU for ${name} (mean |Δ| = ${diff.toFixed(3)}), rejecting`);
          gpu.s.release?.();
        } catch (e) {
          console.warn(`[matte] WebGPU ${layout} unavailable for ${name}: ${e.message}`);
          gpu?.s.release?.();
        }
      }
      this.gpuRejected = true;
    }
    this.backend = 'wasm';
    return cpu;
  }

  // Picks a model input configuration the GPU computes correctly for this frame size.
  // Returns { session, dr } — falling back to the CPU session if no candidate verifies.
  async verifyConfig(name, sess, frame, iw, ih, baseDr) {
    if (sess.ep !== 'webgpu') return { session: sess.s, dr: baseDr };
    const candidates = name === 'rvm'
      ? [baseDr, baseDr * 1.33, baseDr * 0.75, baseDr * 1.15, baseDr * 0.87, baseDr * 1.5].map((d) => Math.min(1, Math.round(d * 1e4) / 1e4))
      : [baseDr];
    for (const dr of candidates) {
      const key = `${iw}x${ih}@${dr}`;
      if (!sess.verified.has(key)) {
        const t0 = performance.now();
        const dNoise = await this.compareSessions(name, sess.s, sess.cpu, null, iw, ih, dr);
        const dReal = dNoise < 0.01 ? await this.compareSessions(name, sess.s, sess.cpu, frame, iw, ih, dr) : 1;
        const ok = Math.max(dNoise, dReal) < 0.01;
        sess.verified.set(key, ok);
        console.info(`[matte] GPU verify ${name} ${key}: noise ${dNoise.toExponential(2)}, frame ${dReal === 1 ? 'skipped' : dReal.toExponential(2)} → ${ok ? 'OK' : 'reject'} (${Math.round(performance.now() - t0)} ms)`);
      }
      if (sess.verified.get(key)) { this.backend = 'webgpu'; return { session: sess.s, dr }; }
    }
    this.backend = 'wasm';
    this.gpuRejected = true;
    return { session: sess.cpu, dr: baseDr };
  }

  // Mean absolute difference between two sessions' outputs on a synthetic portrait-ish frame.
  async compareSessions(name, a, b, frame, w, h, dr) {
    const ort = this.ort;
    // High-frequency test frame (hash noise + a subject shape): flat synthetic images hide
    // convolution indexing bugs, which is exactly the failure mode seen on some GPUs.
    const rgba = new Uint8ClampedArray(w * h * 4);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cx = (x / w - 0.5) * 2, cy = (y / h - 0.35) * 2;
        const fg = cx * cx / 0.12 + cy * cy / 0.2 < 1 || (Math.abs(cx) < 0.25 + (cy - 0.4) * 0.5 && cy > 0.4);
        const n = rnd() * 90;
        rgba[i] = (fg ? 170 : 50) + n * (fg ? 0.6 : 1) + 30 * Math.sin(x * 0.7);
        rgba[i + 1] = (fg ? 120 : 140) + n * 0.8 + 25 * Math.cos(y * 0.9);
        rgba[i + 2] = (fg ? 100 : 90) + rnd() * 80;
        rgba[i + 3] = 255;
      }
    }
    // RVM is recurrent: run three frames feeding each session's own state back in, exactly
    // like real playback — single-frame checks miss bugs in the stateful kernels.
    const img = frame || { rgba, w, h };
    const src = () => name === 'rvm'
      ? new ort.Tensor('float32', rgbaToTensor(img.rgba, img.w, img.h, w, h), [1, 3, h, w])
      : new ort.Tensor('float32', rgbaToTensor(img.rgba, img.w, img.h, w, h, 2 / 255, -1), [1, 3, h, w]);
    const runSeq = async (sess) => {
      if (name !== 'rvm') return sess.run({ input: src() });
      const z = () => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
      let rec = [z(), z(), z(), z()], out;
      for (let f = 0; f < 3; f++) {
        out = await sess.run({
          src: src(), r1i: rec[0], r2i: rec[1], r3i: rec[2], r4i: rec[3],
          downsample_ratio: new ort.Tensor('float32', new Float32Array([dr]), [1]),
        });
        const prev = rec;
        rec = [out.r1o, out.r2o, out.r3o, out.r4o];
        if (f > 0) prev.forEach((t) => t.dispose?.());
      }
      rec.forEach((t) => t.dispose?.());
      return out;
    };
    const keys = name === 'rvm' ? ['pha', 'fgr'] : ['output'];
    const [ra, rb] = [await runSeq(a), await runSeq(b)];
    let sum = 0, n = 0;
    for (const k of keys) {
      const da = await ra[k].getData(), db = await rb[k].getData();
      for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); sum += Number.isFinite(d) ? d : 1; n++; }
      ra[k].dispose?.(); rb[k].dispose?.();
    }
    return sum / n;
  }

  disposeRec() {
    for (const t of this.rec || []) t.dispose?.();
    this.rec = null;
  }

  async warmup(engine) {
    if (MODELS[engine]) await this.session(engine);
    return this.backend;
  }

  /* ───────── neural engines ───────── */

  async runRvm(rgba, w, h, q) {
    const sess = await this.session('rvm');
    const ort = this.ort;
    // Feed at most maxIn on the long side; RVM's refiner upsamples to the input size.
    const scale = Math.min(1, q.maxIn / Math.max(w, h));
    const iw = Math.max(2, Math.round(w * scale)), ih = Math.max(2, Math.round(h * scale));
    const { session, dr } = await this.verifyConfig('rvm', sess, { rgba, w, h }, iw, ih, Math.min(1, q.rvm / Math.max(iw, ih)));
    if (session !== this.recSession) { this.disposeRec(); this.recSession = session; }
    const src = new ort.Tensor('float32', rgbaToTensor(rgba, w, h, iw, ih), [1, 3, ih, iw]);
    if (!this.rec) {
      const z = () => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
      this.rec = [z(), z(), z(), z()];
    }
    const out = await session.run({
      src, r1i: this.rec[0], r2i: this.rec[1], r3i: this.rec[2], r4i: this.rec[3],
      downsample_ratio: new ort.Tensor('float32', new Float32Array([dr]), [1]),
    });
    const prev = this.rec;
    this.rec = [out.r1o, out.r2o, out.r3o, out.r4o];
    for (const t of prev) t.dispose?.();
    const pha = await out.pha.getData();
    const fgr = await out.fgr.getData();
    let alpha, fg = null;
    if (iw === w && ih === h) {
      alpha = Float32Array.from(pha);
      fg = fgr;
    } else {
      alpha = resizePlane(pha, iw, ih, w, h);
    }
    src.dispose?.(); out.pha.dispose?.(); out.fgr.dispose?.();
    return { alpha, fg };
  }

  async runModnet(rgba, w, h, q) {
    const sess = await this.session('modnet');
    const ort = this.ort;
    const short = Math.min(w, h), k = q.modnet / short;
    const mw = Math.max(32, Math.round((w * k) / 32) * 32), mh = Math.max(32, Math.round((h * k) / 32) * 32);
    const { session: s } = await this.verifyConfig('modnet', sess, { rgba, w, h }, mw, mh, 1);
    const input = new ort.Tensor('float32', rgbaToTensor(rgba, w, h, mw, mh, 2 / 255, -1), [1, 3, mh, mw]);
    const out = await s.run({ input });
    const m = await out.output.getData();
    const alpha = resizePlane(m, mw, mh, w, h);
    input.dispose?.(); out.output.dispose?.();
    return { alpha, fg: null };
  }

  /* ───────── main entry ───────── */

  // rgba: Uint8ClampedArray (w*h*4). Returns { rgba: Uint8ClampedArray, alpha, stats }.
  async process(rgba, w, h, params, { t = 0, strokes = [], backdropImage = null, forExport = false } = {}) {
    const P = { ...MATTE_DEFAULTS, ...params };
    const q = QUALITY[P.quality] || QUALITY.balanced;
    const n = w * h;
    const t0 = performance.now();

    // Temporal state is only valid for consecutive frames of the same size.
    const jumped = this.lastT === null || Math.abs(t - this.lastT) > 0.25 || t < this.lastT;
    if (jumped || (this.prevAlpha && this.prevAlpha.length !== n) || this.engine !== P.engine) {
      this.disposeRec(); this.prevAlpha = null; this.prevLuma = null;
    }
    this.engine = P.engine;
    this.lastT = t;

    // 1. Raw matte.
    let alpha, fg = null;
    if (P.engine === 'rvm') ({ alpha, fg } = await this.runRvm(rgba, w, h, q));
    else if (P.engine === 'modnet') ({ alpha } = await this.runModnet(rgba, w, h, q));
    else if (P.engine === 'chroma') {
      const key = P.keyColor || (this.keyAuto ||= estimateKeyColor(rgba, w, h));
      alpha = colorDifferenceKey(rgba, w, h, key, P.keyBalance / 100);
    } else {
      alpha = new Float32Array(n).fill(1);
    }
    const tInfer = performance.now() - t0;

    // 2. Tracked hint strokes (before refinement, so edge snap pulls them onto real edges).
    const subject = subjectStats(alpha, w, h);
    if (strokes.length) {
      const fgM = scratch('hint.fg', n), bgM = scratch('hint.bg', n);
      if (rasterizeHints(strokes, t, w, h, P.trackStrokes, P.strokeSpan, subject, fgM, bgM)) {
        for (let i = 0; i < n; i++) {
          let a = alpha[i];
          if (fgM[i] > a) a = fgM[i];
          alpha[i] = a * (1 - bgM[i]);
        }
      }
    }

    // 3. Refine edge stack.
    const res = h / 1080; // all pixel radii are specified at 1080p and scaled
    if (P.snap > 0 && P.engine !== 'off') {
      const r = Math.max(2, Math.round(8 * res * (0.5 + P.snap / 100)));
      // Fast guided filter: coefficients at reduced resolution (He & Sun 2015) — ~3× faster
      // at 540p with no visible loss, since a/b are smooth by construction.
      const s = Math.max(2, Math.round(Math.min(w, h) / 270));
      const ref = guidedFilterColor(rgba, alpha, w, h, r, 1e-4 + (1 - P.snap / 100) * 4e-3, s, scratch('gf.out', n));
      const mix = P.snap / 100;
      for (let i = 0; i < n; i++) alpha[i] = alpha[i] + (ref[i] - alpha[i]) * mix;
    }
    levels(alpha, P.threshold, P.contrast);
    if (P.shiftEdge !== 0) {
      const sh = shiftEdge(alpha, w, h, (P.shiftEdge / 100) * 12 * res, scratch('shift.out', n));
      alpha.set(sh);
    }
    if (P.feather > 0) {
      const fb = gaussianBlur(alpha, w, h, (P.feather / 100) * 6 * res, scratch('feather.out', n));
      alpha.set(fb);
    }
    const luma = lumaOf(rgba, new Float32Array(n));
    if (P.chatter > 0 && this.prevAlpha && this.prevLuma) {
      reduceChatter(alpha, this.prevAlpha, luma, this.prevLuma, P.chatter);
    }
    this.prevAlpha = Float32Array.from(alpha);
    this.prevLuma = luma;

    // 4. Colour: decontaminate edges, then despill.
    const out = new Uint8ClampedArray(n * 4);
    const color = scratch('fgcolor', n * 3);
    if (P.decontam > 0 && P.engine !== 'off') {
      if (fg) {
        for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) color[i * 3 + c] = fg[c * n + i] * 255;
      } else {
        estimateForeground(rgba, alpha, w, h, color);
      }
      const m = P.decontam / 100;
      for (let i = 0; i < n; i++) {
        // Only edges need decontamination; solid interior keeps original pixels.
        const edge = alpha[i] < 0.995 ? m : m * 0.15;
        for (let c = 0; c < 3; c++) {
          const I = rgba[i * 4 + c];
          color[i * 3 + c] = I + (color[i * 3 + c] - I) * edge;
        }
      }
    } else {
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) color[i * 3 + c] = rgba[i * 4 + c];
    }
    let spill = -1;
    if (P.despill > 0) {
      spill = P.engine === 'chroma'
        ? (P.keyColor || this.keyAuto || [0, 255, 0]).indexOf(Math.max(...(P.keyColor || this.keyAuto || [0, 255, 0])))
        : spillChannel(rgba, alpha, w, h);
      if (spill >= 0) {
        const d = P.despill / 100, o1 = (spill + 1) % 3, o2 = (spill + 2) % 3;
        for (let i = 0; i < n; i++) {
          const k = i * 3, lim = (color[k + o1] + color[k + o2]) / 2;
          if (color[k + spill] > lim) color[k + spill] -= (color[k + spill] - lim) * d;
        }
      }
    }

    // 5. Compose output.
    const view = forExport ? (P.exportView || 'composite') : P.view;
    this.compose(out, rgba, color, alpha, w, h, P, view, backdropImage);

    let cover = 0;
    for (let i = 0; i < n; i += 13) cover += alpha[i];
    return {
      rgba: out,
      alpha,
      stats: {
        backend: P.engine === 'chroma' ? 'cpu' : this.backend,
        inferMs: tInfer,
        totalMs: performance.now() - t0,
        coverage: cover / Math.ceil(n / 13),
        subject,
        spill,
        key: P.engine === 'chroma' ? (P.keyColor || this.keyAuto) : null,
      },
    };
  }

  compose(out, rgba, color, alpha, w, h, P, view, backdropImage) {
    const n = w * h;
    if (view === 'raw') { out.set(rgba); return; }
    if (view === 'alpha') {
      for (let i = 0; i < n; i++) {
        const v = alpha[i] * 255;
        out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
      }
      return;
    }
    if (view === 'overlay') {
      // Roto-Brush-style review: magenta wash outside, bright outline on the 50 % edge.
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x, a = alpha[i];
          const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
          const inside = a > 0.5;
          const edge = x > 0 && y > 0 && x < w - 1 && y < h - 1 &&
            ((alpha[i - 1] > 0.5) !== inside || (alpha[i + 1] > 0.5) !== inside ||
             (alpha[i - w] > 0.5) !== inside || (alpha[i + w] > 0.5) !== inside);
          if (edge) { out[i * 4] = 255; out[i * 4 + 1] = 40; out[i * 4 + 2] = 200; }
          else {
            const k = (1 - a) * 0.55;
            out[i * 4] = r + (230 - r) * k; out[i * 4 + 1] = g + (30 - g) * k; out[i * 4 + 2] = b + (150 - b) * k;
          }
          out[i * 4 + 3] = 255;
        }
      }
      return;
    }
    if (view === 'contour') {
      // Poster look: ink silhouette, stepped electric-blue contour on paper.
      const B = Math.max(3, Math.round(h / 80));
      const at = (x, y) => alpha[Math.min(h - 1, y) * w + Math.min(w - 1, x)] > 0.5;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bx = x - (x % B), by = y - (y % B), i = y * w + x;
          const inside = at(bx, by);
          const edge = (bx >= B && at(bx - B, by) !== inside) || at(bx + B, by) !== inside ||
                       (by >= B && at(bx, by - B) !== inside) || at(bx, by + B) !== inside;
          let c;
          if (edge) c = [0, 56, 255];
          else if (inside) {
            const l = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
            c = l > 190 ? [244, 244, 240] : [13, 15, 18];
          } else c = [244, 244, 240];
          out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
        }
      }
      return;
    }

    // Composite (optionally split against the raw frame).
    let bg = null, solid = null;
    if (P.backdrop === 'color') solid = parseHex(P.backdropColor);
    else if (P.backdrop === 'blur') bg = blurredFrame(rgba, w, h, (P.backdropBlur / 100) * 60 * (h / 1080) + 2, scratch('backdrop.blur', n * 4, Uint8ClampedArray));
    else if (P.backdrop === 'image' && backdropImage && backdropImage.length === n * 4) bg = backdropImage;
    const splitX = view === 'split' ? Math.round(P.splitPos * w) : -1;

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (splitX >= 0 && (i % w) < splitX) {
        out[o] = rgba[o]; out[o + 1] = rgba[o + 1]; out[o + 2] = rgba[o + 2]; out[o + 3] = 255;
        continue;
      }
      const a = alpha[i], k = i * 3;
      if (solid || bg) {
        const br = solid ? solid[0] : bg[o], bgc = solid ? solid[1] : bg[o + 1], bb = solid ? solid[2] : bg[o + 2];
        out[o] = color[k] * a + br * (1 - a);
        out[o + 1] = color[k + 1] * a + bgc * (1 - a);
        out[o + 2] = color[k + 2] * a + bb * (1 - a);
        out[o + 3] = 255;
      } else {
        out[o] = color[k]; out[o + 1] = color[k + 1]; out[o + 2] = color[k + 2];
        out[o + 3] = clamp01(a) * 255;
      }
    }
  }
}
