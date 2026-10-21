// Export orchestration. Desktop: ffmpeg decode → matte worker → ffmpeg encode (any
// format incl. ProRes 4444). Web: Mediabunny/WebCodecs decode → matte worker → encode.
import { native, download } from './platform.js';
import { MatteClient } from './workers/clients.js';
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, WebMOutputFormat,
  BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH,
} from 'mediabunny';

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const baseName = (n) => n.replace(/\.[^.]+$/, '');

export function exportRange(clip) {
  const start = clip.inPoint ?? 0;
  const end = clip.outPoint ?? clip.info.duration;
  return { start, end: Math.max(start + 1 / (clip.info.fps || 30), end) };
}

// Video-ish params for export: transparent backdrops can't go into opaque formats.
function exportParams(matte, fmt) {
  const p = { ...matte, exportView: fmt.matte ? 'alpha' : 'composite' };
  if (!fmt.alpha && p.backdrop === 'transparent') { p.backdrop = 'color'; p.backdropColor = p.backdropColor || '#C0C4CA'; }
  return p;
}

export class Exporter {
  constructor({ getMatte, getAudioWav, getAudioBuffer, onProgress, formats }) {
    this.getMatte = getMatte;
    this.getAudioWav = getAudioWav;
    this.getAudioBuffer = getAudioBuffer;
    this.onProgress = onProgress;
    this.formats = formats;
    this.cancelled = false;
    this.worker = null;
  }

  cancel() { this.cancelled = true; }

  async worker_() {
    if (!this.worker) {
      this.worker = new MatteClient({ threads: this.threads ?? 4 });
      await this.worker.ready;
    }
    this.worker.reset();
    return this.worker;
  }

  dispose() { this.worker?.terminate(); this.worker = null; }

  /* ───────── video ───────── */

  // `out` may be pre-chosen (batch export); otherwise a save dialog is shown.
  async exportVideo(clip, formatKey, scale = 1, out = null) {
    const fmt = this.formats[formatKey];
    if (!clip.info.hasVideo) throw new Error('This clip has no video. Use Export audio.');
    this.cancelled = false;
    const { start, end } = exportRange(clip);
    const fps = clip.info.fps || 30;
    const W = even(clip.info.width * scale), H = even(clip.info.height * scale);
    const name = `${baseName(clip.name)}_removeless${fmt.matte ? '_matte' : ''}${fmt.ext ? `.${fmt.ext}` : ''}`;
    return native
      ? this.desktopVideo(clip, fmt, formatKey, { start, end, fps, W, H, name, out })
      : this.webVideo(clip, fmt, formatKey, { start, end, fps, W, H, name });
  }

  async desktopVideo(clip, fmt, formatKey, o) {
    let out = o.out;
    if (!out) {
      out = await native.saveDialog({
        defaultName: fmt.sequence ? `${baseName(clip.name)}_removeless_frames` : o.name,
        filters: fmt.sequence ? undefined : [{ name: fmt.label, extensions: [fmt.ext] }],
        directory: fmt.sequence,
      });
    }
    if (!out) return null;
    const progress = (stage, f, extra) => this.onProgress?.({ stage, f, ...extra });

    progress('Rendering isolated audio…', 0);
    let wavPath = null;
    if (clip.info.hasAudio && !fmt.matte) {
      const wav = await this.getAudioWav(clip, o.start, o.end);
      if (wav) {
        if (fmt.sequence) await native.writeFile(`${out}/${baseName(clip.name)}_voice.wav`, wav);
        else wavPath = await native.writeTemp('voice.wav', wav);
      }
    }

    progress('Loading matte engine…', 0);
    const worker = await this.worker_();
    const params = exportParams(this.getMatte(), fmt);
    const strokes = clip.strokes;
    const job = await native.exportStart({
      src: clip.path, out, format: formatKey, width: o.W, height: o.H, fps: o.fps,
      start: o.start, duration: o.end - o.start, wavPath, baseName: baseName(clip.name),
    });

    const t0 = performance.now();
    let next = native.exportRead(job.id);
    let writing = Promise.resolve();
    let i = 0;
    try {
      for (; ; i++) {
        if (this.cancelled) throw new Error('cancelled');
        const buf = await next;
        if (!buf) break;
        next = native.exportRead(job.id); // prefetch while we matte this frame
        const r = await worker.frame({ rgba: buf, w: o.W, h: o.H, params, t: o.start + i / o.fps, strokes, mode: 'export' }, [buf]);
        await writing;
        writing = native.exportWrite(job.id, r.rgba);
        const el = (performance.now() - t0) / 1000;
        progress(`Frame ${i + 1} / ${job.frames} · ${r.stats.backend?.toUpperCase() || ''}`, (i + 1) / job.frames,
          { eta: (el / (i + 1)) * (job.frames - i - 1), fps: (i + 1) / el });
      }
      await writing;
      progress('Finalising file…', 1);
      const res = await native.exportFinish(job.id);
      return { path: res.path, frames: i };
    } catch (e) {
      await native.exportCancel(job.id);
      if (e.message === 'cancelled') return null;
      throw e;
    }
  }

