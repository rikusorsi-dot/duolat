// Duolat service worker: приложение открывается и без интернета.
// При изменении файлов приложения увеличь номер версии (и APP_VERSION в app.js).
const CACHE = 'duolat-v3';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'content.json',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Файлы приложения — сначала из сети (так обновления доходят с первого запуска),
// без сети или при медленной сети — из памяти телефона. Иконки и записи — сначала из памяти.
function fromNetwork(req) {
  const net = fetch(req.url, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(req, copy));
    }
    return res;
  });
  const slow = new Promise((resolve) => setTimeout(resolve, 4000));
  const cached = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
  // Медленная сеть: через 4 секунды отдаём сохранённое, если оно есть.
  return Promise.race([net.catch(() => null), slow.then(cached)])
    .then((res) => res || net)
    .catch(() => cached());
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const cacheFirst = url.pathname.includes('/icons/') || url.pathname.includes('/audio/');
  if (!cacheFirst) {
    event.respondWith(fromNetwork(req));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
