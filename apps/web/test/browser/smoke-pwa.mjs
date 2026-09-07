import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openBrowser } from './cdp.mjs';
import { fixtureSource } from './fixtures.mjs';

const upstream = new URL(process.env.PWA_BASE_URL ?? 'http://127.0.0.1:3040');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname), 'PWA smoke requires a local production build');
let workerSource = await (await fetch(new URL('/sw.js', upstream))).text();
let networkAvailable = true;
assert.match(workerSource, /salarivo-public-/);
assert.doesNotMatch(workerSource, /__PUBLIC_ASSETS__/);

// A local proxy serves a second synthetic worker version without editing the real build.
const server = createServer(async (request, response) => {
  if (!networkAvailable) { request.socket.destroy(); return; }
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
      response.end(workerSource);
    } else if (path === '/api/v1/__pwa_probe' || path === '/__qa__/private.pdf') {
      response.writeHead(200, { 'Content-Type': path.endsWith('.pdf') ? 'application/pdf' : 'application/json', 'Cache-Control': 'private, no-store' });
      response.end(path.endsWith('.pdf') ? '%PDF-1.4 synthetic-only' : '{"salary":"1234.56","person":"synthetic"}');
    } else {
      const result = await fetch(new URL(request.url, upstream));
      response.writeHead(result.status, {
        'Content-Type': result.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': result.headers.get('cache-control') ?? 'no-store',
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    }
  } catch {
    response.writeHead(502); response.end('LOCAL_PWA_FIXTURE_FAILURE');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const browser = await openBrowser();

async function until(expression, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(label);
}

try {
  await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__pwaNativeFetch = window.fetch.bind(window);' });
  await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource({ mode: 'guest' }) });
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  await browser.navigate(base);
  await until('Boolean(navigator.serviceWorker.controller)', 'Production service worker must take control');
  const manifest = await browser.command('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  assert.equal(JSON.parse(manifest.data).display, 'standalone');
  const installability = await browser.command('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, [], 'Chromium installability checks must pass');
  await browser.navigate(base);
  await until('Boolean(document.querySelector("main")) && !document.querySelector("main[aria-busy=true]")', 'Login shell must load');
  await browser.evaluate(`Promise.all([window.__pwaNativeFetch('/api/v1/__pwa_probe'), window.__pwaNativeFetch('/__qa__/private.pdf')])`);
  const cacheUrls = await browser.evaluate('(async () => { const urls = []; for (const name of await caches.keys()) { const cache = await caches.open(name); urls.push(...(await cache.keys()).map(request => request.url)); } return urls; })()');
  assert.ok(cacheUrls.some((url) => url.endsWith('/offline.html')));
  assert.ok(cacheUrls.some((url) => url.includes('/_next/static/') && /\.(js|css)$/.test(url)));
  assert.ok(cacheUrls.every((url) => !url.includes('/api/') && !url.includes('/__qa__/') && !new URL(url).search));

  // A modal draft stays mounted, covered and unfocusable during a real network loss.
  await browser.evaluate(`(() => { const modal = document.createElement('dialog'); modal.id = 'pwa-draft-probe'; modal.innerHTML = '<input aria-label="Borrador sintético" value="conservar borrador">'; document.querySelector('main').append(modal); modal.showModal(); modal.querySelector('input').focus(); })()`);
  await browser.command('Network.enable');
  await browser.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until('Boolean(document.querySelector("dialog[aria-labelledby=offline-title]")?.open)', 'Offline layer must open');
  assert.equal(await browser.evaluate('document.activeElement.textContent'), 'Reintentar');
  assert.equal(await browser.evaluate('document.querySelector("#pwa-draft-probe").open'), true);
  assert.equal(await browser.evaluate('document.querySelector("#pwa-draft-probe input").value'), 'conservar borrador');
  await browser.evaluate(`(() => { const modal = document.createElement('dialog'); modal.id = 'pwa-late-probe'; modal.innerHTML = '<button>Resultado sintético tardío</button>'; document.querySelector('main').append(modal); modal.showModal(); })()`);
  await until('document.querySelector("#pwa-late-probe").inert && getComputedStyle(document.querySelector("#pwa-late-probe")).visibility === "hidden" && document.activeElement.textContent === "Reintentar"', 'A pending response must not expose a new modal above the offline layer');
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await browser.evaluate('document.querySelector("dialog[aria-labelledby=offline-title]").open'), true);
  await browser.command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until('!document.querySelector("dialog[aria-labelledby=offline-title]").open', 'Reconnect must restore the same screen');
  assert.equal(await browser.evaluate('document.querySelector("#pwa-draft-probe input").value'), 'conservar borrador');
  assert.equal(await browser.evaluate('document.querySelector("#pwa-late-probe").inert'), false);
  assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#pwa-late-probe")).visibility'), 'visible');
  await browser.evaluate('document.querySelector("#pwa-draft-probe").remove(); document.querySelector("#pwa-late-probe").remove();');

  await browser.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  networkAvailable = false;
  await browser.navigate(`${base}/admin/users?view=synthetic`);
  await until('document.title === "Sin conexión — Salarivo"', 'Offline deep link must render the public fallback');
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  assert.equal(await browser.evaluate('document.body.textContent.includes("1234.56")'), false);
  networkAvailable = true;
  await browser.command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await browser.navigate(base);
  await until('Boolean(navigator.serviceWorker.controller)', 'Online navigation must recover');

  workerSource = workerSource.replace(/salarivo-public-[a-f0-9]+/, 'salarivo-public-synthetic-update');
  await browser.evaluate('(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); })()');
  await until('(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))()', 'New worker must wait for consent');
  assert.equal(await browser.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Actualizar")'), false, 'Browser tabs must not expose the installed-app update control');
  const { identifier: standaloneUpdate } = await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => { const result = nativeMatchMedia(query); if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true }); return result; };
  })();` });
  await browser.navigate(base);
  await until('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Actualizar")', 'Update control must appear in the installed app');
  await browser.evaluate('window.__pwaRetainedDraft = "synthetic-draft"');
  assert.equal(await browser.evaluate('window.__pwaRetainedDraft'), 'synthetic-draft', 'Detecting a version must not reload');
  const clickUpdate = () => browser.command('Runtime.evaluate', { expression: 'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Actualizar").click()' });
  const cancelledClick = clickUpdate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await browser.command('Page.handleJavaScriptDialog', { accept: false });
  await cancelledClick;
  assert.equal(await browser.evaluate('window.__pwaRetainedDraft'), 'synthetic-draft', 'Cancelling an update preserves the current page');
  const other = await browser.command('Target.createTarget', { url: base });
  await until('(async () => { const registration = await navigator.serviceWorker.getRegistration(); return Boolean(registration.waiting); })()', 'Second window must not activate update');
  const firstClick = clickUpdate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await browser.command('Page.handleJavaScriptDialog', { accept: true });
  await firstClick;
  await until('document.body.textContent.includes("Cerrá las otras pestañas")', 'Other windows must block activation');
  assert.equal(await browser.evaluate('window.__pwaRetainedDraft'), 'synthetic-draft');
  await browser.command('Target.closeTarget', { targetId: other.targetId });
  const finalClick = clickUpdate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await browser.command('Page.handleJavaScriptDialog', { accept: true });
  await finalClick;
  await until('typeof window.__pwaRetainedDraft === "undefined" && Boolean(navigator.serviceWorker.controller)', 'Only the confirmed window reloads after activation');
  assert.deepEqual(await browser.evaluate('caches.keys()'), ['salarivo-public-synthetic-update']);
  await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: standaloneUpdate });

  // Chromium property emulation covers progressive enhancement branches, not Safari or OS installation.
  for (const scenario of [
    { name: 'iPhone instructions without install API', userAgent: 'iPhone', platform: 'iPhone', width: 390, instructions: true },
    { name: 'iPad desktop user-agent instructions', userAgent: 'Macintosh', platform: 'MacIntel', touch: 5, width: 1024, instructions: true },
    { name: 'iOS navigator.standalone', userAgent: 'iPhone', platform: 'iPhone', standalone: true },
    { name: 'Android standalone display mode', userAgent: 'Linux; Android; Mobile', displayMode: true },
    { name: 'web without serviceWorker', noWorker: true },
    { name: 'Android phone explicit install prompt', userAgent: 'Linux; Android; Mobile', width: 390, install: true },
    { name: 'Android tablet explicit install prompt', userAgent: 'Linux; Android', width: 1024, install: true },
    { name: 'wide desktop suppresses install invitation', userAgent: 'Windows NT 10.0; Win64; x64', platform: 'Win32', width: 1280, desktop: true },
    { name: 'narrow desktop suppresses install invitation', userAgent: 'Windows NT 10.0; Win64; x64', platform: 'Win32', width: 320, desktop: true },
  ]) {
    await browser.command('Emulation.setDeviceMetricsOverride', { width: scenario.width || 320, height: 640, deviceScaleFactor: 1, mobile: !scenario.desktop });
    const { identifier } = await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const scenario = ${JSON.stringify(scenario)};
      Object.defineProperty(navigator, 'userAgent', { value: scenario.userAgent || 'Synthetic Chromium' });
      Object.defineProperty(navigator, 'platform', { value: scenario.platform || 'Linux' });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: scenario.touch || 0 });
      Object.defineProperty(navigator, 'standalone', { value: Boolean(scenario.standalone) });
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => { const result = nativeMatchMedia(query); if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: Boolean(scenario.displayMode) }); return result; };
      if (scenario.noWorker) delete Navigator.prototype.serviceWorker;
      window.addEventListener('beforeinstallprompt', event => { if (!event.syntheticProbe) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    })();` });
    try {
      await browser.navigate(base);
      await until('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Continuar con Google" && !button.disabled)', `${scenario.name}: normal login remains usable`);
      const instructions = await browser.evaluate('Array.from(document.querySelectorAll("summary")).some(item => item.textContent === "Instalar en iPhone o iPad")');
      assert.equal(instructions, Boolean(scenario.instructions), scenario.name);
      if (scenario.instructions) {
        await browser.evaluate('Array.from(document.querySelectorAll("summary")).find(item => item.textContent === "Instalar en iPhone o iPad").click()');
        assert.equal(await browser.evaluate('Array.from(document.querySelectorAll("details[open] p")).some(item => item.textContent.includes("Compartir") && item.getBoundingClientRect().height > 0)'), true, scenario.name);
      }
      if (scenario.noWorker) assert.equal(await browser.evaluate('"serviceWorker" in navigator'), false);
      if (scenario.install || scenario.standalone || scenario.displayMode || scenario.desktop) {
        await browser.evaluate(`(() => { window.__pwaPromptCalls = 0; const event = new Event('beforeinstallprompt', { cancelable: true }); event.syntheticProbe = true; event.prompt = async () => { window.__pwaPromptCalls += 1; }; event.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(event); window.__pwaPromptPrevented = event.defaultPrevented; })()`);
        if (scenario.install) {
          await until('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Instalar Salarivo")', 'Install button appears only after an available prompt');
          assert.equal(await browser.evaluate('window.__pwaPromptCalls'), 0, 'Installation never opens automatically');
          await browser.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Instalar Salarivo").click()');
          await until('window.__pwaPromptCalls === 1 && !Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Instalar Salarivo")', 'Only a click opens the prompt and dismissal keeps the web usable');
        } else {
          await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          assert.equal(await browser.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Instalar Salarivo")'), false, scenario.name);
          assert.equal(await browser.evaluate('window.__pwaPromptCalls'), 0, scenario.name);
          if (scenario.desktop) {
            assert.equal(await browser.evaluate('window.__pwaPromptPrevented'), true, `${scenario.name}: native invitation suppressed`);
            assert.equal(await browser.evaluate(`Boolean(document.querySelector('aside[aria-label="Aplicación Salarivo"]'))`), false, `${scenario.name}: no empty invitation band`);
          }
        }
      } else assert.equal(await browser.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Instalar Salarivo")'), false, scenario.name);
    } finally {
      await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  }
  console.log('PWA browser smoke passed: manifest, public-only cache, offline modal/draft/deep link, reconnect, controlled multi-window update and nine emulated progressive enhancement scenarios.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
