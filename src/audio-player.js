// Plays the raw and processed buffers in lock-step with the <video> clock so A/B
// (RAW hold) switches instantly. Exposes analysers for the spectrum strip.
export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.raw = null;
    this.wet = null;
    this.sources = [];
    this.playing = false;
    this.bypass = false;
    this.muted = false;
    this.startCtx = 0;
    this.startPos = 0;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: 48000, latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.gRaw = this.ctx.createGain();
    this.gWet = this.ctx.createGain();
    this.anRaw = this.ctx.createAnalyser();
    this.anWet = this.ctx.createAnalyser();
    for (const a of [this.anRaw, this.anWet]) { a.fftSize = 2048; a.smoothingTimeConstant = 0.7; }
    this.gRaw.connect(this.master);
    this.gWet.connect(this.master);
    this.applyGains();
    return this.ctx;
  }

  toBuffer(channels) {
    const ctx = this.ensure();
    const b = ctx.createBuffer(channels.length, channels[0].length, 48000);
    channels.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }

  setRaw(channels) { this.raw = channels ? this.toBuffer(channels) : null; this.wet = null; this.restart(); }
  setWet(channels) { this.wet = channels ? this.toBuffer(channels) : null; this.restart(); }
  clear() { this.stop(); this.raw = null; this.wet = null; }

  applyGains() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const wetOn = !this.bypass && !!this.wet;
    this.gWet.gain.setTargetAtTime(wetOn ? 1 : 0, t, 0.008);
    this.gRaw.gain.setTargetAtTime(wetOn ? 0 : 1, t, 0.008);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.01);
  }

  setBypass(b) { this.bypass = b; this.applyGains(); }
  setMuted(m) { this.muted = m; this.applyGains(); }

  position() {
    if (!this.playing || !this.ctx) return this.startPos;
    return this.startPos + (this.ctx.currentTime - this.startCtx);
  }

  play(at) {
    this.ensure();
    this.stopSources();
    this.playing = true;
    this.startPos = at;
    if (!this.raw) return;
    const when = this.ctx.currentTime + 0.02;
    this.startCtx = when;
    const add = (buf, gain, an) => {
      if (!buf || at >= buf.duration) return;
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(an);
      an.connect(gain);
      s.start(when, at);
      this.sources.push(s);
    };
    add(this.raw, this.gRaw, this.anRaw);
    add(this.wet, this.gWet, this.anWet);
    this.applyGains();
  }

  restart() { if (this.playing) this.play(this.position()); }

  stopSources() {
    for (const s of this.sources) { try { s.stop(); } catch {} s.disconnect(); }
    this.sources = [];
  }

  stop() { this.startPos = this.position(); this.playing = false; this.stopSources(); }
}
