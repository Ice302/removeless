// Desktop (Electron + ffmpeg) vs web/PWA (WebCodecs via Mediabunny) adapters.
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';

export const native = window.native || null;
export const isDesktop = !!native;
export const platform = isDesktop ? 'desktop' : 'web';

let uid = 1;

export async function appInfo() {
  if (native) return native.info();
  return {
    platform: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'web',
    version: import.meta.env.VITE_APP_VERSION || '0.13.0',
    formats: {
      web_mp4: { label: 'H.264 MP4 (composited)', ext: 'mp4', alpha: false, even: true },
      web_webm: { label: 'WebM VP9 + Alpha', ext: 'webm', alpha: true, even: true },
      matte_web: { label: 'Matte only (luma, .mp4)', ext: 'mp4', alpha: false, even: true, matte: true },
    },
  };
}

export const mediaUrl = (p) => `app://media/${encodeURIComponent(p)}`;

/* ───────── import ───────── */

export async function clipFromPath(path) {
  const info = await native.probe(path);
  return { id: uid++, name: info.name, path, url: mediaUrl(path), info, strokes: [], inPoint: null, outPoint: null };
}

// Web: read container metadata with Mediabunny (works for MP4/MOV/WebM/MKV/WAV/MP3…).
async function probeFile(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const [vt, at] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
  const info = { name: file.name, duration: await input.computeDuration(), hasVideo: !!vt, hasAudio: !!at };
  if (vt) {
    info.width = vt.displayWidth; info.height = vt.displayHeight;
    const st = await vt.computePacketStats(60).catch(() => null);
    info.fps = st?.averagePacketRate ? Math.min(120, Math.round(st.averagePacketRate * 1000) / 1000) : 30;
    info.vcodec = vt.codec;
  }
  if (at) { info.sampleRate = at.sampleRate; info.channels = Math.min(2, at.numberOfChannels); info.acodec = at.codec; }
  input.dispose?.();
  if (!vt && !at) throw new Error('No playable video or audio stream found.');
  return info;
}

export async function clipFromFile(file) {
  if (native) {
    const p = native.pathForFile(file);
    if (p && (await native.allowMedia(p))) return clipFromPath(p);
    // Blob without a path (e.g. camera recording): persist it so ffmpeg can read it.
    const tmp = await native.writeTemp(file.name || 'recording.webm', await file.arrayBuffer());
    return clipFromPath(tmp);
  }
  const info = await probeFile(file);
  return { id: uid++, name: file.name, file, url: URL.createObjectURL(file), info, strokes: [], inPoint: null, outPoint: null };
}

/* ───────── audio decode → Float32Array[] at 48 kHz ───────── */

export async function decodeAudio(clip) {
  if (native) {
    const r = await native.extractAudio(clip.path, clip.info.channels || 2);
    const inter = new Float32Array(r.data);
    const n = Math.floor(inter.length / r.channels);
    const chans = Array.from({ length: r.channels }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < r.channels; c++) chans[c][i] = inter[i * r.channels + c];
    return chans;
  }
  const buf = await clip.file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const ab = await ctx.decodeAudioData(buf);
  const n = Math.min(2, ab.numberOfChannels);
  return Array.from({ length: n }, (_, c) => ab.getChannelData(c).slice());
}

/* ───────── file output ───────── */

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export async function saveBytes(defaultName, bytes, filters, mime = 'application/octet-stream') {
  if (native) {
    const out = await native.saveDialog({ defaultName, filters });
    if (!out) return null;
    await native.writeFile(out, bytes);
    return out;
  }
  download(new Blob([bytes], { type: mime }), defaultName);
  return defaultName;
}
