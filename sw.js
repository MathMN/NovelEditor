const CACHE_NAME = 'novel-editor-unified-v15';
const ASSETS = [
  './',
  './index.html',
  './main.js',
  './style.css',
  './writeIcon.png',
  './writeIconIOS.png',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).catch(err => console.error("Cache install failed:", err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Helper to fetch with a timeout so the app never hangs on a white screen
const fetchWithTimeout = (request, timeout = 3000) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Network Timeout')), timeout);
    fetch(request).then(response => {
      clearTimeout(timer);
      resolve(response);
    }).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) return;

  const url = new URL(e.request.url);

  e.respondWith(
    // Always check cache first, ignore query strings to avoid cache misses
    caches.match(e.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      // If root is requested but wasn't perfectly matched, force serve index.html
      if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
          return caches.match('./index.html', { ignoreSearch: true }).then(res => {
              if (res) return res;
              return fetchWithTimeout(e.request);
          });
      }

      // Dynamic fetch with a 3 second timeout
      return fetchWithTimeout(e.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        // Ultimate fallback
        if (e.request.mode === 'navigate' || e.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html', { ignoreSearch: true });
        }
      });
    })
  );
});
