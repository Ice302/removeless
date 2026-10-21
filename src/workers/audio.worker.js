// Audio worker: RNNoise + DSP chain, cached between parameter tweaks.
import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import { VoiceIsolator, encodeWav, SR } from '../engine/audio-dsp.js';

let iso = null;
let latest = 0;

self.onmessage = async ({ data: m }) => {
  try {
    switch (m.type) {
      case 'init': {
        const rn = await Rnnoise.load();
        iso = new VoiceIsolator(rn);
        self.postMessage({ type: 'ready', latency: iso.latency });
        break;
      }
      case 'source':
        iso.setSource(m.channels.map((b) => new Float32Array(b)));
        self.postMessage({ type: 'source-set', id: m.id });
        break;
      case 'process': {
        latest = m.id;
        const r = iso.process(m.params, (p) => self.postMessage({ type: 'progress', id: m.id, ...p }));
        if (m.id !== latest) break; // superseded while running
        const channels = r.channels.map((c) => c.buffer);
        const vad = r.vad.slice().buffer;
        self.postMessage({ type: 'result', id: m.id, channels, vad, stats: r.stats }, [...channels, vad]);
        break;
      }
      case 'wav': {
        const r = iso.process(m.params);
        const a = Math.max(0, Math.round((m.start || 0) * SR));
        const b = m.end ? Math.min(r.channels[0].length, Math.round(m.end * SR)) : r.channels[0].length;
        const buf = encodeWav(r.channels.map((c) => c.subarray(a, b)), SR, m.bitDepth || 24);
        self.postMessage({ type: 'wav', id: m.id, buffer: buf }, [buf]);
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
  }
};
