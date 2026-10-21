// Pixel kernels for the matte pipeline. DOM-free typed-array code shared by the matte
// worker and the Node test harness. Images are RGBA Uint8ClampedArray; mattes are
// Float32Array in [0,1], one value per pixel.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Reusable scratch buffers keyed by name+size, so per-frame work doesn't allocate.
const pool = new Map();
export function scratch(name, n, Type = Float32Array) {
  const k = `${name}:${n}`;
  let b = pool.get(k);
  if (!b || b.length !== n || !(b instanceof Type)) {
    b = new Type(n);
    pool.set(k, b);
  }
  return b;
}

/* ───────────────────────── box / blur / resize ───────────────────────── */

// Normalised box filter with radius r (window 2r+1), O(n) via running sums.
export function boxFilter(src, w, h, r, out = new Float32Array(w * h)) {
  if (r <= 0) { out.set(src); return out; }
  const tmp = scratch('box.tmp', w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[row + x] = acc / (hi - lo + 1);
      const add = x + r + 1, sub = x - r;
      if (add < w) acc += src[row + add];
      if (sub >= 0) acc -= src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      out[y * w + x] = acc / (hi - lo + 1);
      const add = y + r + 1, sub = y - r;
      if (add < h) acc += tmp[add * w + x];
      if (sub >= 0) acc -= tmp[sub * w + x];
    }
  }
  return out;
}

// Gaussian approximated by three box passes (Kovesi).
export function gaussianBlur(src, w, h, sigma, out = new Float32Array(w * h)) {
  if (sigma < 0.3) { out.set(src); return out; }
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const a = scratch('gauss.a', w * h);
  a.set(src);
  for (let i = 0; i < n; i++) {
    const size = i < m ? wl : wl + 2;
    boxFilter(a, w, h, (size - 1) >> 1, a === out ? a : out);
    if (i < n - 1) a.set(out);
  }
  return out;
}

// Area-average downscale by integer factor s.
export function downsample(src, w, h, s, out) {
  const ws = Math.ceil(w / s), hs = Math.ceil(h / s);
  out = out || new Float32Array(ws * hs);
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < ws; x++) {
      let acc = 0, n = 0;
      const y1 = Math.min(h, (y + 1) * s), x1 = Math.min(w, (x + 1) * s);
      for (let yy = y * s; yy < y1; yy++) for (let xx = x * s; xx < x1; xx++) { acc += src[yy * w + xx]; n++; }
      out[y * ws + x] = acc / n;
    }
  }
  return { data: out, w: ws, h: hs };
}

// Bilinear resample of a single-channel plane to (dw, dh). Pixel centres aligned.
export function resizePlane(src, sw, sh, dw, dh, out = new Float32Array(dw * dh)) {
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(sh - 1, fy | 0), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(sw - 1, fx | 0), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

// RGBA → planar float CHW tensor at (dw, dh) with per-value transform (mul, add).
export function rgbaToTensor(rgba, sw, sh, dw, dh, mul = 1 / 255, add = 0, out = new Float32Array(3 * dw * dh)) {
  const sx = sw / dw, sy = sh / dh, plane = dw * dh;
  for (let y = 0; y < dh; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(sh - 1, fy | 0), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(sw - 1, fx | 0), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = y * dw + x;
      for (let c = 0; c < 3; c++) {
        const v = (rgba[i00 + c] + (rgba[i01 + c] - rgba[i00 + c]) * tx) * (1 - ty) +
                  (rgba[i10 + c] + (rgba[i11 + c] - rgba[i10 + c]) * tx) * ty;
        out[c * plane + o] = v * mul + add;
      }
    }
  }
  return out;
}

/* ───────────────────────── guided filter (edge snap) ───────────────────────── */