  async webVideo(clip, fmt, formatKey, o) {
    const progress = (stage, f, extra) => this.onProgress?.({ stage, f, ...extra });
    const webm = formatKey === 'web_webm';
    progress('Loading matte engine…', 0);
    const worker = await this.worker_();
    const params = exportParams(this.getMatte(), fmt);
    const keepAlpha = webm && params.backdrop === 'transparent';

    const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    const sink = new CanvasSink(vt, { width: o.W, height: o.H, fit: 'fill', poolSize: 2 });
    const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const canvas = new OffscreenCanvas(o.W, o.H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const src = new CanvasSource(canvas, { codec: webm ? 'vp9' : 'avc', quality: QUALITY_HIGH, ...(keepAlpha ? { alpha: 'keep' } : {}) });
    output.addVideoTrack(src, { frameRate: o.fps });
    let audioSrc = null;
    const audio = clip.info.hasAudio && !fmt.matte ? this.getAudioBuffer(o.start, o.end) : null;
    if (audio) {
      audioSrc = new AudioBufferSource({ codec: webm ? 'opus' : 'aac', quality: QUALITY_HIGH });
      output.addAudioTrack(audioSrc);
    }
    await output.start();

    const total = Math.max(1, Math.round((o.end - o.start) * o.fps));
    const t0 = performance.now();
    let i = 0;
    for await (const wc of sink.canvases(o.start, o.end)) {
      if (this.cancelled) { await output.cancel(); input.dispose?.(); return null; }
      ctx.clearRect(0, 0, o.W, o.H);
      ctx.drawImage(wc.canvas, 0, 0, o.W, o.H);
      const rgba = ctx.getImageData(0, 0, o.W, o.H).data.buffer;
      const r = await worker.frame({ rgba, w: o.W, h: o.H, params, t: wc.timestamp, strokes: clip.strokes, mode: 'export' }, [rgba]);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), o.W, o.H), 0, 0);
      await src.add(Math.max(0, wc.timestamp - o.start), wc.duration);
      i++;
      const el = (performance.now() - t0) / 1000;
      progress(`Frame ${i} / ${total}`, Math.min(1, i / total), { eta: (el / i) * Math.max(0, total - i), fps: i / el });
    }
    if (audioSrc) await audioSrc.add(audio);
    progress('Finalising file…', 1);
    await output.finalize();
    input.dispose?.();
    download(new Blob([output.target.buffer], { type: webm ? 'video/webm' : 'video/mp4' }), o.name);
    return { path: o.name, frames: i };
  }

  /* ───────── audio only ───────── */

  async exportAudio(clip, codec = 'wav', presetOut = null) {
    if (!clip.info.hasAudio) throw new Error('This clip has no audio track.');
    const { start, end } = exportRange(clip);
    const wav = await this.getAudioWav(clip, start, end);
    const name = `${baseName(clip.name)}_voice.${codec}`;
    if (!native) {
      if (codec !== 'wav') this.onProgress?.({ stage: 'Browser build exports WAV only', f: 1 });
      download(new Blob([wav], { type: 'audio/wav' }), `${baseName(clip.name)}_voice.wav`);
      return { path: name };
    }
    const out = presetOut || await native.saveDialog({ defaultName: name, filters: [{ name: codec.toUpperCase(), extensions: [codec] }] });
    if (!out) return null;
    if (codec === 'wav') { await native.writeFile(out, wav); return { path: out }; }
    const tmp = await native.writeTemp('voice.wav', wav);
    return native.transcodeAudio(tmp, out, codec);
  }
}
