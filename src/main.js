// Removeless — app controller. Wires the UI to the matte/audio workers, the player and
// the exporter. Desktop features light up when the Electron bridge (`window.native`) exists.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
import './styles.css';

import { Store, DEFAULTS, spanFromUi, strengthMap, AUDIO_KEYS, ui } from './state.js';
import { native, isDesktop, appInfo, clipFromPath, clipFromFile, decodeAudio, saveBytes, download } from './platform.js';
import { MatteClient, AudioClient } from './workers/clients.js';
import { AudioPlayer } from './audio-player.js';
import { Exporter, exportRange } from './exporter.js';
import { peaks, drawTimeline, drawAudioView, drawSpectrum } from './ui/timeline.js';
import { buildSliders } from './ui/sliders.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const isMacLike = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMacLike ? '⌘' : 'Ctrl+';
const ENGINE_LABEL = { rvm: 'ROTO NEURAL', modnet: 'PORTRAIT', chroma: 'CHROMA KEY', off: 'AUDIO ONLY' };

const store = new Store();
const player = new AudioPlayer();
const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
video.setAttribute('playsinline', '');

const S = {
  clips: [],
  clip: null,
  tool: 'roto',
  brush: 'fg',
  brushRadius: 22,
  bypass: false,
  guides: false,
  picking: false,
  painting: null,           // in-progress stroke
  pointer: null,            // last pointer position over the viewport (canvas px)
  lastStats: null,
  audio: { stats: null, vad: null, rawPeaks: null, wetPeaks: null, wet: null, job: 0, busy: false },
  preview: { busy: false, dirty: false, w: 960, h: 540, frames: 0, fpsT: performance.now(), fps: 0 },
  info: null,
  exportFormat: ui.get('exportFormat', isDesktop ? 'prores4444' : 'web_mp4'),
  camera: null,
};

/* ───────────────────────── toasts / busy ───────────────────────── */

