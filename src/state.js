// App state: parameters, presets, undo history and persistence.
import { MATTE_DEFAULTS } from './engine/matte-pipeline.js';
import { AUDIO_DEFAULTS } from './engine/audio-dsp.js';

export const AUDIO_KEYS = Object.keys(AUDIO_DEFAULTS);
export const MATTE_KEYS = Object.keys(MATTE_DEFAULTS);

// The orbital "Isolation Strength" dial is a macro over the isolation-depth controls.
export function strengthMap(s) {
  return {
    strength: s,
    reductionDb: Math.round(6 + 0.54 * s),
    cleanup: Math.round(0.9 * s),
    gate: Math.round(0.6 * s),
    contrast: Math.round(Math.max(0, s - 40) * 0.25),
  };
}

export const DEFAULTS = {
  ...MATTE_DEFAULTS,
  ...AUDIO_DEFAULTS,
  strokeSpanUi: 45,
  ...strengthMap(60),
};

export const PRESETS = {
  'Interview / Podcast': { engine: 'rvm', quality: 'balanced', snap: 60, feather: 10, chatter: 60, decontam: 70, ...strengthMap(60), presence: 40, deEsser: 45, highpassHz: 80, loudness: -16 },
  'Street Vlog (heavy noise)': { engine: 'rvm', quality: 'balanced', chatter: 55, ...strengthMap(85), highpassHz: 110, presence: 50, loudness: -14 },
  'Green / Blue Screen': { engine: 'chroma', snap: 40, threshold: 52, contrast: 12, despill: 85, decontam: 60, feather: 6, chatter: 30, keyColor: null },
  'Hair & Fine Detail': { engine: 'rvm', quality: 'high', snap: 80, feather: 0, contrast: 0, threshold: 50, chatter: 40, decontam: 90, shiftEdge: 0 },
  'Natural (gentle)': { ...strengthMap(25), presence: 20, deEsser: 25, mix: 90, feather: 14, chatter: 65 },
  'Broadcast (−23 LUFS)': { ...strengthMap(65), loudness: -23, presence: 35, deEsser: 50 },
};

// Stroke lifetime slider (0..100) → seconds either side of the painted frame.
export function spanFromUi(v) {
  if (v >= 100) return Infinity;
  if (v <= 0) return 0;
  return Math.round(0.08 * Math.pow(30 / 0.08, v / 99) * 100) / 100;
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem(`removeless.${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`removeless.${k}`, JSON.stringify(v)); } catch {} },
};

export class Store extends EventTarget {
  constructor() {
    super();
    const saved = LS.get('params', null);
    this.params = { ...DEFAULTS, ...(saved || {}), view: 'composite', splitPos: 0.5 };
    this.userPresets = LS.get('presets', {});
    this.history = [];
    this.future = [];
    this.lastSnap = null;
  }

  matte() {
    const p = {};
    for (const k of MATTE_KEYS) p[k] = this.params[k];
    p.strokeSpan = spanFromUi(this.params.strokeSpanUi);
    return p;
  }

  audio() {
    const p = {};
    for (const k of AUDIO_KEYS) p[k] = this.params[k];
    if (p.loudness === 'off') p.loudness = null;
    else if (p.loudness !== null) p.loudness = Number(p.loudness);
    return p;
  }

  set(patch, { commit = false, silent = false } = {}) {
    Object.assign(this.params, patch);
    const keys = Object.keys(patch);
    if (!silent) this.dispatchEvent(new CustomEvent('change', { detail: { keys, audio: keys.some((k) => AUDIO_KEYS.includes(k)) } }));
    if (commit) this.commit();
  }

  /* ───────── undo / redo ───────── */

  // `extra` lets the app include per-clip state (strokes) in the snapshot.
  snapshot(extra) {
    const { view, splitPos, ...rest } = this.params;
    return JSON.stringify({ params: rest, extra: extra?.() ?? null });
  }

  bindExtra(getter, setter) { this.getExtra = getter; this.setExtra = setter; this.lastSnap = this.snapshot(this.getExtra); }

  commit() {
    const snap = this.snapshot(this.getExtra);
    if (snap === this.lastSnap) return;
    if (this.lastSnap) this.history.push(this.lastSnap);
    if (this.history.length > 120) this.history.shift();
    this.future = [];
    this.lastSnap = snap;
    LS.set('params', JSON.parse(snap).params);
  }

  restore(snap) {
    const s = JSON.parse(snap);
    Object.assign(this.params, s.params);
    this.setExtra?.(s.extra);
    this.lastSnap = snap;
    LS.set('params', s.params);
    this.dispatchEvent(new CustomEvent('change', { detail: { keys: Object.keys(s.params), audio: true, restored: true } }));
  }

  undo() {
    if (!this.history.length) return false;
    this.future.push(this.lastSnap);
    this.restore(this.history.pop());
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(this.lastSnap);
    this.restore(this.future.pop());
    return true;
  }

  /* ───────── presets ───────── */

  allPresets() { return { ...PRESETS, ...this.userPresets }; }

  applyPreset(name) {
    const p = this.allPresets()[name];
    if (!p) return;
    this.set({ ...p }, { commit: true });
  }

  savePreset(name) {
    const { view, splitPos, keyColor, ...rest } = this.params;
    this.userPresets[name] = rest;
    LS.set('presets', this.userPresets);
  }

  reset() { this.set({ ...DEFAULTS }, { commit: true }); }
}

export const ui = {
  get: (k, d) => LS.get(`ui.${k}`, d),
  set: (k, v) => LS.set(`ui.${k}`, v),
};
