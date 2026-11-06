// ColorPress line-art engine: photo -> black lines on white (a coloring page). Pure JS, no network.
// rgba: Uint8ClampedArray (w*h*4). Returns Uint8ClampedArray gray (w*h), 255 = paper, 0 = ink.
// o: { detail 0..100, thick 0..100, simplify 0..100, clean 0..100, style 'clean'|'sketch'|'bold' }
(function (root) {
  function boxBlur(src, w, h, r, tmp) {
    // horizontal then vertical running sum (r = radius in px)
    if (r < 1) { tmp.set(src); return src.slice(); }
    const out = new Float32Array(w * h), d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / d;
        s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / d;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }
  // Gaussian blur ≈ 3 box blurs
  function gauss(src, w, h, sigma) {
    if (sigma < 0.3) return src.slice();
    const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    const tmp = new Float32Array(w * h);
    let a = src;
    for (let i = 0; i < n; i++) a = boxBlur(a, w, h, ((i < m ? wl : wl + 2) - 1) >> 1, tmp);
    return a;
  }
  // edge-preserving smoothing: a few passes of a 3x3 "guided" average that does not mix across strong steps
  function smoothKeepEdges(L, w, h, passes, t) {
    let a = L, b = new Float32Array(w * h);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x, c = a[i]; let s = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              const v = a[yy * w + xx];
              if (Math.abs(v - c) < t) { s += v; n++; }
            }
          }
          b[i] = s / n;
        }
      }
      const t2 = a; a = b; b = t2 === L ? new Float32Array(w * h) : t2;
    }
    return a;
  }
  // remove ink blobs smaller than minArea pixels (8-connected)
  function removeSpecks(ink, w, h, minArea) {
    if (minArea < 2) return;
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), comp = [];
    for (let i = 0; i < w * h; i++) {
      if (!ink[i] || seen[i]) continue;
      let sp = 0; stack[sp++] = i; seen[i] = 1; comp.length = 0;
      while (sp) {
        const j = stack[--sp]; comp.push(j);
        if (comp.length > minArea) { /* big enough: just flood the rest without keeping */ }
        const x = j % w, y = (j / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const k = yy * w + xx;
            if (ink[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
          }
        }
      }
      if (comp.length < minArea) for (const j of comp) ink[j] = 0;
    }
  }
  function dilate(ink, w, h, r) {
    if (r <= 0) return ink;
    const out = new Uint8Array(w * h), r2 = (r + 0.5) * (r + 0.5);
    const offs = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r2) offs.push([dx, dy]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      for (const [dx, dy] of offs) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1; }
    }
    return out;
  }
  // boundaries between flat colour areas (posterised, smoothed image) – closed outlines that are easy to colour
  function regionEdges(R, G, B, w, h, levels) {
    const q = new Int32Array(w * h), k = Math.max(2, levels);
    for (let i = 0; i < w * h; i++) {
      // luminance-heavy quantisation keeps faces readable; a little colour so red/green areas of the same brightness still part
      const l = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
      const ql = Math.min(k - 1, Math.floor(l * k));
      const cr = Math.min(2, Math.floor((R[i] - l + 0.5) * 3)), cb = Math.min(2, Math.floor((B[i] - l + 0.5) * 3));
      q[i] = ql * 9 + Math.max(0, cr) * 3 + Math.max(0, cb);
    }
    const e = new Uint8Array(w * h);
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (q[i] !== q[i + 1] || q[i] !== q[i + w]) e[i] = 1;
    }
    return e;
  }

  // Edge-preserving smoothing (recursive domain transform, Gastal & Oliveira 2011): flattens skin, fur, sky and
  // walls into even areas while every real outline stays sharp. ch: array of Float32Array channels (0..1).
  function domainTransform(ch, w, h, sigmaS, sigmaR, iters) {
    const N = w * h, dx = new Float32Array(N), dy = new Float32Array(N), k = sigmaS / sigmaR;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let sx = 0, sy = 0;
      for (const c of ch) { if (x) sx += Math.abs(c[i] - c[i - 1]); if (y) sy += Math.abs(c[i] - c[i - w]); }
      dx[i] = 1 + k * sx; dy[i] = 1 + k * sy;
    }
    const out = ch.map((c) => c.slice());
    for (let it = 0; it < iters; it++) {
      const sH = sigmaS * Math.sqrt(3) * Math.pow(2, iters - it - 1) / Math.sqrt(Math.pow(4, iters) - 1);
      const a = Math.exp(-Math.SQRT2 / sH);
      for (const J of out) {
        for (let y = 0; y < h; y++) {
          const o = y * w;
          for (let x = 1; x < w; x++) { const v = Math.pow(a, dx[o + x]); J[o + x] += v * (J[o + x - 1] - J[o + x]); }
          for (let x = w - 2; x >= 0; x--) { const v = Math.pow(a, dx[o + x + 1]); J[o + x] += v * (J[o + x + 1] - J[o + x]); }
        }
        for (let x = 0; x < w; x++) {
          for (let y = 1; y < h; y++) { const i = y * w + x, v = Math.pow(a, dy[i]); J[i] += v * (J[i - w] - J[i]); }
          for (let y = h - 2; y >= 0; y--) { const i = y * w + x, v = Math.pow(a, dy[i + w]); J[i] += v * (J[i + w] - J[i]); }
        }
      }
    }
    return out;
  }
  // Canny-style outlines: thin, continuous lines where the smoothed colour changes clearly
  function canny2(ch, w, h, keep) { return canny(ch, w, h, null, keep); }
  function canny(ch, w, h, detail, keepShare) {
    const N = w * h, mag = new Float32Array(N), dir = new Uint8Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; let best = 0, bgx = 0, bgy = 0;
      for (const c of ch) {
        const gx = (c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1]) - (c[i - w - 1] + 2 * c[i - 1] + c[i + w - 1]);
        const gy = (c[i + w - 1] + 2 * c[i + w] + c[i + w + 1]) - (c[i - w - 1] + 2 * c[i - w] + c[i - w + 1]);
        const m = gx * gx + gy * gy; if (m > best) { best = m; bgx = gx; bgy = gy; }
      }
      mag[i] = Math.sqrt(best);
      const ang = Math.atan2(bgy, bgx) * 4 / Math.PI; dir[i] = ((Math.round(ang) % 4) + 4) % 4;
    }
    // thresholds from the picture itself: keep the strongest few percent of changes (more with more detail)
    const sample = []; for (let i = 0; i < N; i += 7) if (mag[i] > 0.01) sample.push(mag[i]);
    sample.sort((a, b) => a - b);
    const keep = keepShare != null ? keepShare : 0.04 + (detail / 100) * 0.16;
    const hi = Math.max(0.06, sample.length ? sample[Math.floor(sample.length * (1 - keep))] : 0.1), lo = hi * 0.45;
    const nb = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    const edge = new Uint8Array(N); // 2 strong, 1 weak
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < lo) continue;
      const [ox, oy] = nb[dir[i]];
      if (m < mag[i + ox + oy * w] || m < mag[i - ox - oy * w]) continue;
      edge[i] = m >= hi ? 2 : 1;
    }
    const out = new Uint8Array(N), st = [];
    for (let i = 0; i < N; i++) if (edge[i] === 2 && !out[i]) {
      out[i] = 1; st.push(i);
      while (st.length) {
        const j = st.pop();
        for (let dy = -1; dy <= 1; dy++) for (let dx2 = -1; dx2 <= 1; dx2++) {
          const k = j + dx2 + dy * w; if (k >= 0 && k < N && edge[k] && !out[k]) { out[k] = 1; st.push(k); }
        }
      }
    }
    return out;
  }
  // dark-side lines (difference of Gaussians) at a share of the picture chosen by the detail setting
  function dogLines(L, w, h, sigma, share) {
    const N = w * h, g1 = gauss(L, w, h, sigma), g2 = gauss(L, w, h, sigma * 1.6), d = new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = g1[i] - g2[i];
    const sample = []; for (let i = 0; i < N; i += 5) if (d[i] < 0) sample.push(d[i]);
    sample.sort((x, y) => x - y);
    const thr = Math.min(-0.004, sample.length ? sample[Math.min(sample.length - 1, Math.floor(N / 5 * share))] : -0.01);
    const ink = new Uint8Array(N); for (let i = 0; i < N; i++) if (d[i] < thr) ink[i] = 1;
    return ink;
  }
  const STYLES = {
    clean: { dog: 0.035, canny: 0.05, thick: 0, smooth: 1 },
    detailed: { dog: 0.06, canny: 0.1, thick: 0, smooth: 0.6 },
    bold: { dog: 0.02, canny: 0.03, thick: 1.3, smooth: 1.3 },
    sketch: { dog: 0.05, canny: 0, thick: -0.3, smooth: 0.7 },
  };
  function lineArt2(rgba, w, h, o) {
    o = Object.assign({ detail: 50, thick: 40, simplify: 50, clean: 50, style: 'clean' }, o);
    const st = STYLES[o.style] || STYLES.clean;
    const N = w * h, sc = Math.max(w, h) / 1000;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const a = rgba[j + 3] / 255;
      R[i] = (rgba[j] * a + 255 * (1 - a)) / 255; G[i] = (rgba[j + 1] * a + 255 * (1 - a)) / 255; B[i] = (rgba[j + 2] * a + 255 * (1 - a)) / 255;
    }
    const sm = (o.simplify / 100) * st.smooth;
    const [Rs, Gs, Bs] = domainTransform([R, G, B], w, h, (8 + 45 * sm) * sc, 0.1 + 0.25 * sm, 3);
    const L = new Float32Array(N); for (let i = 0; i < N; i++) L[i] = 0.299 * Rs[i] + 0.587 * Gs[i] + 0.114 * Bs[i];
    const df = 0.5 + o.detail / 100; // 0.5 … 1.5
    let ink = dogLines(L, w, h, (1.1 - 0.4 * (df - 0.5)) * sc, st.dog * df);
    if (st.canny) {
      const c2 = canny2([Rs, Gs, Bs], w, h, st.canny * df); for (let i = 0; i < N; i++) if (c2[i]) ink[i] = 1; }
    removeSpecks(ink, w, h, Math.round((8 + o.clean * 2) * sc));
    const r = Math.max(0, Math.round((0.5 + (o.thick / 100) * 2.5 + st.thick) * sc));
    ink = dilate(ink, w, h, r);
    const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = ink[i];
    const soft = gauss(f, w, h, 0.5 * Math.max(1, sc));
    const out = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) out[i] = 255 - Math.min(255, Math.round(soft[i] * 1.5 * 255));
    return out;
  }
  function lineArt(rgba, w, h, o) {
    o = Object.assign({ detail: 50, thick: 40, simplify: 50, clean: 50, style: 'clean' }, o);
    const N = w * h, sc = Math.max(w, h) / 1000; // parameters are tuned for a 1000 px image
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), L = new Float32Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const a = rgba[j + 3] / 255; // transparent = white paper
      R[i] = (rgba[j] * a + 255 * (1 - a)) / 255; G[i] = (rgba[j + 1] * a + 255 * (1 - a)) / 255; B[i] = (rgba[j + 2] * a + 255 * (1 - a)) / 255;
      L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    }
    // 1. simplify: smooth flat areas (skin, sky, fur) but keep the outlines
    const sm = o.simplify / 100;
    const passes = Math.round(1 + sm * 5 * Math.max(1, sc));
    const Ls = smoothKeepEdges(gauss(L, w, h, 0.6 * sc), w, h, passes, 0.06 + 0.1 * sm);
    // 2. lines: difference of Gaussians on the smoothed brightness (dark side of every edge)
    const sigma = (0.9 + (1 - o.detail / 100) * 1.8) * sc;
    const g1 = gauss(Ls, w, h, sigma), g2 = gauss(Ls, w, h, sigma * 1.6);
    const thr = 0.004 + (1 - o.detail / 100) * 0.03;
    let ink = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (g1[i] - g2[i] < -thr) ink[i] = 1;
    // 3. clean / bold styles: add closed outlines around flat areas
    if (o.style !== 'sketch') {
      const sb = (x) => smoothKeepEdges(gauss(x, w, h, (1.5 + 2 * sm) * sc), w, h, passes, 0.08);
      const levels = o.style === 'bold' ? 4 : 5 + Math.round(o.detail / 25);
      const reg = regionEdges(sb(R), sb(G), sb(B), w, h, levels);
      if (o.style === 'bold') ink = reg; else for (let i = 0; i < N; i++) if (reg[i]) ink[i] = 1;
    }
    // 4. remove specks (noise, skin pores, grass) – bigger images have bigger specks
    removeSpecks(ink, w, h, Math.round((4 + o.clean * 1.2) * sc * sc));
    // 5. line thickness
    const r = Math.round((o.thick / 100) * 3 * sc + (o.style === 'bold' ? sc : 0));
    ink = dilate(ink, w, h, r);
    // 6. soft edges (anti-aliasing) so lines print smoothly
    const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = ink[i];
    const soft = gauss(f, w, h, 0.6 * Math.max(1, sc));
    const out = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) out[i] = 255 - Math.min(255, Math.round(soft[i] * 1.6 * 255));
    return out;
  }

  // The AI drawing (grey, 1 = paper) → a clean colouring page: dark, even lines without dust.
  // o.detail 0..100 (faint lines kept), o.thick 0..100, o.clean 0..100 (small bits removed).
  // outW/outH: size of the page picture (the drawing is enlarged smoothly first when it is smaller).
  function finishLines(g, w, h, o, outW, outH) {
    o = Object.assign({ detail: 50, thick: 40, clean: 50 }, o);
    outW = outW || w; outH = outH || h;
    let ink = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = 1 - Math.min(1, Math.max(0, g[i]));
    // pictures drawn very lightly are made as dark as the others: the darkest lines count as full ink
    const smp = []; for (let i = 0; i < w * h; i += 3) if (ink[i] > 0.05) smp.push(ink[i]);
    smp.sort((a, b) => a - b);
    const top = Math.max(0.25, smp.length ? smp[Math.floor(smp.length * 0.97)] : 1);
    for (let i = 0; i < w * h; i++) ink[i] = Math.min(1, ink[i] / top);
    if (outW !== w || outH !== h) ink = resize(ink, w, h, outW, outH);
    const W = outW, H = outH, N = W * H, sc = Math.max(W, H) / 1000;
    // a little blur before the cut so enlarged lines have round, smooth edges
    const sm = gauss(ink, W, H, 0.6 * Math.max(1, sc));
    const thr = 0.42 - 0.34 * (o.detail / 100); // 0.42 … 0.08
    let bin = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (sm[i] > thr) bin[i] = 1;
    removeSpecks(bin, W, H, Math.round((3 + o.clean * 1.2) * sc * sc + o.clean * 0.2 * sc));
    const r = Math.round((o.thick / 100) * 3.2 * sc);
    bin = dilate(bin, W, H, r);
    const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = bin[i];
    const soft = gauss(f, W, H, 0.45 * Math.max(1, sc));
    const out = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) out[i] = 255 - Math.min(255, Math.round(soft[i] * 1.6 * 255));
    return out;
  }
  // bilinear resize of one channel
  function resize(src, w, h, W, H) {
    const out = new Float32Array(W * H), kx = w / W, ky = h / H;
    for (let y = 0; y < H; y++) {
      const fy = Math.max(0, Math.min(h - 1, (y + 0.5) * ky - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.max(0, Math.min(w - 1, (x + 0.5) * kx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
        const a = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * tx, b = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * tx;
        out[y * W + x] = a + (b - a) * ty;
      }
    }
    return out;
  }
  // before the AI: flatten fine texture (fur, grass, skin) so it draws fewer scratchy lines (simplify 0..100)
  function simplifyPhoto(rgba, w, h, simplify) {
    if (simplify <= 0) return rgba;
    const N = w * h, sc = Math.max(w, h) / 1000, R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) { R[i] = rgba[j] / 255; G[i] = rgba[j + 1] / 255; B[i] = rgba[j + 2] / 255; }
    const s = simplify / 100;
    const [r, g, b] = domainTransform([R, G, B], w, h, (4 + 40 * s) * sc, 0.05 + 0.25 * s, 2);
    const out = new Uint8ClampedArray(N * 4);
    for (let i = 0, j = 0; i < N; i++, j += 4) { out[j] = r[i] * 255; out[j + 1] = g[i] * 255; out[j + 2] = b[i] * 255; out[j + 3] = 255; }
    return out;
  }
  const api = { finishLines, resize, simplifyPhoto, domainTransform, removeSpecks, dilate, lineArt: lineArt2, lineArtOld: lineArt, gauss };
  if (typeof module !== 'undefined') module.exports = api; else root.ColorEngine = api;
})(typeof self !== 'undefined' ? self : this);