function toast(msg, { kind = 'ok', action, onAction, ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span></span>`;
  el.firstChild.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { onAction?.(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const fail = (e) => {
  // play() interrupted by a new load/pause is expected while switching clips.
  if (e?.name === 'AbortError') return;
  console.error(`${e?.name || 'Error'}: ${e?.message || e}`);
  toast(e?.message || String(e), { kind: 'err', ms: 7000 });
};
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

function busy(text, f = null) {
  const el = $('#busy');
  if (text === false) { el.hidden = true; return; }
  el.hidden = false;
  $('#busyText').textContent = text;
  $('#busyBar').style.width = f == null ? '30%' : `${Math.round(f * 100)}%`;
}

/* ───────────────────────── theme ───────────────────────── */

const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('#btnTheme').textContent = { system: '◐', light: '☀', dark: '☾' }[t];
  $('#btnTheme').title = `Theme: ${t} (click to change)`;
  ui.set('theme', t);
}
applyTheme(ui.get('theme', 'system'));
$('#btnTheme').onclick = () => applyTheme(THEMES[(THEMES.indexOf(ui.get('theme', 'system')) + 1) % 3]);

/* ───────────────────────── boot ───────────────────────── */

let matte = new MatteClient();
const audio = new AudioClient();
const exporter = new Exporter({
  getMatte: () => store.matte(),
  getAudioWav: async (clip, start, end) => {
    if (clip !== S.clip) await activateClip(clip, { quiet: true });
    const r = await audio.wav(store.audio(), start, end, 24);
    return r.buffer;
  },
  getAudioBuffer: (start, end) => {
    if (!S.audio.wet) return null;
    const a = Math.round(start * 48000), b = Math.round(end * 48000);
    return player.toBuffer(S.audio.wet.map((c) => c.subarray(a, Math.min(c.length, b))));
  },
  onProgress: (p) => exportProgress(p),
});

const BACKEND_LABEL = { native: 'Native CPU', webgpu: 'GPU (WebGPU)', wasm: 'CPU (WASM)' };
function showBackend(backend) {
  S.backend = backend;
  const where = isDesktop ? ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[S.info?.platform] || 'Desktop') : 'Web';
  const label = backend === 'wasm' ? `CPU (WASM ×${S.threads || 1})${matte.gpuRejected ? ' · GPU failed check' : ''}` : BACKEND_LABEL[backend] || backend;
  setStatus(`${where} · ${label}`, backend === 'wasm' ? 'warn' : 'ok');
  $('#telBackend').textContent = `Engine: ${BACKEND_LABEL[backend] || backend}`;
}

function setStatus(text, state = 'ok') {
  $('#statusText').textContent = text;
  $('#statusDot').className = `status-dot ${state}`;
}

async function boot() {
  const now = new Date();
  $('#dateDay').textContent = now.toLocaleDateString(undefined, { weekday: 'short' });
  $('#dateFull').textContent = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  $('#dateYear').textContent = String(now.getFullYear());

  S.info = await appInfo();
  document.body.classList.toggle('is-mac', isDesktop && S.info.platform === 'darwin');
  $('#versionIndex').textContent = (S.info.version || '0.13.0').split('.')[1]?.padStart(3, '0') || '013';
  $('#aboutVersion').textContent = `Version ${S.info.version} · ${isDesktop ? `desktop (${S.info.platform}/${S.info.arch})` : 'web'}`;
  if (isDesktop && S.info.platform !== 'darwin') {
    $('#winControls').hidden = false;
    $('#winMin').onclick = () => native.minimize();
    $('#winMax').onclick = () => native.maximize();
    $('#winClose').onclick = () => native.close();
  }
  if (!S.info.formats[S.exportFormat]) S.exportFormat = Object.keys(S.info.formats)[0];
  exporter.formats = S.info.formats;
  buildFormatList();
  buildPresetSelect();
  syncAllControls();

  requestAnimationFrame(tick);
  try {
    const first = store.params.engine === 'off' || store.params.engine === 'chroma' ? 'rvm' : store.params.engine;
    let m = await matte.ready;
    setStatus('Loading matte model…', 'warn');
    let backend;
    try {
      backend = await matte.warmup(first, 45000);
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
      // Threaded WASM can hang on some setups; rebuild the worker single-threaded.
      console.warn('[matte] threaded warmup timed out, retrying single-threaded');
      matte.terminate();
      matte = new MatteClient({ threads: 1 });
      exporter.threads = 1;
      m = await matte.ready;
      backend = await matte.warmup(first);
    }
    S.threads = m.threads;
    showBackend(backend);
    if (matte.gpuRejected) console.info('[matte] GPU rejected by accuracy check; using CPU');
  } catch (e) {
    setStatus('Matte engine unavailable', 'warn');
    fail(new Error(`Matte engine failed to load: ${e.message}`));
  }
  audio.ready.then(() => { $('#telAudio').textContent = 'Audio: 48 kHz · RNNoise'; }).catch(fail);
}

/* ───────────────────────── media bin ───────────────────────── */

const fmtTime = (t) => {
  if (!Number.isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function renderBin() {
  const list = $('#reelList');
  list.innerHTML = '';
  S.clips.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = `postit${c === S.clip ? ' is-active' : ''}`;
    b.title = c.name;
    const tag = c === S.clip ? '<span class="tag tag-ink">ACTIVE</span>'
      : c.exported ? '<span class="tag">✓ DONE</span>'
      : `<span class="tag">${c.info.hasVideo ? `${c.info.width}×${c.info.height}` : 'AUDIO'}</span>`;
    b.innerHTML = `<span class="name"><b>${i + 1}.</b> ${fmtTime(c.info.duration)} </span>${tag}<span class="remove" title="Remove from bin" aria-label="Remove">✕</span>`;
    b.querySelector('.name').append(document.createTextNode(c.name));
    b.onclick = (e) => {
      if (e.target.classList.contains('remove')) return removeClip(c);
      if (c !== S.clip) activateClip(c).catch(fail);
    };
    list.appendChild(b);
  });
}

function removeClip(c) {
  S.clips = S.clips.filter((x) => x !== c);
  if (S.clip === c) {
    S.clip = null;
    if (S.clips.length) activateClip(S.clips[0]).catch(fail);
    else clearViewer();
  }
  renderBin();
}

function clearViewer() {
  video.removeAttribute('src'); video.load();
  player.clear();
  document.body.classList.remove('has-media');
  $('#viewport').classList.remove('has-media');
  $('#clipTitle').textContent = 'No media';
  S.audio = { stats: null, vad: null, rawPeaks: null, wetPeaks: null, wet: null, job: 0 };
  $('#view').getContext('2d').clearRect(0, 0, $('#view').width, $('#view').height);
}

async function importPaths(paths) {
  for (const p of paths) {
    try {
      if (p.endsWith('.removeless')) continue;
      const c = await clipFromPath(p);
      S.clips.push(c);
      renderBin();
      if (!S.clip || S.clips.length === 1) await activateClip(c);
    } catch (e) { fail(new Error(`${p.split(/[\\/]/).pop()}: ${e.message}`)); }
  }
}

async function importFiles(files) {
  for (const f of files) {
    try {
      if (f.name.endsWith('.removeless')) { await openProject(JSON.parse(await f.text())); continue; }
      busy(`Reading ${f.name}…`);
      const c = await clipFromFile(f);
      S.clips.push(c);
      renderBin();
      await activateClip(c);
    } catch (e) { fail(new Error(`${f.name}: ${e.message}`)); }
    finally { busy(false); }
  }
}

async function pickMedia() {
  if (isDesktop) return importPaths(await native.openMediaDialog());
  $('#fileInput').click();
}

/* ───────────────────────── activate clip ───────────────────────── */

function previewSize(info) {
  const long = { draft: 640, balanced: 960, high: 1280 }[store.params.quality] || 960;
  const s = Math.min(1, long / Math.max(info.width || 1, info.height || 1));
  return { w: Math.max(2, Math.round(((info.width || 16) * s) / 2) * 2), h: Math.max(2, Math.round(((info.height || 9) * s) / 2) * 2) };
}

function sizeCanvases() {
  const info = S.clip?.info;
  const view = $('#view'), ov = $('#overlay');
  if (store.params.view === 'audio' || !info?.hasVideo) return; // audio view sizes itself
  const { w, h } = previewSize(info);
  S.preview.w = w; S.preview.h = h;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
}

async function loadVideo(clip) {
  const url = clip.proxyUrl || clip.url;
  video.src = url;
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(video.error?.message || 'unsupported')); };
    const cleanup = () => { video.removeEventListener('loadeddata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadeddata', ok);
    video.addEventListener('error', bad);
  });
}

async function activateClip(clip, { quiet = false } = {}) {
  if (video.srcObject) video.srcObject = null; // leaving live camera mode
  S.clip = clip;
  player.stop();
  video.pause();
  renderBin();
  document.body.classList.add('has-media');
  $('#viewport').classList.add('has-media');
  $('#clipTitle').textContent = clip.name;
  $('#btnExportVideo').disabled = !clip.info.hasVideo;
  if (!clip.info.hasVideo && store.params.view !== 'audio') setView('audio');
  store.bindExtra(() => ({ strokes: S.clip?.strokes || [] }), (x) => { if (S.clip && x) S.clip.strokes = x.strokes || []; updateStrokeCount(); });

  try {
    await loadVideo(clip);
  } catch (e) {
    if (!isDesktop) throw new Error(`This browser can't decode ${clip.name}. Try MP4 (H.264) or use the desktop app.`);
    // Chromium can't play this codec (ProRes, DNx, some HEVC…): build an H.264 preview proxy.
    busy('Building preview proxy…', 0);
    const off = native.onProxyProgress(({ f }) => busy('Building preview proxy…', f));
    try {
      const proxy = await native.makeProxy(clip.path);
      clip.proxyUrl = `app://media/${encodeURIComponent(proxy)}`;
      await loadVideo(clip);
    } finally { off(); busy(false); }
  }
  matte.reset();
  sizeCanvases();
  requestPreview();
  updateRangeLabel();
  updateStrokeCount();

  S.audio = { stats: null, vad: null, rawPeaks: null, wetPeaks: null, wet: null, job: 0 };
  player.clear();
  $('#audioStats').textContent = clip.info.hasAudio ? 'Decoding audio…' : 'This clip has no audio track.';
  $('#hudNoise').textContent = clip.info.hasAudio ? 'NOISE —' : 'NO AUDIO';
  $('#hudVoice').textContent = 'VOICE —';
  if (clip.info.hasAudio) {
    if (!quiet) busy('Decoding audio…');
    try {
      const chans = clip.channels || (clip.channels = await decodeAudio(clip));
      player.setRaw(chans);
      S.audio.rawPeaks = peaks(chans[0], 1200);
      await audio.ready;
      await audio.setSource(chans);
      await processAudio(true);
    } catch (e) {
      fail(new Error(`Audio: ${e.message}`));
    } finally { busy(false); }
  }
}

/* ───────────────────────── audio processing ───────────────────────── */

let audioTimer = 0;
function scheduleAudio() {
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => processAudio().catch(fail), 220);
}

const STAGE = { prefilter: 'Filtering', neural: 'Neural denoise', spectral: 'Spectral cleanup', finish: 'Finishing' };
audio.onProgress = (m) => {
  $('#hudVoice').textContent = `${STAGE[m.stage] || m.stage}… ${m.frac ? Math.round(m.frac * 100) + '%' : ''}`.toUpperCase();
};

