// Timeline (waveform + VAD + in/out + playhead) and the large Audio view.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Min/max envelope of a channel at `cols` columns.
export function peaks(ch, cols) {
  const out = new Float32Array(cols * 2);
  const step = ch.length / cols;
  for (let c = 0; c < cols; c++) {
    let lo = 0, hi = 0;
    const a = Math.floor(c * step), b = Math.min(ch.length, Math.floor((c + 1) * step));
    for (let i = a; i < b; i += 4) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[c * 2] = lo; out[c * 2 + 1] = hi;
  }
  return out;
}

function fitCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h, dpr };
}

export function drawTimeline(cv, s) {
  const { w, h, dpr } = fitCanvas(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const dur = s.duration || 0;
  if (!dur) return;
  const x = (t) => (t / dur) * w;
  const mid = h / 2;

  if (s.vad) {
    g.fillStyle = 'rgba(227,247,50,0.18)';
    const fps = 100; // VAD frames are 10 ms
    for (let i = 0; i < s.vad.length; i++) {
      if (s.vad[i] > 0.5) g.fillRect(x(i / fps), 0, Math.max(1, w / (dur * fps)), h);
    }
  }
  const drawPeaks = (pk, color, scale) => {
    if (!pk) return;
    g.fillStyle = color;
    const cols = pk.length / 2;
    for (let c = 0; c < cols; c++) {
      const lo = pk[c * 2] * scale, hi = pk[c * 2 + 1] * scale;
      g.fillRect((c / cols) * w, mid - hi * mid, Math.max(1, w / cols), Math.max(1, (hi - lo) * mid));
    }
  };
  drawPeaks(s.rawPeaks, 'rgba(0,56,255,0.35)', 0.95);
  drawPeaks(s.wetPeaks, css('--ink'), 0.95);

  if (s.inPoint != null || s.outPoint != null) {
    const a = x(s.inPoint ?? 0), b = x(s.outPoint ?? dur);
    g.fillStyle = 'rgba(13,15,18,0.28)';
    g.fillRect(0, 0, a, h); g.fillRect(b, 0, w - b, h);
    g.fillStyle = '#E3F732';
    g.fillRect(a - dpr, 0, 2 * dpr, h); g.fillRect(b - dpr, 0, 2 * dpr, h);
  }
  // Stroke markers (where hints were painted).
  if (s.strokeTimes?.length) {
    g.fillStyle = '#0038FF';
    for (const t of s.strokeTimes) g.fillRect(x(t) - dpr, h - 5 * dpr, 2 * dpr, 5 * dpr);
  }
  const px = x(s.time);
  g.fillStyle = css('--ink');
  g.fillRect(px - dpr, 0, 2 * dpr, h);
  g.beginPath(); g.moveTo(px - 5 * dpr, 0); g.lineTo(px + 5 * dpr, 0); g.lineTo(px, 6 * dpr); g.fill();
}

export function drawAudioView(cv, s) {
  const { w, h, dpr } = fitCanvas(cv);
  const g = cv.getContext('2d');
  g.fillStyle = '#0D0F12';
  g.fillRect(0, 0, w, h);
  const dur = s.duration || 1;
  const lane = (h - 70 * dpr) / 2;
  const top = 34 * dpr;
  const draw = (pk, y0, color, label) => {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, y0, w, lane - 6 * dpr);
    g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText(label, 10 * dpr, y0 + 14 * dpr);
    if (!pk) return;
    const m = y0 + (lane - 6 * dpr) / 2, amp = (lane - 10 * dpr) / 2;
    g.fillStyle = color;
    const cols = pk.length / 2;
    for (let c = 0; c < cols; c++) {
      const lo = pk[c * 2], hi = pk[c * 2 + 1];
      g.fillRect((c / cols) * w, m - hi * amp, Math.max(1, w / cols), Math.max(1, (hi - lo) * amp));
    }
  };
  if (s.vad) {
    g.fillStyle = 'rgba(227,247,50,0.08)';
    for (let i = 0; i < s.vad.length; i++) if (s.vad[i] > 0.5) g.fillRect((i / 100 / dur) * w, top, Math.max(1, w / (dur * 100)), lane * 2);
  }
  draw(s.rawPeaks, top, '#3D6BFF', 'SOURCE');
  draw(s.wetPeaks, top + lane, '#E3F732', 'ISOLATED VOICE');
  g.fillStyle = '#fff';
  g.fillRect((s.time / dur) * w - dpr, top, 2 * dpr, lane * 2);
  g.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
  g.fillStyle = '#E3F732';
  g.fillText(s.title || 'AUDIO', 10 * dpr, 20 * dpr);
  if (s.statsLine) {
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(s.statsLine, 10 * dpr, h - 44 * dpr);
  }
}

export function drawSpectrum(cv, player, bypass) {
  const { w, h } = fitCanvas(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!player.ctx || !player.playing) return;
  const bars = 64, bw = w / bars;
  const raw = new Uint8Array(player.anRaw.frequencyBinCount);
  const wet = new Uint8Array(player.anWet.frequencyBinCount);
  player.anRaw.getByteFrequencyData(raw);
  player.anWet.getByteFrequencyData(wet);
  // Log-spaced bands from 60 Hz to 16 kHz.
  const bin = (f) => Math.min(raw.length - 1, Math.round((f / 24000) * raw.length));
  for (let b = 0; b < bars; b++) {
    const f0 = 60 * Math.pow(16000 / 60, b / bars), f1 = 60 * Math.pow(16000 / 60, (b + 1) / bars);
    let r = 0, v = 0, n = 0;
    for (let k = bin(f0); k <= Math.max(bin(f0), bin(f1)); k++) { r += raw[k]; v += wet[k]; n++; }
    r /= n * 255; v /= n * 255;
    g.fillStyle = bypass ? 'rgba(255,80,80,0.8)' : 'rgba(61,107,255,0.55)';
    g.fillRect(b * bw + 1, h - r * h, bw - 2, r * h);
    if (!bypass) {
      g.fillStyle = '#E3F732';
      g.fillRect(b * bw + 1, h - v * h, bw - 2, v * h);
    }
  }
}
