// 화면 파일은 온라인이면 항상 최신으로 받고(수정 즉시 반영), 오프라인이면 저장해 둔 것을 씁니다.
// lib/ 안의 pdf.js와 글꼴 데이터는 바뀌지 않으므로 한 번 받으면 계속 저장본을 씁니다.
const CACHE = 'pdfv-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icons.js', 'stamps.js', 'edit.js', 'manifest.webmanifest', 'icon-192.png',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/lib/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