async function processAudio(first = false) {
  if (!S.clip?.info.hasAudio || !S.clip.channels) return;
  const clip = S.clip;
  const r = await audio.process(store.audio());
  if (!r || clip !== S.clip) return; // superseded
  const wet = r.channels.map((b) => new Float32Array(b));
  S.audio.wet = wet;
  S.audio.vad = new Float32Array(r.vad);
  S.audio.stats = r.stats;
  S.audio.wetPeaks = peaks(wet[0], 1200);
  player.setWet(wet);
  renderAudioStats();
  if (first) toast(`Voice isolated — noise floor down ${r.stats.noiseReduction.toFixed(1)} dB`);
}

const fmtDb = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}` : '—');
function renderAudioStats() {
  const s = S.audio.stats;
  if (!s) return;
  $('#hudNoise').textContent = `NOISE −${fmtDb(s.noiseReduction)} dB`;
  $('#hudVoice').textContent = `VOICE ${fmtDb(s.lufs)} LUFS · SNR ${fmtDb(s.snrIn)}→${fmtDb(s.snrOut)} dB`;
  $('#humLabel').textContent = s.humHz ? `HUM ${s.humHz} HZ NOTCHED` : 'NO HUM';
  $('#audioStats').textContent =
    `Noise floor  ${fmtDb(s.noiseFloorIn)} → ${fmtDb(s.noiseFloorOut)} dBFS\n` +
    `Reduction    −${fmtDb(s.noiseReduction)} dB\n` +
    `Speech SNR   ${fmtDb(s.snrIn)} → ${fmtDb(s.snrOut)} dB\n` +
    `Loudness     ${fmtDb(s.lufs)} LUFS (${s.gainDb >= 0 ? '+' : ''}${fmtDb(s.gainDb)} dB)\n` +
    `Speech       ${Math.round(s.speechRatio * 100)}% of clip`;
}

/* ───────────────────────── preview ───────────────────────── */

function requestPreview() { S.preview.dirty = true; pump(); }

function activeStrokes() {
  const strokes = S.clip?.strokes || [];
  return S.painting ? [...strokes, S.painting] : strokes;
}

async function pump() {
  const P = S.preview;
  const clip = S.clip;
  if (P.busy || !P.dirty || !clip?.info.hasVideo || video.readyState < 2) return;
  const view = store.params.view;
  if (view === 'audio') return;
  P.dirty = false;
  const g = $('#view').getContext('2d');
  // Untouched source: RAW hold or audio-only engine. No need to involve the worker.
  if (S.bypass || store.params.engine === 'off') {
    sizeCanvases();
    g.clearRect(0, 0, P.w, P.h);
    g.drawImage(video, 0, 0, P.w, P.h);
    countFrame();
    if (!video.paused) P.dirty = true;
    return;
  }
  P.busy = true;
  try {
    sizeCanvases();
    const bitmap = await createImageBitmap(video, { resizeWidth: P.w, resizeHeight: P.h, resizeQuality: 'medium' });
    const params = { ...store.matte(), view: view === 'overlay' && S.posterLook ? 'contour' : view };
    const r = await matte.frame({ bitmap, w: P.w, h: P.h, params, t: video.currentTime, strokes: activeStrokes(), mode: 'preview' }, [bitmap]);
    if (clip === S.clip && !S.bypass && store.params.view !== 'audio') {
      g.clearRect(0, 0, P.w, P.h);
      g.drawImage(r.bitmap, 0, 0);
    }
    r.bitmap.close();
    S.lastStats = r.stats;
    countFrame();
    const st = r.stats;
    if (st.backend && st.backend !== 'cpu' && st.backend !== S.backend) showBackend(st.backend);
    $('#hudEngine').textContent = `${ENGINE_LABEL[store.params.engine]} · ${(st.backend || 'cpu').toUpperCase()} · ${Math.round(st.totalMs)} MS`;
    if (st.key) $('#keySwatch').style.background = `rgb(${st.key.join(',')})`;
  } catch (e) {
    fail(e);
  } finally {
    P.busy = false;
    drawOverlay();
    if (!video.paused) P.dirty = true;
    if (P.dirty) requestAnimationFrame(pump);
  }
}

function countFrame() {
  const P = S.preview;
  if (video.paused) { $('#telFps').textContent = '— FPS'; P.frames = 0; P.fpsT = performance.now(); return; }
  P.frames++;
  const now = performance.now();
  if (now - P.fpsT > 600) {
    P.fps = (P.frames * 1000) / (now - P.fpsT);
    P.frames = 0; P.fpsT = now;
    $('#telFps').textContent = `${P.fps.toFixed(0)} FPS`;
  }
}

// New decoded frame while playing → process it.
function onVideoFrame() {
  if (!video.paused) { S.preview.dirty = true; pump(); }
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);
}
if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);

/* ───────────────────────── overlay ───────────────────────── */

// Maps a pointer event to canvas pixel coords, accounting for object-fit: contain.
function toCanvas(e) {
  const cv = $('#view');
  const r = cv.getBoundingClientRect();
  const s = Math.min(r.width / cv.width, r.height / cv.height);
  const dw = cv.width * s, dh = cv.height * s;
  const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
  return { x: (e.clientX - ox) / s, y: (e.clientY - oy) / s, scale: s, inside: e.clientX >= ox && e.clientX <= ox + dw && e.clientY >= oy && e.clientY <= oy + dh };
}

function drawOverlay() {
  const ov = $('#overlay');
  const g = ov.getContext('2d');
  g.clearRect(0, 0, ov.width, ov.height);
  if (!S.clip?.info.hasVideo || store.params.view === 'audio') return;
  const W = ov.width, H = ov.height;
  if (S.guides) {
    g.strokeStyle = 'rgba(227,247,50,0.75)';
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    for (const k of [1 / 3, 2 / 3]) {
      g.beginPath(); g.moveTo(W * k, 0); g.lineTo(W * k, H); g.stroke();
      g.beginPath(); g.moveTo(0, H * k); g.lineTo(W, H * k); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);   // title safe
    g.strokeRect(W * 0.035, H * 0.035, W * 0.93, H * 0.93); // action safe
  }
  if (store.params.view === 'split') {
    const x = store.params.splitPos * W;
    const fs = Math.max(10, Math.round(H / 34)), pad = Math.round(fs * 0.5), bh = fs + pad * 2;
    g.fillStyle = '#E3F732';
    g.fillRect(x - 1, 0, 2, H);
    g.font = `${fs}px "IBM Plex Mono", monospace`;
    const label = (text, right) => {
      const w = g.measureText(text).width + pad * 2;
      const bx = right ? x + 6 : x - 6 - w;
      g.fillStyle = '#0D0F12'; g.fillRect(bx, pad * 2, w, bh);
      g.fillStyle = '#E3F732'; g.fillText(text, bx + pad, pad * 2 + pad + fs * 0.85);
    };
    label('RAW', false); label('MATTED', true);
    return;
  }
  // Strokes near the playhead (faint) when the stroke tool is active.
  if (S.tool === 'strokes') {
    const t = video.currentTime, span = spanFromUi(store.params.strokeSpanUi);
    for (const s of S.clip.strokes) {
      if (Number.isFinite(span) && Math.abs(s.t - t) > span) continue;
      drawStroke(g, s, W, H, 0.3);
    }
  }
  if (S.painting) drawStroke(g, S.painting, W, H, 0.55);
  if (S.pointer && S.pointer.inside && !S.picking) {
    const r = S.brushRadius;
    g.lineWidth = 1.5;
    g.strokeStyle = S.brush === 'fg' ? '#E3F732' : '#3D6BFF';
    g.beginPath(); g.arc(S.pointer.x, S.pointer.y, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.beginPath(); g.arc(S.pointer.x, S.pointer.y, r + 1.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = g.strokeStyle = S.brush === 'fg' ? '#E3F732' : '#3D6BFF';
    g.font = 'bold 12px "IBM Plex Mono", monospace';
    g.fillText(S.brush === 'fg' ? '+' : '−', S.pointer.x - 4, S.pointer.y + 4);
  }
}

function drawStroke(g, s, W, H, alpha) {
  g.save();
  g.globalAlpha = alpha;
  g.strokeStyle = g.fillStyle = s.mode === 'fg' ? '#E3F732' : '#0038FF';
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.lineWidth = s.r * H * 2;
  g.beginPath();
  for (let i = 0; i < s.pts.length; i += 2) {
    const x = s.pts[i] * W, y = s.pts[i + 1] * H;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  if (s.pts.length === 2) g.lineTo(s.pts[0] * W + 0.1, s.pts[1] * H);
  g.stroke();
  g.restore();
}

/* ───────────────────────── viewport interaction ───────────────────────── */

const vp = $('#viewport');

function sampleKeyColor(p) {
  const c = new OffscreenCanvas(S.preview.w, S.preview.h).getContext('2d');
  c.drawImage(video, 0, 0, S.preview.w, S.preview.h);
  const x = Math.max(0, Math.min(S.preview.w - 3, Math.round(p.x) - 1)), y = Math.max(0, Math.min(S.preview.h - 3, Math.round(p.y) - 1));
  const d = c.getImageData(x, y, 3, 3).data;
  const avg = [0, 1, 2].map((k) => Math.round((d[k] + d[k + 4] + d[k + 8] + d[k + 12] + d[k + 16] + d[k + 20] + d[k + 24] + d[k + 28] + d[k + 32]) / 9));
  store.set({ keyColor: avg }, { commit: true });
  $('#keySwatch').style.background = `rgb(${avg.join(',')})`;
  toast(`Key colour set to rgb(${avg.join(', ')})`);
}

vp.addEventListener('pointerdown', (e) => {
  if (!S.clip?.info.hasVideo || store.params.view === 'audio' || e.button > 0) return;
  vp.focus({ preventScroll: true });
  const p = toCanvas(e);
  if (!p.inside) return;
  player.ensure();
  if (S.picking) { S.picking = false; vp.classList.remove('tool-pick'); sampleKeyColor(p); return; }
  vp.setPointerCapture(e.pointerId);
  if (store.params.view === 'split') {
    S.dragSplit = true;
    store.set({ splitPos: Math.max(0.02, Math.min(0.98, p.x / S.preview.w)) });
    requestPreview();
    return;
  }
  const mode = e.altKey ? (S.brush === 'fg' ? 'bg' : 'fg') : S.brush;
  S.painting = {
    mode, pts: [p.x / S.preview.w, p.y / S.preview.h],
    r: S.brushRadius / S.preview.h, t: video.currentTime,
    anchor: S.lastStats?.subject?.area > 0 ? { ...S.lastStats.subject } : null,
  };
  requestPreview();
});

vp.addEventListener('pointermove', (e) => {
  const p = toCanvas(e);
  S.pointer = p;
  if (S.dragSplit) {
    store.set({ splitPos: Math.max(0.02, Math.min(0.98, p.x / S.preview.w)) });
    requestPreview();
  } else if (S.painting) {
    const pts = S.painting.pts;
    const lx = pts[pts.length - 2] * S.preview.w, ly = pts[pts.length - 1] * S.preview.h;
    if (Math.hypot(p.x - lx, p.y - ly) > Math.max(2, S.brushRadius * 0.25)) {
      pts.push(Math.max(0, Math.min(1, p.x / S.preview.w)), Math.max(0, Math.min(1, p.y / S.preview.h)));
      requestPreview();
    }
  }
  drawOverlay();
});

function endPointer() {
  if (S.dragSplit) { S.dragSplit = false; return; }
  if (!S.painting) return;
  S.clip.strokes.push(S.painting);
  S.painting = null;
  store.commit();
  updateStrokeCount();
  requestPreview();
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);
vp.addEventListener('pointerleave', () => { S.pointer = null; drawOverlay(); });

vp.addEventListener('wheel', (e) => {
  if (!e.altKey && !e.ctrlKey) return;
  e.preventDefault();
  setBrushRadius(S.brushRadius * (e.deltaY > 0 ? 0.9 : 1.1));
}, { passive: false });

function updateViewportCursor() {
  vp.classList.toggle('tool-split', store.params.view === 'split');
  vp.classList.toggle('tool-pick', S.picking);
  vp.classList.toggle('tool-brush', store.params.view !== 'split' && !S.picking && store.params.view !== 'audio');
}

function setBrushRadius(r) {
  S.brushRadius = Math.max(4, Math.min(80, Math.round(r)));
  $('#brushRadius').value = S.brushRadius;
  drawOverlay();
}

function setBrush(mode) {
  S.brush = mode;
  $('#btnBrushFG').classList.toggle('is-on', mode === 'fg');
  $('#btnBrushBG').classList.toggle('is-on', mode === 'bg');
  drawOverlay();
}

function updateStrokeCount() {
  const n = S.clip?.strokes.length || 0;
  $('#strokeCount').textContent = `${n} STROKE${n === 1 ? '' : 'S'}`;
}

/* drag & drop */
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); vp.classList.add('drop-hot'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) vp.classList.remove('drop-hot'); }));
document.addEventListener('drop', (e) => {
  vp.classList.remove('drop-hot');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) importFiles(files).catch(fail);
});

/* ───────────────────────── timeline ───────────────────────── */

const tl = $('#timelineCanvas');
let tlDrag = null;
function tlTime(e) {
  const r = tl.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (S.clip?.info.duration || 0);
}
function seek(t) {
  if (!S.clip) return;
  video.currentTime = Math.max(0, Math.min(S.clip.info.duration - 0.001, t));
}
tl.addEventListener('pointerdown', (e) => {
  if (!S.clip) return;
  tl.setPointerCapture(e.pointerId);
  const t = tlTime(e), dur = S.clip.info.duration, r = tl.getBoundingClientRect();
  const near = (v) => v != null && Math.abs(((v / dur) - (e.clientX - r.left) / r.width) * r.width) < 6;
  tlDrag = near(S.clip.inPoint) ? 'in' : near(S.clip.outPoint) ? 'out' : 'seek';
  if (tlDrag === 'seek') seek(t);
});
tl.addEventListener('pointermove', (e) => {
  if (!tlDrag || !S.clip) return;
  const t = tlTime(e);
  if (tlDrag === 'seek') seek(t);
  else if (tlDrag === 'in') S.clip.inPoint = Math.min(t, (S.clip.outPoint ?? Infinity) - 0.05);
  else S.clip.outPoint = Math.max(t, (S.clip.inPoint ?? 0) + 0.05);
  updateRangeLabel();
});
tl.addEventListener('pointerup', () => { tlDrag = null; });
tl.addEventListener('dblclick', () => { if (S.clip) { S.clip.inPoint = S.clip.outPoint = null; updateRangeLabel(); } });

function updateRangeLabel() {
  const c = S.clip;
  if (!c || (c.inPoint == null && c.outPoint == null)) { $('#exportRangeLabel').textContent = 'FULL CLIP'; return; }
  const { start, end } = exportRange(c);
  $('#exportRangeLabel').textContent = `${fmtTime(start)}–${fmtTime(end)} (${(end - start).toFixed(1)} S)`;
}

/* ───────────────────────── transport ───────────────────────── */

function play() {
  if (!S.clip) return;
  player.ensure();
  const { start, end } = exportRange(S.clip);
  if (video.currentTime >= end - 0.05 || video.currentTime < start - 0.05) video.currentTime = start;
  video.play().catch(fail);
}
function pause() { video.pause(); }
function togglePlay() { video.paused ? play() : pause(); }

video.addEventListener('play', () => { player.play(video.currentTime); $('#btnPlay').textContent = 'Pause'; $('#hudPing').classList.add('live'); requestPreview(); });
video.addEventListener('pause', () => { player.stop(); $('#btnPlay').textContent = 'Play'; $('#hudPing').classList.remove('live'); requestPreview(); });
video.addEventListener('seeked', () => { if (!video.paused) player.play(video.currentTime); else player.startPos = video.currentTime; requestPreview(); });
video.addEventListener('ended', () => { player.stop(); });

function step(dir) {
  if (!S.clip) return;
  pause();
  seek(video.currentTime + dir / (S.clip.info.fps || 30));
}

function setBypass(on) {
  if (S.bypass === on) return;
  S.bypass = on;
  player.setBypass(on);
  $('#btnRaw').classList.toggle('is-held', on);
  requestPreview();
}

/* ───────────────────────── render loop ───────────────────────── */

function timecode(t, fps) {
  const f = Math.floor((t % 1) * fps);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  return [h, m, s, f].map((v) => String(v).padStart(2, '0')).join(':');
}

function tick() {
  const c = S.clip;
  if (c) {
    const t = video.currentTime;
    const fps = c.info.fps || 30;
    $('#timecode').textContent = `${timecode(t, fps)} / ${timecode(c.info.duration, fps)}`;
    // Keep audio locked to the video clock.
    if (!video.paused && player.playing && Math.abs(player.position() - t) > 0.06) player.play(t);
    // Respect the out point while playing.
    const { end } = exportRange(c);
    if (!video.paused && c.outPoint != null && t >= end) { pause(); seek(c.inPoint ?? 0); }
    drawTimeline(tl, {
      duration: c.info.duration, time: t, inPoint: c.inPoint, outPoint: c.outPoint, vad: S.audio.vad,
      rawPeaks: S.audio.rawPeaks, wetPeaks: S.bypass ? null : S.audio.wetPeaks, strokeTimes: c.strokes.map((s) => s.t),
    });
    drawSpectrum($('#spectrum'), player, S.bypass);
    if (store.params.view === 'audio') {
      const s = S.audio.stats;
      drawAudioView($('#view'), {
        duration: c.info.duration, time: t, vad: S.audio.vad, rawPeaks: S.audio.rawPeaks,
        wetPeaks: S.bypass ? null : S.audio.wetPeaks, title: `${c.name.toUpperCase()} · ${S.bypass ? 'RAW' : 'ISOLATED'}`,
        statsLine: s ? `NOISE −${fmtDb(s.noiseReduction)} dB · SNR ${fmtDb(s.snrIn)} → ${fmtDb(s.snrOut)} dB · ${fmtDb(s.lufs)} LUFS · HUM ${s.humHz ? s.humHz + ' Hz' : 'none'}` : 'Processing…',
      });
    }
  }
  requestAnimationFrame(tick);
}

/* ───────────────────────── controls ───────────────────────── */

function setView(view) {
  store.set({ view });
  $$('.form-btn').forEach((b) => { const on = b.dataset.view === view; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', on); });
  if (view !== 'audio') sizeCanvases();
  updateViewportCursor();
  requestPreview();
  drawOverlay();
}

function setTool(tool) {
  S.tool = tool;
  $$('.tool-row').forEach((r) => { const on = r.dataset.tool === tool; r.classList.toggle('is-active', on); r.setAttribute('aria-selected', on); });
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tool));
  drawOverlay();
}

function setEngine(engine, { commit = true } = {}) {
  store.set({ engine }, { commit });
}

function syncEngineUi() {
  const e = store.params.engine;
  $$('.matrix-cell').forEach((c) => { const on = c.dataset.engine === e; c.classList.toggle('is-active', on); c.setAttribute('aria-checked', on); });
  $('#engineTag').textContent = ENGINE_LABEL[e];
  $('#engineBadge').textContent = e === 'off' ? 'VOICE ISOLATE ONLY' : `${ENGINE_LABEL[e]} + VOICE ISOLATE`;
  $('.chroma-only').hidden = e !== 'chroma';
  if (store.params.keyColor) $('#keySwatch').style.background = `rgb(${store.params.keyColor.join(',')})`;
}

function syncQualityUi() {
  $$('[data-quality]').forEach((b) => b.classList.toggle('is-on', b.dataset.quality === store.params.quality));
  $('#qualityLabel').textContent = store.params.quality.toUpperCase();
}

function syncBackdropUi() {
  const p = store.params;
  $$('[data-backdrop]').forEach((b) => b.classList.toggle('is-on', b.dataset.backdrop === p.backdrop && (p.backdrop !== 'color' || b.dataset.color?.toLowerCase() === p.backdropColor.toLowerCase())));
  $('#backdropColor').value = p.backdropColor;
  $('#backdropLabel').textContent = p.backdrop === 'color' ? p.backdropColor.toUpperCase() : p.backdrop.toUpperCase();
}

function syncArc() {
  const s = store.params.strength;
  $('#arcValue').textContent = `${s}°`;
  $('#arc').setAttribute('aria-valuenow', s);
  const norm = Math.max(0.08, Math.min(0.92, s / 100));
  const centre = Math.PI * (0.85 - norm * 0.7), span = 0.16;
  const pt = (a) => `${(210 + 185 * Math.cos(a)).toFixed(1)} ${(16 + 66 * Math.sin(a)).toFixed(1)}`;
  $('#arcThumb').setAttribute('d', `M ${pt(centre + span)} A 185 66 0 0 0 ${pt(centre - span)}`);
}

function syncSelects() {
  $$('[data-audio-select]').forEach((sel) => {
    const v = store.params[sel.dataset.audioSelect];
    sel.value = v === null ? 'off' : String(v);
  });
  $('#trackStrokes').checked = store.params.trackStrokes;
}

let sliders;
function syncAllControls() {
  sliders?.syncAll();
  syncEngineUi();
  syncQualityUi();
  syncBackdropUi();
  syncArc();
  syncSelects();
}

sliders = buildSliders(document, store, {
  defaults: DEFAULTS,
  formatters: { span: (v) => { const s = spanFromUi(v); return s === Infinity ? 'Whole clip' : s === 0 ? 'This frame' : `±${s} s`; } },
  onInput: (key, v) => store.set({ [key]: v }),
  onCommit: () => store.commit(),
});

store.addEventListener('change', (e) => {
  const { keys, audio: audioChanged, restored } = e.detail;
  if (restored || keys.includes('engine')) {
    syncEngineUi();
    const eng = store.params.engine;
    if (eng === 'rvm' || eng === 'modnet') {
      setStatus('Loading model…', 'warn');
      matte.warmup(eng).then(showBackend).catch(fail);
    }
  }
  if (restored || keys.includes('quality')) { syncQualityUi(); sizeCanvases(); }
  if (restored || keys.some((k) => k.startsWith('backdrop'))) syncBackdropUi();
  if (keys.includes('strength')) syncArc();
  if (restored) { syncAllControls(); updateStrokeCount(); }
  if (audioChanged) scheduleAudio();
  if (keys.some((k) => !AUDIO_KEYS.includes(k))) requestPreview();
});

// Views
$$('.form-btn').forEach((b) => b.addEventListener('click', (e) => {
  S.posterLook = b.dataset.view === 'overlay' && e.altKey;
  setView(b.dataset.view);
}));
// Tools
$$('.tool-row').forEach((r) => r.addEventListener('click', () => setTool(r.dataset.tool)));
// Engine matrix
$$('.matrix-cell').forEach((c) => c.addEventListener('click', () => setEngine(c.dataset.engine)));
// Quality
$$('[data-quality]').forEach((b) => b.addEventListener('click', () => store.set({ quality: b.dataset.quality }, { commit: true })));
// Selects
$$('[data-audio-select]').forEach((sel) => sel.addEventListener('change', () => {
  const k = sel.dataset.audioSelect;
  store.set({ [k]: sel.value === 'off' ? (k === 'loudness' ? null : 'off') : (k === 'loudness' ? Number(sel.value) : sel.value) }, { commit: true });
}));
$('#trackStrokes').addEventListener('change', (e) => store.set({ trackStrokes: e.target.checked }, { commit: true }));
// Chroma key
$('#btnPickKey').onclick = () => { S.picking = true; updateViewportCursor(); toast('Click the screen colour in the viewer'); };
$('#btnAutoKey').onclick = () => { store.set({ keyColor: null }, { commit: true }); matte.reset(); };
// Backdrop
$$('[data-backdrop]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.backdrop === 'image') return $('#backdropInput').click();
  store.set({ backdrop: b.dataset.backdrop, ...(b.dataset.color ? { backdropColor: b.dataset.color } : {}) }, { commit: true });
}));
$('#backdropColor').addEventListener('input', (e) => store.set({ backdrop: 'color', backdropColor: e.target.value }));
$('#backdropColor').addEventListener('change', () => store.commit());
$('#backdropInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const bmp = await createImageBitmap(f);
  matte.setBackdrop(bmp);
  S.backdropFile = f;
  store.set({ backdrop: 'image' }, { commit: true });
  e.target.value = '';
});
$('#btnPoster').onclick = () => { S.posterLook = true; setView('overlay'); };
// Strokes
$('#btnClearStrokes').onclick = () => { if (S.clip) { S.clip.strokes = []; store.commit(); updateStrokeCount(); requestPreview(); } };
$('#btnClearFrameStrokes').onclick = () => {
  if (!S.clip) return;
  const t = video.currentTime, span = spanFromUi(store.params.strokeSpanUi);
  const win = Number.isFinite(span) ? Math.max(0.1, span) : Infinity;
  S.clip.strokes = S.clip.strokes.filter((s) => Math.abs(s.t - t) > win);
  store.commit(); updateStrokeCount(); requestPreview();
};
// Presets
function buildPresetSelect() {
  const sel = $('#presetSelect');
  sel.innerHTML = '<option value="">Presets…</option>';
  for (const [group, names] of [['Built-in', Object.keys(store.allPresets()).filter((n) => !store.userPresets[n])], ['Yours', Object.keys(store.userPresets)]]) {
    if (!names.length) continue;
    const og = document.createElement('optgroup');
    og.label = group;
    for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; og.appendChild(o); }
    sel.appendChild(og);
  }
}
$('#presetSelect').addEventListener('change', (e) => {
  if (!e.target.value) return;
  store.applyPreset(e.target.value);
  toast(`Preset “${e.target.value}” applied`);
  e.target.value = '';
});
$('#btnSavePreset').onclick = () => {
  const name = prompt('Preset name', 'My preset');
  if (!name) return;
  store.savePreset(name.trim());
  buildPresetSelect();
  toast(`Saved preset “${name.trim()}”`);
};
$('#btnReset').onclick = () => { store.reset(); toast('All settings reset', { action: 'Undo', onAction: () => store.undo() }); };

// Orbital arc (Isolation Strength macro)
const arc = $('#arc');
let arcDrag = false;
function arcFrom(e) {
  const r = arc.getBoundingClientRect();
  const s = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - r.width * 0.07) / (r.width * 0.86))) * 100);
  store.set(strengthMap(s));
  syncArc(); sliders.syncAll();
}
arc.addEventListener('pointerdown', (e) => { arcDrag = true; arc.setPointerCapture(e.pointerId); arcFrom(e); });
arc.addEventListener('pointermove', (e) => { if (arcDrag) arcFrom(e); });
arc.addEventListener('pointerup', () => { arcDrag = false; store.commit(); });
arc.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  store.set(strengthMap(Math.max(0, Math.min(100, store.params.strength + d))), { commit: true });
  syncArc(); sliders.syncAll();
});

// Toolbar
$('#btnPlay').onclick = togglePlay;
$('#btnStepBack').onclick = () => step(-1);
$('#btnStepFwd').onclick = () => step(1);
$('#btnMute').onclick = () => { player.setMuted(!player.muted); $('#btnMute').textContent = player.muted ? '🔇' : '🔊'; };
$('#btnBrushFG').onclick = () => setBrush('fg');
$('#btnBrushBG').onclick = () => setBrush('bg');
$('#btnUndo').onclick = () => { if (!store.undo()) toast('Nothing to undo'); };
$('#brushRadius').addEventListener('input', (e) => setBrushRadius(Number(e.target.value)));
$('#btnGuides').onclick = () => { S.guides = !S.guides; $('#btnGuides').setAttribute('aria-pressed', S.guides); drawOverlay(); };
const raw = $('#btnRaw');
raw.addEventListener('pointerdown', () => setBypass(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => raw.addEventListener(t, () => setBypass(false)));
$('#btnCollapseReel').onclick = () => {
  const hide = !$('#reelList').hidden;
  $('#reelList').hidden = hide; $('#reelActions').hidden = hide;
  $('#btnCollapseReel').textContent = hide ? 'Show' : 'Hide';
  $('#btnCollapseReel').setAttribute('aria-expanded', !hide);
};
$('#btnImport').onclick = $('#btnEmptyImport').onclick = () => pickMedia().catch(fail);
$('#fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]).catch(fail); e.target.value = ''; });

/* ───────────────────────── export ───────────────────────── */

function buildFormatList() {
  const list = $('#formatList');
  list.innerHTML = '';
  for (const [k, f] of Object.entries(S.info.formats)) {
    const b = document.createElement('button');
    b.className = `format${k === S.exportFormat ? ' is-on' : ''}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', k === S.exportFormat);
    b.innerHTML = `<span></span>${f.alpha ? '<span class="badge">ALPHA</span>' : ''}`;
    b.firstChild.textContent = f.label;
    b.onclick = () => { S.exportFormat = k; ui.set('exportFormat', k); buildFormatList(); };
    list.appendChild(b);
  }
  const f = S.info.formats[S.exportFormat];
  $('#telFormat').textContent = `Format: ${f?.label.split(' (')[0] || '—'}`;
}

