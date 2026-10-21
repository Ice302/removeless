// Matte engine test: renders every engine on a real portrait, plus a synthetic green-screen
// composite with known ground-truth alpha to score the keyer + refine stack objectively.
// Usage: node tests/matte-quality.mjs <image-or-video> <outDir>
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
// Plain build (not the .bundle) so ORT loads its wasm from disk under Node.
import * as ort from '../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';
import { MattePipeline } from '../src/engine/matte-pipeline.js';

ort.env.wasm.numThreads = 1; // threaded wasm spawns workers that can't fetch under Node
const [input, outDir = 'tests/.out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

function decode(file, w, h, frames = 1) {
  const raw = execFileSync(ffmpegPath, ['-v', 'error', '-i', file, '-frames:v', String(frames), '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
}
function savePng(rgba, w, h, name) {
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', path.join(outDir, name)], { input: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
}
const W = 960, H = 640;
const img = decode(input, W, H);
const pipe = new MattePipeline({ ort, loadBytes: async (f) => readFileSync(path.resolve('public/models', f)), preferGpu: false });

const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const results = {};
for (const engine of ['rvm', 'modnet']) {
  pipe.reset();
  // RVM is recurrent: feed a few frames so its temporal memory converges, like real video.
  let r;
  for (let k = 0; k < (engine === 'rvm' ? 4 : 1); k++) {
    r = await pipe.process(img, W, H, { engine, backdrop: 'color', backdropColor: '#E3F732' }, { t: k / 30 });
  }
  results[engine] = r.alpha;
  savePng(r.rgba, W, H, `${engine}_composite.png`);
  const a = await pipe.process(img, W, H, { engine, view: 'alpha' }, { t: 5 / 30 });
  savePng(a.rgba, W, H, `${engine}_alpha.png`);
  console.log(`${engine.padEnd(7)} infer ${r.stats.inferMs.toFixed(0)} ms, total ${r.stats.totalMs.toFixed(0)} ms, backend ${r.stats.backend}, coverage ${(r.stats.coverage * 100).toFixed(1)}%`);
}
console.log(`RVM vs MODNet mean |Δα| = ${mad(results.rvm, results.modnet).toFixed(4)}`);

// Synthetic green screen: subject (RVM alpha as ground truth) over a lit green backdrop
// with a soft gradient + sensor noise, then key it back out.
const gt = results.rvm;
const gs = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, a = gt[i], light = 0.85 + 0.15 * Math.sin(x / W * Math.PI);
  const bg = [30 * light, 185 * light, 70 * light].map((v) => v + (Math.random() - 0.5) * 8);
  for (let c = 0; c < 3; c++) gs[i * 4 + c] = img[i * 4 + c] * a + bg[c] * (1 - a);
  gs[i * 4 + 3] = 255;
}
savePng(gs, W, H, 'greenscreen_input.png');
for (const [label, p] of [
  ['chroma raw', { engine: 'chroma', snap: 0, feather: 0, chatter: 0 }],
  ['chroma refined', { engine: 'chroma', snap: 40, feather: 0, threshold: 52, contrast: 10 }],
  ['rvm on green', { engine: 'rvm' }],
]) {
  pipe.reset();
  const r = await pipe.process(gs, W, H, { ...p, backdrop: 'color', backdropColor: '#C0C4CA' }, { t: 0 });
  console.log(`${label.padEnd(15)} mean |α−gt| = ${mad(r.alpha, gt).toFixed(4)}  key ${JSON.stringify(r.stats.key)}  spill ch ${r.stats.spill}  ${r.stats.totalMs.toFixed(0)} ms`);
  savePng(r.rgba, W, H, `${label.replace(/ /g, '_')}.png`);
}

// Hint strokes: a BG stroke across the jacket must cut the matte there; an FG stroke on
// empty background must add matte. Then move the subject and check the stroke follows.
const at = (a, x, y) => a[Math.round(y * H) * W + Math.round(x * W)];
const strokes = [
  { mode: 'bg', pts: [0.40, 0.75, 0.48, 0.75], r: 0.04, t: 0, anchor: null },
  { mode: 'fg', pts: [0.85, 0.30, 0.90, 0.30], r: 0.04, t: 0, anchor: null },
];
pipe.reset();
const before = (await pipe.process(img, W, H, { engine: 'modnet' }, { t: 0 })).alpha;
pipe.reset();
const after = (await pipe.process(img, W, H, { engine: 'modnet' }, { t: 0, strokes })).alpha;
console.log(`BG stroke on jacket: α ${at(before, 0.44, 0.75).toFixed(2)} → ${at(after, 0.44, 0.75).toFixed(2)}`);
console.log(`FG stroke on background: α ${at(before, 0.875, 0.30).toFixed(2)} → ${at(after, 0.875, 0.30).toFixed(2)}`);

// Tracking: anchor the BG stroke to the subject, shift the frame 96 px right, expect the cut to move too.
pipe.reset();
const anchor = (await pipe.process(img, W, H, { engine: 'modnet' }, { t: 0 })).stats.subject;
const shifted = new Uint8ClampedArray(img.length);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.max(0, x - 96), o = (y * W + x) * 4, si = (y * W + sx) * 4;
  for (let c = 0; c < 4; c++) shifted[o + c] = img[si + c];
}
pipe.reset();
const tracked = (await pipe.process(shifted, W, H, { engine: 'modnet', trackStrokes: true },
  { t: 0.5, strokes: [{ ...strokes[0], anchor }] })).alpha;
console.log(`tracked BG stroke after 96 px move: α at new spot ${at(tracked, 0.44 + 0.1, 0.75).toFixed(2)}, at old spot ${at(tracked, 0.44, 0.75).toFixed(2)}`);
