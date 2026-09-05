const CACHE_NAME = 'salarivo-public-__BUILD_VERSION__';
const PUBLIC_ASSETS = new Set(__PUBLIC_ASSETS__);
const OFFLINE_URL = '/offline.html';
const PRECACHE = __PRECACHE__;

function isPublicRequest(request) {
  const url = new URL(request.url);
  return request.method === 'GET' && url.origin === self.location.origin && !url.search
    && !request.headers.has('authorization') && !request.headers.has('range')
    && PUBLIC_ASSETS.has(url.pathname);
}

function isPublicResponse(request, response) {
  const path = new URL(request.url).pathname;
  const mime = response.headers.get('content-type')?.split(';')[0].trim();
  const expected = path.endsWith('.html') ? ['text/html']
    : path.endsWith('.css') ? ['text/css']
      : /\.m?js$/.test(path) ? ['application/javascript', 'text/javascript']
        : path.endsWith('.png') ? ['image/png']
          : path.endsWith('.svg') ? ['image/svg+xml']
            : path.endsWith('.webmanifest') ? ['application/manifest+json', 'application/json']
              : ['font/woff', 'font/woff2', 'application/font-woff'];
  return response.status === 200 && !response.redirected
    && ['basic', 'default'].includes(response.type)
    && (!response.url || response.url === request.url)
    && !/no-store|private/i.test(response.headers.get('cache-control') ?? '')
    && expected.includes(mime);
}

async function fetchPublic(request, cache, required = false) {
  const publicRequest = new Request(request.url, { credentials: 'omit' });
  const response = await fetch(publicRequest, { credentials: 'omit', cache: 'no-cache', redirect: 'error' });
  if (isPublicResponse(publicRequest, response)) {
    try { await cache.put(publicRequest, response.clone()); } catch { /* Storage denial must not break the web app. */ }
  } else if (required) {
    throw new Error('PUBLIC_ASSET_UNAVAILABLE');
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of PRECACHE) {
      await fetchPublic(new Request(new URL(path, self.location.origin)), cache, true);
      if (!await cache.match(new URL(path, self.location.origin))) throw new Error('PUBLIC_CACHE_UNAVAILABLE');
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('salarivo-public-') && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'ACTIVATE_UPDATE' || !event.source?.id) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some((client) => client.id !== event.source.id)) {
      event.source.postMessage({ type: 'UPDATE_OTHER_WINDOWS' });
      return;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations never enter Cache Storage, including redirects and auth query strings.
  const appRoute = ['/', '/terms', '/privacy'].includes(url.pathname)
    || url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  if (request.mode === 'navigate' && appRoute) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(async () => {
      const fallback = await caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL)).catch(() => undefined);
      return fallback
        ?? new Response('Sin conexión. Necesitás Internet para acceder a Salarivo.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }));
    return;
  }

  if (!isPublicRequest(request)) return;
  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(request) ?? await fetchPublic(request, cache);
    } catch {
      return fetch(request, { credentials: 'omit', cache: 'no-cache', redirect: 'error' });
    }
  })());
});
