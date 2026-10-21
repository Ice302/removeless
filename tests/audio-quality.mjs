// Objective test of the voice-isolation chain against a known clean reference.
// Usage: node tests/audio-quality.mjs <noisy.wav> <clean.wav> [out.wav]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { VoiceIsolator, encodeWav, SR, prefilter, AUDIO_DEFAULTS } from '../src/engine/audio-dsp.js';
import ffmpegPath from 'ffmpeg-static';

const readMono = (file) => {
  const raw = execFileSync(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
};

// Scale-invariant SDR (dB) — standard source-separation metric.
function siSdr(est, ref) {
  const n = Math.min(est.length, ref.length);
  let dot = 0, rr = 0;
  for (let i = 0; i < n; i++) { dot += est[i] * ref[i]; rr += ref[i] * ref[i]; }
  const a = dot / rr;
  let s = 0, e = 0;
  for (let i = 0; i < n; i++) { const t = a * ref[i]; s += t * t; e += (est[i] - t) ** 2; }
  return 10 * Math.log10(s / e);
}

// Ground-truth SNR: output level where the clean reference is silent (pure residual noise)
// vs where it is loud (voice). Unlike SI-SDR it does not punish intentional EQ.
function gtSnr(out, ref) {
  const F = 480; let vS = 0, vN = 0, nS = 0, nN = 0;
  for (let f = 0; f + F <= Math.min(out.length, ref.length); f += F) {
    let r = 0, o = 0;
    for (let i = f; i < f + F; i++) { r += ref[i] * ref[i]; o += out[i] * out[i]; }
    const rdb = 10 * Math.log10(r / F + 1e-12);
    if (rdb < -60) { vN += o; nN++; } else if (rdb > -30) { vS += o; nS++; }
  }
  return { snr: 10 * Math.log10((vS / nS) / (vN / nN + 1e-20)), silentFrames: nN };
}

const [noisyPath, cleanPath, outPath] = process.argv.slice(2);
const noisy = readMono(noisyPath), clean = readMono(cleanPath);
// The wasm build only runs in browsers/workers; masquerade as a worker for Node.
globalThis.WorkerGlobalScope ??= class {};
globalThis.self ??= globalThis;
const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
const rn = await Rnnoise.load();
const iso = new VoiceIsolator(rn);
console.log(`RNNoise latency compensated: ${iso.latency} samples`);
iso.setSource([noisy]);

const presets = {
  'neural only':        { cleanup: 0, gate: 0, presence: 0, deEsser: 0, loudness: null, reductionDb: 60 },
  'neural + cleanup':   { gate: 0, presence: 0, deEsser: 0, loudness: null, reductionDb: 60 },
  'default chain':      {},
  'gentle (18 dB)':     { reductionDb: 18, cleanup: 25, gate: 10 },
};
// The chain's high-pass/notch filters are linear but not linear-phase, and SI-SDR is a
// strict waveform metric, so score against the reference passed through the same filters.
const refFor = (p) => prefilter(clean, { ...AUDIO_DEFAULTS, ...p, hum: iso.cache.pre?.[0].humHz ? String(iso.cache.pre[0].humHz) : 'off' }).y;
console.log(`input SI-SDR: ${siSdr(noisy, clean).toFixed(2)} dB (unfiltered)`);
let last;
for (const [name, p] of Object.entries(presets)) {
  const t0 = performance.now();
  const r = iso.process(p);
  const ms = performance.now() - t0;
  last = r;
  const s = r.stats;
  const ref = refFor(p);
  if (name === 'neural only') console.log(`input SI-SDR (filtered): ${siSdr(iso.cache.pre[0].y, ref).toFixed(2)} dB`);
  const g = gtSnr(r.channels[0], ref);
  if (name === 'neural only') console.log(`input GT-SNR: ${gtSnr(iso.cache.pre[0].y, ref).snr.toFixed(1)} dB over ${g.silentFrames} silent frames`);
  console.log(`${name.padEnd(18)} GT-SNR ${g.snr.toFixed(1).padStart(5)} dB | SI-SDR ${siSdr(r.channels[0], ref).toFixed(2).padStart(6)} dB | noise floor ${s.noiseFloorIn.toFixed(1)} → ${s.noiseFloorOut.toFixed(1)} dBFS (−${s.noiseReduction.toFixed(1)} dB) | hum ${s.humHz ?? '-'} Hz | ${s.lufs.toFixed(1)} LUFS | ${ms.toFixed(0)} ms`);
}
const r = iso.process({});
if (outPath) writeFileSync(outPath, Buffer.from(encodeWav(r.channels, SR, 24)));
console.log(`speech frames ${(r.stats.speechRatio * 100).toFixed(0)}% | realtime factor ${(noisy.length / SR * 1000 / 1).toFixed(0)} ms audio`);