const dlg = $('#exportDialog');
function exportProgress(p) {
  $('#exportStage').textContent = p.stage;
  $('#exportBar').style.width = `${Math.round((p.f || 0) * 100)}%`;
  native?.setProgress(p.f ?? -1);
  if (p.eta != null) $('#exportEta').textContent = `${p.fps.toFixed(1)} fps · ${Math.ceil(p.eta)} s left`;
}

async function runExport(kind, clips = [S.clip]) {
  if (!clips[0]) return toast('Import a clip first', { kind: 'err' });
  if (S.exporting) return;
  S.exporting = true;
  pause();
  $('#exportTitle').textContent = kind === 'audio' ? 'EXPORTING AUDIO' : 'EXPORTING VIDEO';
  $('#btnExportReveal').hidden = true;
  $('#btnExportCancel').textContent = 'Cancel';
  $('#exportEta').textContent = '—';
  exportProgress({ stage: 'Preparing…', f: 0 });
  dlg.showModal();
  let last = null, dir = null;
  try {
    for (const clip of clips) {
      if (clips.length > 1) $('#exportTitle').textContent = `EXPORTING ${clips.indexOf(clip) + 1} / ${clips.length}`;
      if (clip !== S.clip) await activateClip(clip, { quiet: true });
      if (kind === 'audio' || !clip.info.hasVideo) {
        last = await exporter.exportAudio(clip, $('#exportAudioFmt').value);
      } else {
        let out = null;
        // Batch: ask for a folder once, then name files automatically.
        if (clips.length > 1 && isDesktop) {
          if (!dir) { dir = await native.saveDialog({ defaultName: '', directory: true }); if (!dir) break; }
          const fmt = S.info.formats[S.exportFormat];
          out = `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'}${clip.name.replace(/\.[^.]+$/, '')}_removeless${fmt.ext ? `.${fmt.ext}` : '_frames'}`;
        }
        last = await exporter.exportVideo(clip, S.exportFormat, Number($('#exportScale').value), out);
      }
      if (!last) break;
      clip.exported = true;
    }
    if (last) {
      exportProgress({ stage: `Saved ${last.path.split(/[\\/]/).pop()}`, f: 1 });
      $('#btnExportCancel').textContent = 'Done';
      if (isDesktop) { $('#btnExportReveal').hidden = false; $('#btnExportReveal').onclick = () => native.reveal(last.path); }
      toast(`Exported ${last.path.split(/[\\/]/).pop()}`, isDesktop ? { action: 'Show', onAction: () => native.reveal(last.path) } : {});
    } else dlg.close();
  } catch (e) {
    dlg.close();
    fail(e);
  } finally {
    S.exporting = false;
    native?.setProgress(-1);
    renderBin();
  }
}
$('#btnExportCancel').onclick = () => { if (S.exporting) exporter.cancel(); else dlg.close(); };
dlg.addEventListener('cancel', (e) => { if (S.exporting) { e.preventDefault(); exporter.cancel(); } });
$('#btnExportTop').onclick = $('#btnExportVideo').onclick = $('#btnExportPanel').onclick = () => runExport(S.clip?.info.hasVideo ? 'video' : 'audio');
$('#btnExportAudio').onclick = () => runExport('audio');
$('#btnExportAll').onclick = () => runExport('video', S.clips.slice());

