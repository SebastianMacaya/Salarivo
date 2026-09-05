import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const origin = 'https://salarivo.example';
const asset = '/_next/static/chunks/app.synthetic.js';
const publicAssets = ['/offline.html', '/pwa/icon-192.png', asset];
const template = await readFile(new URL('../pwa/service-worker.js', import.meta.url), 'utf8');
type RequestLike = { url: string; method: string; mode: string; headers: Headers };
type WorkerEvent = { request?: RequestLike; data?: unknown; source?: { id: string; postMessage(message: unknown): void }; waitUntil(work: Promise<unknown>): void; respondWith(work: Promise<Response>): void };

function worker() {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const requests: { path: string; options: RequestInit }[] = [];
  const messages: unknown[] = [];
  const state = { offline: false, privateResponse: false, badMime: false, redirect: false, failStorage: false, skipped: 0, claimed: 0, clients: ['current'] };
  const keyOf = (key: string | URL | RequestLike | Request) => new URL(typeof key === 'string' || key instanceof URL ? key.toString() : key.url, origin).href;
  const caches = {
    async open(name: string) {
      if (state.failStorage) throw new Error('Storage blocked');
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return {
        async match(key: string | URL | RequestLike | Request) { return entries.get(keyOf(key))?.clone(); },
        async put(key: string | URL | RequestLike | Request, response: Response) { entries.set(keyOf(key), response); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
  };
  runInNewContext(template.replace('__BUILD_VERSION__', 'test').replace('__PUBLIC_ASSETS__', JSON.stringify(publicAssets)).replace('__PRECACHE__', JSON.stringify(['/offline.html', '/pwa/icon-192.png'])), {
    URL, Request, Response, caches,
    self: {
      location: { origin },
      addEventListener(type: string, handler: (event: WorkerEvent) => void) { handlers.set(type, handler); },
      clients: { async matchAll() { return state.clients.map((id) => ({ id })); }, async claim() { state.claimed += 1; } },
      async skipWaiting() { state.skipped += 1; },
    },
    async fetch(request: RequestLike | Request, options: RequestInit) {
      const path = new URL(request.url).pathname;
      requests.push({ path, options });
      if (state.offline) throw new TypeError('Offline');
      const response = new Response(path === '/offline.html' ? '<h1>Sin conexión</h1>' : 'synthetic public content', {
        headers: {
          'content-type': state.badMime ? 'application/json' : path.endsWith('.html') ? 'text/html' : path.endsWith('.png') ? 'image/png' : 'application/javascript',
          'cache-control': state.privateResponse ? 'private, no-store' : 'public, max-age=0',
        },
      });
      if (state.redirect) Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
  });
  async function dispatch(type: string, input: Partial<WorkerEvent> = {}) {
    let response: Promise<Response> | undefined;
    let pending: Promise<unknown> | undefined;
    handlers.get(type)?.({ ...input, waitUntil(work) { pending = work; }, respondWith(work) { response = work; } });
    await pending;
    return { handled: Boolean(response), response: await response };
  }
  const request = (path: string, options: Partial<RequestLike> = {}) => dispatch('fetch', { request: { url: new URL(path, origin).href, method: 'GET', mode: 'cors', headers: new Headers(), ...options } });
  return { state, stores, requests, messages, dispatch, request };
}

test('manifest and icons support installation without private start URLs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.display, 'standalone');
  for (const key of ['name', 'short_name', 'description', 'theme_color', 'background_color']) assert.ok(manifest[key]);
  assert.ok(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable'));
  for (const [path, width] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
    const png = await readFile(new URL(`../public/pwa/${path}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), width);
  }
});

test('worker caches only exact public assets, never private data or auth responses', async () => {
  const sw = worker();
  await sw.dispatch('install');
  assert.equal(sw.state.skipped, 0, 'install never forces activation');
  await sw.request(asset);
  assert.equal(sw.requests.at(-1)?.options.credentials, 'omit');
  const fetched = sw.requests.length;
  await sw.request(asset);
  assert.equal(sw.requests.length, fetched, 'public compiler asset is served from cache');
  for (const path of ['/api/v1/auth/me', '/api/v1/documents', '/api/v1/salary-history', '/api/v1/exports/private', '/api/v1/auth/google/callback?code=synthetic', '/private.pdf', '/admin/users', '/?auth=synthetic', `${asset}?token=synthetic`, '/_next/static/chunks/unknown.js', 'https://storage.example/private.pdf?signature=synthetic']) {
    assert.equal((await sw.request(path)).handled, false, path);
  }
  for (const options of [{ method: 'POST' }, { headers: new Headers({ authorization: 'Bearer synthetic' }) }, { headers: new Headers({ range: 'bytes=0-10' }) }]) assert.equal((await sw.request(asset, options)).handled, false);
  assert.equal(sw.requests.length, fetched);
  assert.deepEqual([...sw.stores.values()].flatMap((entries) => [...entries.keys()]).sort(), publicAssets.map((path) => `${origin}${path}`).sort());
});

test('private headers, wrong MIME and redirects never enter public cache', async () => {
  for (const invalid of ['privateResponse', 'badMime', 'redirect'] as const) {
    const sw = worker();
    sw.state[invalid] = true;
    await sw.request(asset);
    assert.equal([...sw.stores.values()].flatMap((entries) => [...entries.keys()]).length, 0, invalid);
  }
  const unavailable = worker();
  unavailable.state.failStorage = true;
  assert.equal((await unavailable.request(asset)).response?.status, 200, 'blocked Cache Storage keeps normal network behavior');
});

test('deep links use network without persisting HTML, offline returns only public fallback', async () => {
  const sw = worker();
  await sw.dispatch('install');
  const before = [...sw.stores.values()].reduce((total, entries) => total + entries.size, 0);
  await sw.request('/admin/users?cursor=synthetic', { mode: 'navigate' });
  assert.equal(sw.requests.at(-1)?.options.cache, 'no-store');
  assert.equal([...sw.stores.values()].reduce((total, entries) => total + entries.size, 0), before);
  sw.state.offline = true;
  const fallback = await sw.request('/?section=documents&documentId=synthetic', { mode: 'navigate' });
  assert.equal(await fallback.response?.text(), '<h1>Sin conexión</h1>');
  assert.equal((await sw.request('/api/v1/auth/google/callback?code=synthetic', { mode: 'navigate' })).handled, false);
});

test('update needs explicit request with no other windows; activation cleans only Salarivo public caches', async () => {
  const sw = worker();
  const source = { id: 'current', postMessage(message: unknown) { sw.messages.push(message); } };
  await sw.dispatch('message', { data: { type: 'UNKNOWN' }, source });
  assert.equal(sw.state.skipped, 0);
  sw.state.clients = ['current', 'other'];
  await sw.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' }, source });
  assert.equal(sw.state.skipped, 0);
  assert.equal(JSON.stringify(sw.messages), '[{"type":"UPDATE_OTHER_WINDOWS"}]');
  sw.state.clients = ['current'];
  await sw.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' }, source });
  assert.equal(sw.state.skipped, 1);
  sw.stores.set('salarivo-public-old', new Map());
  sw.stores.set('salarivo-public-test', new Map());
  sw.stores.set('unrelated', new Map());
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()], ['salarivo-public-test', 'unrelated']);
  assert.equal(sw.state.claimed, 1);
});