// Fast colour guided filter (He et al.). Refines `p` so its edges follow the RGB edges
// of the frame — the same idea as Roto Brush's edge snapping / Refine Edge "Smooth".
export function guidedFilterColor(rgba, p, w, h, r, eps, s = 1, out = new Float32Array(w * h)) {
  const ws = Math.ceil(w / s), hs = Math.ceil(h / s), n = ws * hs;
  const R = scratch('gf.R', n), G = scratch('gf.G', n), B = scratch('gf.B', n), P = scratch('gf.P', n);
  // Downsample guide + input together.
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < ws; x++) {
      let r0 = 0, g0 = 0, b0 = 0, p0 = 0, c = 0;
      const y1 = Math.min(h, (y + 1) * s), x1 = Math.min(w, (x + 1) * s);
      for (let yy = y * s; yy < y1; yy++) {
        for (let xx = x * s; xx < x1; xx++) {
          const i = yy * w + xx;
          r0 += rgba[i * 4]; g0 += rgba[i * 4 + 1]; b0 += rgba[i * 4 + 2]; p0 += p[i]; c++;
        }
      }
      const o = y * ws + x;
      R[o] = r0 / c / 255; G[o] = g0 / c / 255; B[o] = b0 / c / 255; P[o] = p0 / c;
    }
  }
  const rs = Math.max(1, Math.round(r / s));
  const prod = scratch('gf.prod', n);
  const mean = (src, name) => boxFilter(src, ws, hs, rs, scratch(name, n));
  const meanOf = (a, b, name) => { for (let i = 0; i < n; i++) prod[i] = a[i] * b[i]; return mean(prod, name); };

  const mR = mean(R, 'gf.mR'), mG = mean(G, 'gf.mG'), mB = mean(B, 'gf.mB'), mP = mean(P, 'gf.mP');
  const mRP = meanOf(R, P, 'gf.mRP'), mGP = meanOf(G, P, 'gf.mGP'), mBP = meanOf(B, P, 'gf.mBP');
  const vRR = meanOf(R, R, 'gf.vRR'), vRG = meanOf(R, G, 'gf.vRG'), vRB = meanOf(R, B, 'gf.vRB');
  const vGG = meanOf(G, G, 'gf.vGG'), vGB = meanOf(G, B, 'gf.vGB'), vBB = meanOf(B, B, 'gf.vBB');

  const aR = scratch('gf.aR', n), aG = scratch('gf.aG', n), aB = scratch('gf.aB', n), bb = scratch('gf.b', n);
  for (let i = 0; i < n; i++) {
    const cR = mRP[i] - mR[i] * mP[i], cG = mGP[i] - mG[i] * mP[i], cB = mBP[i] - mB[i] * mP[i];
    const rr = vRR[i] - mR[i] * mR[i] + eps, rg = vRG[i] - mR[i] * mG[i], rb = vRB[i] - mR[i] * mB[i];
    const gg = vGG[i] - mG[i] * mG[i] + eps, gb = vGB[i] - mG[i] * mB[i], bq = vBB[i] - mB[i] * mB[i] + eps;
    // Inverse of the symmetric 3×3 covariance (Σ + εI).
    const i00 = gg * bq - gb * gb, i01 = gb * rb - rg * bq, i02 = rg * gb - gg * rb;
    const i11 = rr * bq - rb * rb, i12 = rb * rg - rr * gb, i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    const inv = 1 / det;
    const a0 = (i00 * cR + i01 * cG + i02 * cB) * inv;
    const a1 = (i01 * cR + i11 * cG + i12 * cB) * inv;
    const a2 = (i02 * cR + i12 * cG + i22 * cB) * inv;
    aR[i] = a0; aG[i] = a1; aB[i] = a2;
    bb[i] = mP[i] - a0 * mR[i] - a1 * mG[i] - a2 * mB[i];
  }
  const maR = mean(aR, 'gf.maR'), maG = mean(aG, 'gf.maG'), maB = mean(aB, 'gf.maB'), mb = mean(bb, 'gf.mb');

  // Upsample coefficients and apply at full resolution against the full-res guide.
  const sx = ws / w, sy = hs / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(hs - 1, fy | 0), y1 = Math.min(hs - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(ws - 1, fx | 0), x1 = Math.min(ws - 1, x0 + 1), tx = fx - x0;
      const k00 = y0 * ws + x0, k01 = y0 * ws + x1, k10 = y1 * ws + x0, k11 = y1 * ws + x1;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      const i = y * w + x;
      const ar = maR[k00] * w00 + maR[k01] * w01 + maR[k10] * w10 + maR[k11] * w11;
      const ag = maG[k00] * w00 + maG[k01] * w01 + maG[k10] * w10 + maG[k11] * w11;
      const ab = maB[k00] * w00 + maB[k01] * w01 + maB[k10] * w10 + maB[k11] * w11;
      const b0 = mb[k00] * w00 + mb[k01] * w01 + mb[k10] * w10 + mb[k11] * w11;
      out[i] = clamp01((ar * rgba[i * 4] + ag * rgba[i * 4 + 1] + ab * rgba[i * 4 + 2]) / 255 + b0);
    }
  }
  return out;
}

