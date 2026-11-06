// ---------- ColorPress worker: photo → line drawing (AI on this PC) and the clean-up into a colouring page ----------
// The drawing AI ("Informative Drawings", MIT licence, Caroline Chan 2022) is downloaded once with the app and kept
// in the browser cache, then everything runs offline. Nothing is ever uploaded.
import './engine.js';
const E = self.ColorEngine;
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.all.min.mjs';
// the AI file is kept in two halves (each small enough for the app's file host); they are joined here
const MODEL = { url: new URL('model.onnx', self.location.href).href, parts: ['model.part1.bin', 'model.part2.bin'].map((p) => new URL(p, self.location.href).href), mb: 17 };
const CACHE = 'colorpress-models-v1';
let ort = null, sess = null, device = 'wasm';
const post = (m, t) => self.postMessage(m, t || []);

async function fetchModel(id) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(MODEL.url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (_) {}
  const total = MODEL.mb * 1.0115e6, parts = []; let got = 0;
  for (const u of MODEL.parts) {
    const res = await fetch(u);
    if (!res.ok) throw new Error('The drawing AI could not be downloaded (' + res.status + ').');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      post({ type: 'progress', id, stage: 'download', pct: Math.min(99, got / total * 100), mb: MODEL.mb });
    }
  }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  try { if (cache) await cache.put(MODEL.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) {}
  return buf;
}
async function session(id) {
  if (sess) return sess;
  if (!ort) { ort = await import(ORT); ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2); }
  const bytes = await fetchModel(id);
  post({ type: 'progress', id, stage: 'start', pct: 100 });
  if ('gpu' in navigator) { try { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); device = 'webgpu'; } catch (_) { sess = null; } }
  if (!sess) { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }); device = 'wasm'; }
  return sess;
}

// draw: { rgba, width, height (already scaled to the drawing size, multiples of 8), simplify }
// → { gray: Float32Array (1 = paper), width, height, ai: true|false }
async function draw(id, m) {
  const W = m.width, H = m.height;
  const rgba = E.simplifyPhoto(new Uint8ClampedArray(m.rgba), W, H, m.simplify || 0);
  try {
    const s = await session(id);
    post({ type: 'progress', id, stage: 'draw', pct: 30 });
    const N = W * H, inp = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { const a = rgba[i * 4 + 3] / 255; inp[i] = (rgba[i * 4] * a + 255 * (1 - a)) / 255; inp[N + i] = (rgba[i * 4 + 1] * a + 255 * (1 - a)) / 255; inp[2 * N + i] = (rgba[i * 4 + 2] * a + 255 * (1 - a)) / 255; }
    const r = await s.run({ input: new ort.Tensor('float32', inp, [1, 3, H, W]) });
    const gray = new Float32Array(r.output.data);
    return { gray, width: W, height: H, ai: true, device };
  } catch (e) {
    // no AI (first start offline, or a very old PC): a simpler drawing made without AI, so the app still works
    const g = E.lineArt(rgba, W, H, { style: 'detailed', detail: 55, thick: 0, simplify: 40, clean: 40 });
    const gray = new Float32Array(W * H); for (let i = 0; i < W * H; i++) gray[i] = g[i] / 255;
    return { gray, width: W, height: H, ai: false, why: String(e && e.message || e) };
  }
}

self.onmessage = async (e) => {
  const m = e.data, id = m.id;
  try {
    if (m.type === 'draw') {
      const r = await draw(id, m);
      post({ type: 'done', id, ...r }, [r.gray.buffer]);
    } else if (m.type === 'finish') {
      // gray drawing → clean black lines at the page's size
      const out = E.finishLines(new Float32Array(m.gray), m.width, m.height, m.opts, m.outW, m.outH);
      post({ type: 'done', id, lines: out, width: m.outW, height: m.outH }, [out.buffer]);
    }
  } catch (err) { post({ type: 'error', id, message: String(err && err.message || err) }); }
};
