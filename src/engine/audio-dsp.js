// Offline voice-isolation chain. Pure functions over Float32Array channels at 48 kHz.
// Shared by the audio worker (app) and the Node test harness, so it must stay DOM-free.
//
// Chain:  high-pass → hum notch comb → RNNoise (neural) → reduction depth → STFT Wiener
//         residual cleanup → VAD voice gate → presence EQ → de-esser → dry/wet →
//         loudness normalisation (BS.1770) → peak limiter

export const SR = 48000;
export const RN_FRAME = 480; // RNNoise frame = 10 ms @ 48 kHz

export const AUDIO_DEFAULTS = {
  reductionDb: 36,     // how deep RNNoise is allowed to cut (0..60, 60 = full)
  cleanup: 55,         // STFT residual cleanup amount 0..100
  gate: 35,            // VAD voice gate depth 0..100 (→ 0..30 dB)
  highpassHz: 80,      // 20..200
  hum: 'auto',         // 'auto' | '50' | '60' | 'off'
  presence: 40,        // 0..100 → 0..+6 dB @ 3.2 kHz
  deEsser: 45,         // 0..100
  mix: 100,            // dry/wet 0..100
  loudness: -16,       // target LUFS, or null for off
};

/* ───────────────────────── biquads (RBJ cookbook) ───────────────────────── */

