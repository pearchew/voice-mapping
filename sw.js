// Offline shell. Bump VERSION whenever app files change.
const VERSION = 'vm-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'sync.js', 'prompts.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // App shell: network first (so updates land), cache as fallback offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
    );
    return;
  }

  // Fonts and the Supabase SDK: cache first, they're versioned.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })),
    );
  }
  // Everything else (Supabase API, storage) goes straight to the network.
});