/* ───────────────────────── camera ───────────────────────── */

async function toggleCamera() {
  if (S.camera) {
    S.camera.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12e6 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      S.camera = null;
      $('#cameraLabel').textContent = '● Record camera';
      const ext = (recorder.mimeType || mime).includes('mp4') ? 'mp4' : 'webm';
      const file = new File(chunks, `Camera ${new Date().toLocaleTimeString().replace(/:/g, '-')}.${ext}`, { type: recorder.mimeType || mime });
      await importFiles([file]);
    };
    recorder.start(1000);
    S.camera = { recorder, stream };
    $('#cameraLabel').textContent = '■ Stop recording';
    // Live preview through the matte engine while recording.
    video.srcObject = stream;
    await video.play();
    document.body.classList.add('has-media');
    vp.classList.add('has-media');
    $('#clipTitle').textContent = 'Camera (recording)';
    S.clip = { id: -1, name: 'Camera', info: { hasVideo: true, hasAudio: false, width: video.videoWidth, height: video.videoHeight, duration: Infinity, fps: 30 }, strokes: [] };
    sizeCanvases();
    toast('Recording — the clip lands in your bin when you stop');
  } catch (e) {
    fail(new Error(`Camera unavailable: ${e.message}`));
  }
}
$('#btnCamera').onclick = $('#btnEmptyCamera').onclick = () => toggleCamera();