export function biquad(type, f, Q = Math.SQRT1_2, gainDb = 0, sr = SR) {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default: throw new Error(`unknown biquad ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Transposed direct form II, returns a new array (or writes into `out`).
export function runBiquad(x, c, out = new Float32Array(x.length)) {
  let z1 = 0, z2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + z1;
    z1 = b1 * xi - a1 * y + z2;
    z2 = b2 * xi - a2 * y;
    out[i] = y;
  }
  return out;
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const undb = (d) => Math.pow(10, d / 20);

/* ───────────────────────── stage 1: high-pass + hum ───────────────────────── */

// Goertzel power of a single frequency over a (decimated) excerpt.
function goertzel(x, f, start, len) {
  const k = 2 * Math.cos((2 * Math.PI * f) / SR);
  let s1 = 0, s2 = 0;
  for (let i = start; i < start + len; i++) {
    const s = x[i] + k * s1 - s2;
    s2 = s1; s1 = s;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (len * len);
}

// Detects mains hum by comparing harmonic power against neighbouring bins.
export function detectHum(x) {
  const len = Math.min(x.length, SR * 4);
  if (len < SR) return null;
  const starts = [0, Math.max(0, ((x.length - len) / 2) | 0), Math.max(0, x.length - len)];
  // Prominence (dB above the ±3/±5 Hz neighbourhood) of the strongest of the first
  // three harmonics — real hum is often dominated by its 2nd or 3rd harmonic.
  const prominence = (f) => {
    let s = 0;
    for (const st of starts) {
      const on = goertzel(x, f, st, len);
      const off = [-5, -3, 3, 5].reduce((p, d) => p + goertzel(x, f + d, st, len), 0) / 4;
      s += 10 * Math.log10((on + 1e-20) / (off + 1e-20));
    }
    return s / starts.length;
  };
  const score = (f0) => Math.max(prominence(f0), prominence(2 * f0) - 2, prominence(3 * f0) - 2);
  const s50 = score(50), s60 = score(60);
  const best = s60 >= s50 ? 60 : 50;
  return Math.max(s50, s60) > 8 ? best : null;
}

export function prefilter(x, { highpassHz, hum }) {
  // 4th-order Butterworth high-pass as two cascaded biquads.
  let y = runBiquad(x, biquad('highpass', highpassHz, 0.5412));
  y = runBiquad(y, biquad('highpass', highpassHz, 1.3066), y);
  const f0 = hum === 'off' ? null : hum === 'auto' ? detectHum(x) : Number(hum);
  if (f0) {
    for (let h = 1; h * f0 < 2000; h++) {
      y = runBiquad(y, biquad('notch', h * f0, 18 + h * 4), y);
    }
  }
  return { y, humHz: f0 };
}

/* ───────────────────────── stage 2: RNNoise ───────────────────────── */

// Runs RNNoise frame-by-frame. Returns denoised signal (latency-compensated so it lines
// up sample-accurately with the source, which matters for lip-sync) and per-frame VAD.
export function runRnnoise(rnnoise, x, latency) {
  const st = rnnoise.createDenoiseState();
  const frames = Math.ceil((x.length + latency) / RN_FRAME);
  const raw = new Float32Array(frames * RN_FRAME);
  const vad = new Float32Array(frames);
  const buf = new Float32Array(RN_FRAME);
  try {
    for (let f = 0; f < frames; f++) {
      const off = f * RN_FRAME;
      for (let i = 0; i < RN_FRAME; i++) {
        const v = off + i < x.length ? x[off + i] : 0;
        buf[i] = v * 32768;
      }
      vad[f] = st.processFrame(buf);
      for (let i = 0; i < RN_FRAME; i++) raw[off + i] = buf[i] / 32768;
    }
  } finally {
    st.destroy();
  }
  const y = raw.subarray(latency, latency + x.length).slice();
  return { y, vad };
}

// Measures RNNoise's intrinsic delay once with a chirp so it can be compensated exactly.
export function measureRnnoiseLatency(rnnoise) {
  const n = SR; // 1 s chirp with speech-band energy
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.sin(2 * Math.PI * (150 * t + 900 * t * t)) * Math.sin(Math.PI * t);
  }
  const { y } = runRnnoise(rnnoise, x, 0);
  let best = 0, bestLag = 0;
  for (let lag = 0; lag < 2048; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 2) s += x[i] * y[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  // The true delay is a whole number of frames; the chirp estimate is off by a few samples.
  const snapped = Math.round(bestLag / RN_FRAME) * RN_FRAME;
  return Math.abs(snapped - bestLag) <= 16 ? snapped : bestLag;
}

/* ───────────────────────── FFT (radix-2, in place) ───────────────────────── */

function makeFFT(N) {
  const rev = new Uint32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = -Math.sin((2 * Math.PI * i) / N);
  }
  return function fft(re, im, inverse = false) {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sgn * sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

/* ───────────────────────── stage 3: STFT Wiener residual cleanup ───────────────────────── */

const FFT_N = 1024;
const HOP = 256;

// Decision-directed Wiener filter (Ephraim–Malah style) with a noise PSD learned from
// frames RNNoise's VAD marks as non-speech; falls back to minimum statistics.
export function spectralCleanup(x, vad, amount, onProgress) {
  if (amount <= 0) return x.slice();
  const N = FFT_N, H = HOP, bins = N / 2 + 1;
  const fft = makeFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.ceil((x.length + N) / H);
  const pad = new Float32Array(frames * H + N);
  pad.set(x, N / 2);

  const re = new Float64Array(N), im = new Float64Array(N);
  const pow = new Float32Array(frames * bins);
  const vadAt = (f) => {
    const centre = f * H + N / 2 - N / 2; // sample index in original signal
    const v = vad[Math.min(vad.length - 1, Math.max(0, Math.floor(centre / RN_FRAME)))];
    return v === undefined ? 1 : v;
  };

  // Pass 1: power spectra + noise PSD estimate.
  const noise = new Float64Array(bins);
  let noiseFrames = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * H;
    for (let i = 0; i < N; i++) { re[i] = pad[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) pow[base + k] = re[k] * re[k] + im[k] * im[k];
    if (vadAt(f) < 0.2) {
      for (let k = 0; k < bins; k++) noise[k] += pow[base + k];
      noiseFrames++;
    }
  }
  if (noiseFrames >= 30) {
    for (let k = 0; k < bins; k++) noise[k] /= noiseFrames;
  } else {
    // Minimum statistics fallback: 10th percentile of each bin's power over time.
    const col = new Float32Array(frames);
    for (let k = 0; k < bins; k++) {
      for (let f = 0; f < frames; f++) col[f] = pow[f * bins + k];
      col.sort();
      noise[k] = col[Math.floor(frames * 0.1)] * 1.5;
    }
  }

  // Pass 2: gains + overlap-add.
  const a = amount / 100;
  const overSub = 1 + a * 2.0;
  const gMin = undb(-(6 + a * 24));
  const alphaDD = 0.96;
  const prevG = new Float32Array(bins).fill(1);
  const prevGamma = new Float32Array(bins).fill(1);
  const g = new Float32Array(bins);
  const out = new Float32Array(pad.length);
  const norm = 1 / 2; // sqrt-Hann² summed at 75 % overlap = 2

  for (let f = 0; f < frames; f++) {
    const off = f * H;
    for (let i = 0; i < N; i++) { re[i] = pad[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const lam = noise[k] * overSub + 1e-12;
      const gamma = pow[base + k] / lam;
      const xi = alphaDD * prevG[k] * prevG[k] * prevGamma[k] + (1 - alphaDD) * Math.max(gamma - 1, 0);
      g[k] = Math.max(gMin, xi / (1 + xi));
      prevGamma[k] = gamma;
    }
    // Light frequency smoothing kills isolated "musical noise" tones.
    for (let k = 0; k < bins; k++) {
      const gk = 0.25 * g[Math.max(0, k - 1)] + 0.5 * g[k] + 0.25 * g[Math.min(bins - 1, k + 1)];
      prevG[k] = gk;
      re[k] *= gk; im[k] *= gk;
      if (k > 0 && k < N / 2) { re[N - k] *= gk; im[N - k] *= gk; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) out[off + i] += (re[i] / N) * win[i] * norm;
    if (onProgress && (f & 1023) === 0) onProgress(f / frames);
  }
  return out.subarray(N / 2, N / 2 + x.length).slice();
}

/* ───────────────────────── stage 4: VAD voice gate ───────────────────────── */

export function voiceGate(x, vad, amount) {
  if (amount <= 0) return x.slice();
  const floor = undb(-(amount / 100) * 30);
  // Offline we can see the future: open 40 ms before speech, hold 180 ms after it.
  const lookF = 4, holdF = 18, nF = vad.length;
  const open = new Uint8Array(nF);
  for (let f = 0; f < nF; f++) {
    if (vad[f] <= 0.45) continue;
    for (let k = Math.max(0, f - lookF); k <= Math.min(nF - 1, f + holdF); k++) open[k] = 1;
  }
  const att = Math.exp(-1 / (0.004 * SR)), rel = Math.exp(-1 / (0.12 * SR));
  let gEnv = floor;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const want = open[Math.min(nF - 1, (i / RN_FRAME) | 0)] ? 1 : floor;
    gEnv = want + (gEnv - want) * (want > gEnv ? att : rel);
    out[i] = x[i] * gEnv;
  }
  return out;
}

/* ───────────────────────── stage 5: tone (presence + de-esser) ───────────────────────── */

export function presence(x, amount) {
  if (amount <= 0) return x.slice();
  let y = runBiquad(x, biquad('peaking', 3200, 0.8, (amount / 100) * 6));
  y = runBiquad(y, biquad('highshelf', 9000, 0.7, (amount / 100) * 1.5), y);
  return y;
}

export function deEss(x, amount) {
  if (amount <= 0) return x.slice();
  let band = runBiquad(x, biquad('highpass', 5500, 0.707));
  band = runBiquad(band, biquad('highpass', 5500, 0.707), band);
  const a = Math.exp(-1 / (0.003 * SR)), r = Math.exp(-1 / (0.06 * SR));
  const thr = 0.55 - (amount / 100) * 0.4; // sibilance ratio above which we compress
  const strength = 0.5 + (amount / 100) * 1.5;
  let eb = 1e-9, ef = 1e-9;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const vb = band[i] * band[i], vf = x[i] * x[i];
    eb = vb > eb ? vb + (eb - vb) * a : vb + (eb - vb) * r;
    ef = vf > ef ? vf + (ef - vf) * a : vf + (ef - vf) * r;
    const ratio = Math.sqrt(eb / (ef + 1e-12));
    const g = ratio > thr ? Math.pow(thr / ratio, strength) : 1;
    out[i] = x[i] - band[i] * (1 - g);
  }
  return out;
}

/* ───────────────────────── stage 6: loudness + limiter ───────────────────────── */

// Integrated loudness per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, dual gating).
export function integratedLufs(channels) {
  const n = channels[0].length;
  const block = Math.round(0.4 * SR), step = Math.round(0.1 * SR);
  if (n < block) return -70;
  const kw = channels.map((c) => {
    let y = runBiquad(c, biquad('highshelf', 1681.97, 0.7071, 4.0));
    return runBiquad(y, biquad('highpass', 38.13, 0.5003), y);
  });
  const ms = [];
  for (let s = 0; s + block <= n; s += step) {
    let sum = 0;
    for (const c of kw) for (let i = s; i < s + block; i++) sum += c[i] * c[i];
    ms.push(sum / block);
  }
  const L = (m) => -0.691 + 10 * Math.log10(m + 1e-12);
  const abs = ms.filter((m) => L(m) > -70);
  if (!abs.length) return -70;
  const relGate = L(abs.reduce((p, m) => p + m, 0) / abs.length) - 10;
  const rel = abs.filter((m) => L(m) > relGate);
  return L(rel.reduce((p, m) => p + m, 0) / Math.max(1, rel.length));
}

// Look-ahead peak limiter shared across channels (keeps the stereo image stable).
export function limit(channels, ceilingDb = -1) {
  const ceil = undb(ceilingDb), n = channels[0].length;
  const look = Math.round(0.005 * SR), rel = Math.exp(-1 / (0.08 * SR));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) p = Math.max(p, Math.abs(c[i]));
    need[i] = p > ceil ? ceil / p : 1;
  }
  // Sliding minimum over the look-ahead window (monotonic deque).
  const minAhead = new Float32Array(n);
  const dq = new Int32Array(n); let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + look) h++;
    minAhead[i] = need[dq[h]];
  }
  let g = 1;
  for (let i = 0; i < n; i++) {
    const want = minAhead[i];
    g = want < g ? want : want + (g - want) * rel;
    for (const c of channels) c[i] *= g;
  }
  return channels;
}

/* ───────────────────────── measurement ───────────────────────── */

function rmsWhere(x, vad, pred) {
  let s = 0, n = 0;
  for (let f = 0; f < vad.length; f++) {
    if (!pred(vad[f])) continue;
    const a = f * RN_FRAME, b = Math.min(x.length, a + RN_FRAME);
    for (let i = a; i < b; i++) { s += x[i] * x[i]; n++; }
  }
  return n ? Math.sqrt(s / n) : 0;
}

export function measure(dry, wet, vad) {
  const quiet = (v) => v < 0.1, speech = (v) => v > 0.7;
  const nIn = db(rmsWhere(dry, vad, quiet)), nOut = db(rmsWhere(wet, vad, quiet));
  const vIn = db(rmsWhere(dry, vad, speech)), vOut = db(rmsWhere(wet, vad, speech));
  let sp = 0;
  for (const v of vad) if (v > 0.5) sp++;
  return {
    noiseFloorIn: nIn, noiseFloorOut: nOut,
    noiseReduction: nIn - nOut,
    voiceIn: vIn, voiceOut: vOut,
    snrIn: vIn - nIn, snrOut: vOut - nOut,
    speechRatio: vad.length ? sp / vad.length : 0,
  };
}

/* ───────────────────────── orchestration with caching ───────────────────────── */

// Holds intermediate results so moving a cheap slider (EQ, gate, mix) doesn't re-run
// RNNoise or the STFT stage.
export class VoiceIsolator {
  constructor(rnnoise) {
    this.rn = rnnoise;
    this.latency = measureRnnoiseLatency(rnnoise);
    this.src = null;
    this.cache = {};
  }

  setSource(channels) {
    this.src = channels;
    this.cache = {};
  }

  process(p, onProgress = () => {}) {
    const P = { ...AUDIO_DEFAULTS, ...p };
    const c = this.cache;
    const report = (stage, frac) => onProgress({ stage, frac });

    const kPre = `${P.highpassHz}|${P.hum}`;
    if (c.kPre !== kPre) {
      report('prefilter', 0);
      c.pre = this.src.map((ch) => prefilter(ch, P));
      c.kPre = kPre; c.kRn = null;
    }
    if (c.kRn !== kPre) {
      c.rn = c.pre.map((r, i) => {
        report('neural', i / c.pre.length);
        return runRnnoise(this.rn, r.y, this.latency);
      });
      // Average VAD across channels.
      const vad = new Float32Array(c.rn[0].vad.length);
      for (const r of c.rn) for (let i = 0; i < vad.length; i++) vad[i] += r.vad[i] / c.rn.length;
      c.vad = vad;
      c.kRn = kPre; c.kSpec = null;
    }
    const kSpec = `${kPre}|${P.reductionDb}|${P.cleanup}`;
    if (c.kSpec !== kSpec) {
      const keep = P.reductionDb >= 60 ? 0 : undb(-P.reductionDb);
      c.spec = c.rn.map((r, i) => {
        const pre = c.pre[i].y;
        const y = new Float32Array(pre.length);
        for (let j = 0; j < y.length; j++) y[j] = r.y[j] + keep * (pre[j] - r.y[j]);
        return spectralCleanup(y, c.vad, P.cleanup, (f) => report('spectral', (i + f) / c.rn.length));
      });
      c.kSpec = kSpec;
    }

    report('finish', 0);
    const wet = P.mix / 100;
    let out = c.spec.map((y, i) => {
      let z = voiceGate(y, c.vad, P.gate);
      z = presence(z, P.presence);
      z = deEss(z, P.deEsser);
      if (wet < 1) {
        const dry = this.src[i];
        for (let j = 0; j < z.length; j++) z[j] = wet * z[j] + (1 - wet) * dry[j];
      }
      return z;
    });

    let lufsBefore = integratedLufs(out), gainDb = 0;
    if (P.loudness !== null && P.loudness !== undefined && lufsBefore > -60) {
      gainDb = Math.max(-20, Math.min(24, P.loudness - lufsBefore));
      const g = undb(gainDb);
      for (const ch of out) for (let j = 0; j < ch.length; j++) ch[j] *= g;
    }
    limit(out, -1);

    const m = measure(this.src[0], out[0], c.vad);
    return {
      channels: out,
      vad: c.vad,
      stats: { ...m, humHz: c.pre[0].humHz, lufs: integratedLufs(out), gainDb, latency: this.latency },
    };
  }
}

/* ───────────────────────── WAV encoding ───────────────────────── */

export function encodeWav(channels, sampleRate = SR, bitDepth = 24) {
  const nCh = channels.length, n = channels[0].length, bps = bitDepth / 8;
  const buf = new ArrayBuffer(44 + n * nCh * bps);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nCh * bps, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * bps, true);
  v.setUint16(32, nCh * bps, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, n * nCh * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 16) { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
      else {
        const q = Math.round(s * 8388607);
        v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3;
      }
    }
  }
  return buf;
}
