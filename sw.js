const CACHE = 'colorpress-v2';
const ASSETS = ['./', 'index.html', 'help.html', 'privacy.html', 'style.css', 'app.js', 'worker.js', 'engine.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'sample-cat.jpg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith('colorpress-models') && !k.startsWith('colorpress-lib')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// the app files come from the app cache; the AI runtime from the CDN is kept too so the app works offline
// (the drawing AI itself, model.onnx, is kept by the worker in its own cache)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
    e.respondWith(caches.open('colorpress-lib-v1').then(async (c) => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }));
    return;
  }
  if (/\/model\.(onnx|part[12]\.bin)$/.test(url)) return; // big file: the worker caches it itself
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
