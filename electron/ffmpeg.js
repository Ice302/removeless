// ffmpeg integration for the desktop app: probing, audio extraction, preview proxies and
// streaming export jobs (raw RGBA frames in from the renderer → ProRes/VP9/H.264 out).
import { spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

let FFMPEG = 'ffmpeg';
export function setFfmpegPath(p) { FFMPEG = p; }
export function ffmpegPath() { return FFMPEG; }

function run(args, { onStderr, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; onStderr?.(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

const toSec = (hms) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/* ───────── probe ───────── */

// Parses `ffmpeg -i` output. Good enough for the first video/audio stream, which is all the
// studio works with; dimensions are reported after rotation (ffmpeg autorotates on decode).
export async function probe(file) {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  const info = { path: file, name: path.basename(file), duration: 0, hasVideo: false, hasAudio: false };
  const d = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = toSec(d[1]);
  const v = /Stream #\d+:\d+[^:]*: Video: ([^\s,]+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/.exec(stderr);
  if (v && !/attached pic/.test(v[0])) {
    info.hasVideo = true;
    info.vcodec = v[1];
    info.width = Number(v[2]);
    info.height = Number(v[3]);
    const fps = /([\d.]+) fps/.exec(v[0]) || /([\d.]+) tbr/.exec(v[0]);
    info.fps = fps ? Math.min(120, Number(fps[1])) : 30;
    info.alpha = /yuva|rgba|argb|bgra|gbrap/.test(v[0]);
    const rot = /rotation of (-?[\d.]+) degrees/.exec(stderr);
    info.rotation = rot ? Number(rot[1]) : 0;
    if (Math.abs(info.rotation) % 180 === 90) [info.width, info.height] = [info.height, info.width];
  }
  const a = /Stream #\d+:\d+[^:]*: Audio: ([^\s,]+)[^\n]*?(\d+) Hz, ([^,]+)/.exec(stderr);
  if (a) {
    info.hasAudio = true;
    info.acodec = a[1];
    info.sampleRate = Number(a[2]);
    info.channels = /mono/.test(a[3]) ? 1 : 2;
  }
  if (!info.hasVideo && !info.hasAudio) throw new Error('No playable video or audio stream found.');
  return info;
}

/* ───────── audio ───────── */

// Decodes the first audio stream to 48 kHz float32 (≤2 channels, interleaved).
export async function extractAudio(file, channels) {
  const ch = Math.max(1, Math.min(2, channels || 2));
  const { code, stdout, stderr } = await run(['-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', String(ch), '-ar', '48000', '-f', 'f32le', 'pipe:1']);
  if (code !== 0) throw new Error(`Audio decode failed: ${stderr.trim().split('\n').pop()}`);
  return { sampleRate: 48000, channels: ch, data: stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) };
}

/* ───────── preview proxy ───────── */

// Chromium can't decode ProRes, DNxHR, some HEVC, MXF, AVI… so we make an H.264 proxy for
// the interactive preview. Exports always decode the original.
export async function makeProxy(file, onProgress) {
  const st = statSync(file);
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'removeless-proxies');
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${key}.mp4`);
  if (existsSync(out) && statSync(out).size > 1000) return out;
  const info = await probe(file);
  const tmp = `${out}.part.mp4`;
  const { code, stderr } = await run([
    '-hide_banner', '-y', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?',
    '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp,
  ], {
    onStderr: (s) => {
      const m = /time=(\d+:\d+:\d+\.\d+)/.exec(s);
      if (m && info.duration) onProgress?.(Math.min(1, toSec(m[1]) / info.duration));
    },
  });
  if (code !== 0) throw new Error(`Proxy failed: ${stderr.trim().split('\n').pop()}`);
  const { renameSync } = await import('node:fs');
  renameSync(tmp, out);
  return out;
}

/* ───────── export ───────── */

export const FORMATS = {
  prores4444: {
    label: 'ProRes 4444 + Alpha (.mov)', ext: 'mov', alpha: true,
    v: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0'],
    a: ['-c:a', 'pcm_s24le'],
  },
  webm_alpha: {
    label: 'WebM VP9 + Alpha (.webm)', ext: 'webm', alpha: true,
    v: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0'],
    a: ['-c:a', 'libopus', '-b:a', '160k'],
  },
  hevc_alpha: {
    label: 'HEVC + Alpha (.mov, Apple)', ext: 'mov', alpha: true, platforms: ['darwin'],
    v: ['-c:v', 'hevc_videotoolbox', '-alpha_quality', '0.9', '-b:v', '24M', '-tag:v', 'hvc1', '-pix_fmt', 'bgra'],
    a: ['-c:a', 'aac', '-b:a', '256k'],
  },
  mp4_h264: {
    label: 'H.264 MP4 (composited)', ext: 'mp4', alpha: false, even: true,
    v: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    a: ['-c:a', 'aac', '-b:a', '192k'],
  },
  matte_mp4: {
    label: 'Matte only (luma, .mp4)', ext: 'mp4', alpha: false, even: true, matte: true,
    v: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    a: null,
  },
  png_seq: {
    label: 'PNG sequence + WAV (folder)', ext: '', alpha: true, sequence: true,
    v: ['-c:v', 'png', '-pix_fmt', 'rgba'],
    a: null,
  },
};

const jobs = new Map();
let nextJob = 1;

// Starts a decoder (source → raw RGBA at w×h, constant fps) and an encoder (raw RGBA from
// the renderer → final file). The renderer pulls frames, mattes them, and pushes results.
export function startExport(o) {
  const fmt = FORMATS[o.format];
  if (!fmt) throw new Error(`Unknown format ${o.format}`);
  const id = nextJob++;
  const frameBytes = o.width * o.height * 4;
  const color = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

  const decArgs = ['-hide_banner', '-v', 'error'];
  if (o.start > 0) decArgs.push('-ss', o.start.toFixed(4));
  decArgs.push('-i', o.src, '-t', o.duration.toFixed(4), '-map', '0:v:0',
    '-vf', `fps=${o.fps},scale=${o.width}:${o.height}:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`,
    '-f', 'rawvideo', 'pipe:1');

  let outPath = o.out;
  const encArgs = ['-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-framerate', String(o.fps), '-i', 'pipe:0'];
  const withAudio = !!(o.wavPath && fmt.a);
  if (withAudio) encArgs.push('-i', o.wavPath);
  encArgs.push('-map', '0:v:0');
  if (withAudio) encArgs.push('-map', '1:a:0', ...fmt.a);
  encArgs.push(...fmt.v);
  if (!fmt.sequence) encArgs.push(...color, '-vf', 'scale=out_color_matrix=bt709:out_range=tv');
  if (fmt.sequence) {
    mkdirSync(outPath, { recursive: true });
    outPath = path.join(outPath, `${o.baseName || 'frame'}_%05d.png`);
  }
  encArgs.push(outPath);

  const dec = spawn(FFMPEG, decArgs, { windowsHide: true });
  const enc = spawn(FFMPEG, encArgs, { windowsHide: true });
  const job = {
    id, dec, enc, frameBytes, queue: [], waiters: [], ended: false, error: null,
    pending: Buffer.alloc(0), encErr: '', decErr: '', out: o.out,
    encDone: new Promise((res) => enc.on('close', (code) => res(code))),
  };
  dec.stdout.on('data', (chunk) => {
    job.pending = job.pending.length ? Buffer.concat([job.pending, chunk]) : chunk;
    while (job.pending.length >= frameBytes) {
      const f = job.pending.subarray(0, frameBytes);
      job.pending = job.pending.subarray(frameBytes);
      const copy = new Uint8Array(frameBytes); copy.set(f);
      const w = job.waiters.shift();
      if (w) w(copy); else job.queue.push(copy);
    }
    if (job.queue.length > 6) dec.stdout.pause(); // backpressure: renderer is the bottleneck
  });
  dec.stderr.on('data', (d) => { job.decErr += d; });
  enc.stderr.on('data', (d) => { job.encErr += d; });
  enc.stdin.on('error', (e) => { job.error = e; });
  dec.on('close', () => {
    job.ended = true;
    for (const w of job.waiters.splice(0)) w(null);
  });
  jobs.set(id, job);
  return { id, frames: Math.max(1, Math.round(o.duration * o.fps)) };
}

export function readFrame(id) {
  const job = jobs.get(id);
  if (!job) return Promise.resolve(null);
  if (job.queue.length) {
    const f = job.queue.shift();
    if (job.queue.length < 3) job.dec.stdout.resume();
    return Promise.resolve(f);
  }
  if (job.ended) return Promise.resolve(null);
  job.dec.stdout.resume();
  return new Promise((res) => job.waiters.push(res));
}

export function writeFrame(id, data) {
  const job = jobs.get(id);
  if (!job) throw new Error('Export job not found');
  if (job.error) throw new Error(`Encoder stopped: ${job.encErr.trim().split('\n').pop() || job.error.message}`);
  const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
  if (!job.enc.stdin.write(buf)) {
    return new Promise((res) => job.enc.stdin.once('drain', res));
  }
  return Promise.resolve();
}

export async function finishExport(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('Export job not found');
  job.enc.stdin.end();
  job.dec.kill();
  const code = await job.encDone;
  jobs.delete(id);
  if (code !== 0) throw new Error(`Encoder failed: ${job.encErr.trim().split('\n').slice(-2).join(' ')}`);
  return { path: job.out };
}

export function cancelExport(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.dec.kill('SIGKILL');
  job.enc.kill('SIGKILL');
  jobs.delete(id);
  try { if (existsSync(job.out) && statSync(job.out).isFile()) rmSync(job.out); } catch {}
}

// Audio-only deliverables: WAV is written directly; FLAC/M4A are transcoded from it.
export async function transcodeAudio(wavPath, out, codec) {
  const args = codec === 'flac' ? ['-c:a', 'flac'] : ['-c:a', 'aac', '-b:a', '256k'];
  const { code, stderr } = await run(['-hide_banner', '-v', 'error', '-y', '-i', wavPath, ...args, out]);
  if (code !== 0) throw new Error(stderr.trim());
  return { path: out };
}