/* ───────────────────────── morphology (shift edge / choke) ───────────────────────── */

// 1-D running min/max (van Herk / Gil-Werman), O(n) regardless of radius.
function minMax1D(src, dst, n, stride, offset, r, isMax, g, hbuf) {
  const k = 2 * r + 1;
  const len = n + 2 * r;
  const pad = isMax ? -Infinity : Infinity;
  const at = (i) => { const j = i - r; return j < 0 || j >= n ? pad : src[offset + j * stride]; };
  const op = isMax ? Math.max : Math.min;
  for (let i = 0; i < len; i++) g[i] = i % k === 0 ? at(i) : op(g[i - 1], at(i));
  for (let i = len - 1; i >= 0; i--) hbuf[i] = i % k === k - 1 || i === len - 1 ? at(i) : op(hbuf[i + 1], at(i));
  for (let i = 0; i < n; i++) dst[offset + i * stride] = op(hbuf[i], g[i + 2 * r]);
}

// px > 0 grows the matte (spread), px < 0 shrinks it (choke).
export function shiftEdge(a, w, h, px, out = new Float32Array(w * h)) {
  const r = Math.round(Math.abs(px));
  if (r === 0) { out.set(a); return out; }
  const isMax = px > 0;
  const tmp = scratch('morph.tmp', w * h);
  const L = Math.max(w, h) + 2 * r;
  const g = scratch('morph.g', L), hb = scratch('morph.h', L);
  for (let y = 0; y < h; y++) minMax1D(a, tmp, w, 1, y * w, r, isMax, g, hb);
  for (let x = 0; x < w; x++) minMax1D(tmp, out, h, w, x, r, isMax, g, hb);
  return out;
}

/* ───────────────────────── levels ───────────────────────── */

// threshold 0..100 (50 = neutral) moves the 50 % point; contrast 0..100 steepens.
export function levels(a, threshold, contrast) {
  if (threshold === 50 && contrast === 0) return a;
  const centre = threshold / 100;
  const width = Math.max(0.02, 1 - (contrast / 100) * 0.96);
  const lo = centre - width / 2;
  for (let i = 0; i < a.length; i++) a[i] = clamp01((a[i] - lo) / width);
  return a;
}

/* ───────────────────────── keyer (colour difference) ───────────────────────── */

// Estimates the screen colour from the frame border (median per channel).
export function estimateKeyColor(rgba, w, h) {
  const rs = [], gs = [], bs = [];
  const take = (x, y) => { const i = (y * w + x) * 4; rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]); };
  const step = Math.max(1, Math.floor((w + h) / 400));
  for (let x = 0; x < w; x += step) { take(x, 0); take(x, Math.min(h - 1, 2)); }
  for (let y = 0; y < h; y += step) { take(0, y); take(w - 1, y); }
  const med = (arr) => arr.sort((p, q) => p - q)[arr.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

// Classic colour-difference key (the core of Keylight/Primatte-style keyers):
// screen = C_key − blend(max, mean)(others), normalised by the key colour's own value.
export function colorDifferenceKey(rgba, w, h, key, balance = 0.5, out = new Float32Array(w * h)) {
  const kc = key.indexOf(Math.max(...key));
  const o1 = (kc + 1) % 3, o2 = (kc + 2) % 3;
  const other = (a, b) => balance * Math.max(a, b) + (1 - balance) * (a + b) / 2;
  const keyDiff = Math.max(8, key[kc] - other(key[o1], key[o2]));
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const diff = rgba[i + kc] - other(rgba[i + o1], rgba[i + o2]);
    out[p] = 1 - clamp01(diff / keyDiff);
  }
  return out;
}