/* ───────────────────────── projects ───────────────────────── */

async function saveProject() {
  const { view, splitPos, ...params } = store.params;
  const doc = {
    app: 'removeless', version: 1, params,
    clips: S.clips.map((c) => ({ path: c.path || null, name: c.name, strokes: c.strokes, inPoint: c.inPoint, outPoint: c.outPoint })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  const out = await saveBytes('Untitled.removeless', bytes, [{ name: 'Removeless Project', extensions: ['removeless'] }], 'application/json');
  if (out) toast(`Project saved${isDesktop ? '' : ' (re-import media when reopening in the browser)'}`);
}

async function openProject(doc) {
  if (!doc) return;
  if (doc.app !== 'removeless') throw new Error('Not a Removeless project');
  store.set({ ...doc.params }, { commit: true });
  syncAllControls();
  if (!isDesktop) { toast('Settings loaded. Import the media files to continue.'); return; }
  for (const c of doc.clips) {
    if (!c.path) continue;
    try {
      const clip = await clipFromPath(c.path);
      Object.assign(clip, { strokes: c.strokes || [], inPoint: c.inPoint, outPoint: c.outPoint });
      S.clips.push(clip);
    } catch { toast(`Missing media: ${c.name}`, { kind: 'err' }); }
  }
  renderBin();
  if (S.clips.length) await activateClip(S.clips[S.clips.length - doc.clips.length] || S.clips[0]);
}

/* ───────────────────────── shortcuts ───────────────────────── */

const SHORTCUTS = [
  ['Space', 'Play / pause'], ['← / →', 'Previous / next frame'], ['⇧← / ⇧→', 'Jump 1 second'],
  ['I / O', 'Set in / out point'], ['Double-click timeline', 'Clear range'],
  ['\\ (hold)', 'Compare with raw source'], ['1 – 5', 'Composite · Alpha · Overlay · Audio · Split'],
  ['R E V B D X', 'Roto · Edge · Voice · Strokes · Backdrop · Export'],
  ['F / C', '+FG keep brush / −BG cut brush'], ['Alt-drag', 'Paint with the opposite brush'],
  ['[ / ]', 'Brush smaller / larger'], ['G', 'Safe-area guides'], ['M', 'Mute monitoring'],
  [`${MOD}Z / ${MOD}⇧Z`, 'Undo / redo'], [`${MOD}O`, 'Import media'], [`${MOD}S`, 'Save project'],
  [`${MOD}E / ${MOD}⇧E`, 'Export video / audio'], ['?', 'This list'],
];
$('#shortcutGrid').innerHTML = SHORTCUTS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('');
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#btnShortcuts').onclick = () => $('#shortcutsDialog').showModal();
$('#btnAbout').onclick = () => $('#aboutDialog').showModal();

function handleAction(a) {
  const actions = {
    import: () => pickMedia(),
    'open-project': async () => openProject(await native.openProjectDialog()),
    'save-project': () => saveProject(),
    export: () => runExport(S.clip?.info.hasVideo ? 'video' : 'audio'),
    'export-audio': () => runExport('audio'),
    undo: () => store.undo(),
    redo: () => store.redo(),
    shortcuts: () => $('#shortcutsDialog').showModal(),
    about: () => $('#aboutDialog').showModal(),
  };
  if (a.startsWith('view:')) return setView(a.slice(5));
  return actions[a]?.();
}

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(e.target.type)) || tag === 'SELECT' || tag === 'TEXTAREA';
  if (document.querySelector('dialog[open]') || typing) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod) {
    // On desktop the native menu owns these accelerators.
    if (isDesktop) return;
    const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', o: 'import', s: 'save-project', e: e.shiftKey ? 'export-audio' : 'export' };
    if (map[k]) { e.preventDefault(); handleAction(map[k])?.catch?.(fail); }
    return;
  }
  if (tag === 'INPUT' && e.target.type === 'range' && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) return;
  const views = ['composite', 'alpha', 'overlay', 'audio', 'split'];
  const tools = { r: 'roto', e: 'edge', v: 'voice', b: 'strokes', d: 'backdrop', x: 'export' };
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowleft') { e.preventDefault(); e.shiftKey ? seek(video.currentTime - 1) : step(-1); }
  else if (k === 'arrowright') { e.preventDefault(); e.shiftKey ? seek(video.currentTime + 1) : step(1); }
  else if (k === 'i' && S.clip) { S.clip.inPoint = Math.min(video.currentTime, (S.clip.outPoint ?? Infinity) - 0.05); updateRangeLabel(); }
  else if (k === 'o' && S.clip) { S.clip.outPoint = Math.max(video.currentTime, (S.clip.inPoint ?? 0) + 0.05); updateRangeLabel(); }
  else if (k === '\\') { e.preventDefault(); setBypass(true); }
  else if (/^[1-5]$/.test(k)) setView(views[Number(k) - 1]);
  else if (tools[k]) setTool(tools[k]);
  else if (k === 'f') setBrush('fg');
  else if (k === 'c') setBrush('bg');
  else if (k === '[') setBrushRadius(S.brushRadius * 0.85);
  else if (k === ']') setBrushRadius(S.brushRadius * 1.15);
  else if (k === 'g') $('#btnGuides').click();
  else if (k === 'm') $('#btnMute').click();
  else if (k === '?' || (k === '/' && e.shiftKey)) $('#shortcutsDialog').showModal();
});
document.addEventListener('keyup', (e) => { if (e.key === '\\') setBypass(false); });
window.addEventListener('resize', () => drawOverlay());

if (native) {
  native.onMenu((a) => Promise.resolve(handleAction(a)).catch(fail));
  native.onOpenFiles((paths) => importPaths(paths).catch(fail));
} else if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

setBrushRadius(S.brushRadius);
updateViewportCursor();
boot().catch(fail);

// Desktop self-test hook (REMOVELESS_SELFTEST env var); inert otherwise.
appInfo().then((info) => {
  if (!info.selftest) return;
  const waitFor = (fn, ms = 120000) => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const poll = () => { const v = fn(); if (v) return resolve(v); if (performance.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(poll, 100); };
    poll();
  });
  import('./selftest.js').then(({ runSelfTest }) => runSelfTest({ native, cfg: info.selftest, importPaths, S, setView, waitFor, exporter, store }));
});

// `?debug` exposes internals for scripted smoke tests of the web build.
if (new URLSearchParams(location.search).has('debug')) {
  window.__removeless = { S, store, importFiles, setView, exporter, get matte() { return matte; } };
}