/* ───────────────────────── temporal (reduce chatter) ───────────────────────── */

// Motion-adaptive exponential smoothing: static regions are averaged over time to kill
// edge flicker, moving regions follow the new matte immediately (no ghost trails).
export function reduceChatter(a, prevA, luma, prevLuma, amount) {
  const k = (amount / 100) * 0.85;
  for (let i = 0; i < a.length; i++) {
    const motion = Math.abs(luma[i] - prevLuma[i]);
    const wgt = k * Math.max(0, 1 - motion * 10);
    a[i] = wgt * prevA[i] + (1 - wgt) * a[i];
  }
  return a;
}

export function lumaOf(rgba, out) {
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
  }
  return out;
}

/* ───────────────────────── colour: decontaminate + despill ───────────────────────── */

// Estimates the local background colour behind semi-transparent edges with a normalised
// convolution weighted by (1−α), then solves I = αF + (1−α)B for F.
export function estimateForeground(rgba, a, w, h, out) {
  const s = 4, ws = Math.ceil(w / s), hs = Math.ceil(h / s), n = ws * hs;
  const num = [scratch('fg.nr', n), scratch('fg.ng', n), scratch('fg.nb', n)];
  const den = scratch('fg.den', n);
  num.forEach((b) => b.fill(0)); den.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = ((y / s) | 0) * ws + ((x / s) | 0);
      const wb = (1 - a[i]) * (1 - a[i]);
      den[o] += wb;
      num[0][o] += wb * rgba[i * 4]; num[1][o] += wb * rgba[i * 4 + 1]; num[2][o] += wb * rgba[i * 4 + 2];
    }
  }
  const r = 6;
  const dB = boxFilter(den, ws, hs, r, scratch('fg.dB', n));
  const bg = num.map((c, ch) => {
    const blurred = boxFilter(c, ws, hs, r, scratch(`fg.c${ch}`, n));
    for (let i = 0; i < n; i++) blurred[i] = dB[i] > 1e-4 ? blurred[i] / dB[i] : 128;
    return resizePlane(blurred, ws, hs, w, h, scratch(`fg.up${ch}`, w * h));
  });
  for (let i = 0; i < w * h; i++) {
    const al = a[i];
    for (let c = 0; c < 3; c++) {
      const I = rgba[i * 4 + c];
      out[i * 3 + c] = al > 0.98 ? I : al < 0.02 ? I : Math.max(0, Math.min(255, (I - (1 - al) * bg[c][i]) / al));
    }
  }
  return out;
}

// Dominant screen channel of the (mostly) background pixels, or −1 if not saturated.
export function spillChannel(rgba, a, w, h) {
  const sum = [0, 0, 0]; let n = 0;
  for (let p = 0; p < w * h; p += 7) {
    if (a[p] > 0.1) continue;
    sum[0] += rgba[p * 4]; sum[1] += rgba[p * 4 + 1]; sum[2] += rgba[p * 4 + 2]; n++;
  }
  if (n < 50) return -1;
  const m = sum.map((v) => v / n);
  const c = m.indexOf(Math.max(...m));
  const rest = m.filter((_, i) => i !== c);
  return m[c] - Math.max(...rest) > 22 ? c : -1;
}

/* ───────────────────────── hint strokes (tracked) ───────────────────────── */

// Rasterises FG/BG strokes active at time t. Each stroke remembers where the subject was
// when it was painted (anchor) and follows the subject's centroid/scale on other frames —
// a light-weight stand-in for Roto Brush stroke propagation.
export function rasterizeHints(strokes, t, w, h, track, span, subject, fg, bg) {
  fg.fill(0); bg.fill(0);
  let any = false;
  for (const s of strokes) {
    const dt = Math.abs(t - s.t);
    let wgt = 1;
    if (Number.isFinite(span)) {
      if (dt > span + 1e-3) continue;
      wgt = span <= 0 ? 1 : 1 - Math.max(0, (dt - span * 0.6) / (span * 0.4));
    }
    if (wgt <= 0) continue;
    let dx = 0, dy = 0, sc = 1;
    if (track && s.anchor && subject && subject.area > 0) {
      sc = Math.max(0.5, Math.min(2, subject.h / s.anchor.h));
      dx = subject.cx - s.anchor.cx; dy = subject.cy - s.anchor.cy;
    }
    const tx = (x) => ((x - (s.anchor?.cx ?? 0)) * sc + (s.anchor?.cx ?? 0) + dx) * w;
    const ty = (y) => ((y - (s.anchor?.cy ?? 0)) * sc + (s.anchor?.cy ?? 0) + dy) * h;
    const rad = Math.max(1, s.r * h * sc);
    const mask = s.mode === 'fg' ? fg : bg;
    const pts = s.pts;
    for (let k = 0; k < pts.length; k += 2) {
      const last = k + 2 >= pts.length;
      const ax = tx(pts[k]), ay = ty(pts[k + 1]);
      const bx = last ? ax : tx(pts[k + 2]), by = last ? ay : ty(pts[k + 3]);
      stampCapsule(mask, w, h, ax, ay, bx, by, rad, wgt);
    }
    any = true;
  }
  return any;
}

function stampCapsule(mask, w, h, ax, ay, bx, by, r, wgt) {
  const soft = 1.5;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - soft)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + soft));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - soft)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + soft));
  const vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy || 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / vv));
      const ex = x - (ax + t * vx), ey = y - (ay + t * vy);
      const d = Math.sqrt(ex * ex + ey * ey);
      const v = clamp01((r - d) / soft + 0.5) * wgt;
      const i = y * w + x;
      if (v > mask[i]) mask[i] = v;
    }
  }
}

// Centroid / height of the subject (normalised coords), sampled sparsely.
export function subjectStats(a, w, h) {
  let sx = 0, sy = 0, n = 0, minY = h, maxY = 0;
  const st = Math.max(1, Math.floor(Math.min(w, h) / 180));
  for (let y = 0; y < h; y += st) {
    for (let x = 0; x < w; x += st) {
      if (a[y * w + x] > 0.5) { sx += x; sy += y; n++; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  if (!n) return { cx: 0.5, cy: 0.5, h: 1, area: 0 };
  return { cx: sx / n / w, cy: sy / n / h, h: Math.max(st, maxY - minY) / h, area: (n * st * st) / (w * h) };
}

/* ───────────────────────── output / views ───────────────────────── */

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0xc0c4ca;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Blurred copy of the frame for the "portrait blur" backdrop.
export function blurredFrame(rgba, w, h, radius, out) {
  const s = 4, ws = Math.ceil(w / s), hs = Math.ceil(h / s);
  for (let c = 0; c < 3; c++) {
    const plane = scratch('bf.plane', w * h);
    for (let p = 0; p < w * h; p++) plane[p] = rgba[p * 4 + c];
    const d = downsample(plane, w, h, s, scratch('bf.ds', ws * hs)).data;
    const b = gaussianBlur(d, ws, hs, Math.max(1, radius / s), scratch('bf.bl', ws * hs));
    const up = resizePlane(b, ws, hs, w, h, scratch('bf.up', w * h));
    for (let p = 0; p < w * h; p++) out[p * 4 + c] = up[p];
  }
  for (let p = 0; p < w * h; p++) out[p * 4 + 3] = 255;
  return out;
}
