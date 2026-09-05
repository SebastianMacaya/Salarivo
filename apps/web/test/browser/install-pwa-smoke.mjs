import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureSource } from './fixtures.mjs';

// Optional native install test. Uses the browser's installer and uninstaller,
// including temporary OS integration; never attaches to a personal profile.
const { chromium } = await import(process.env.SALARIVO_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.SALARIVO_PLAYWRIGHT_MODULE).href : 'playwright');
const executablePath = process.env.SALARIVO_TEST_BROWSER;
assert.ok(executablePath, 'Set SALARIVO_TEST_BROWSER to the explicit Chrome or Edge executable.');
await access(executablePath);
const upstream = new URL(process.env.PWA_BASE_URL || 'http://127.0.0.1:3040');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname), 'Native install smoke requires a local build.');
assert.ok(['http:', 'https:'].includes(upstream.protocol));
const identity = randomUUID();
const testName = `Salarivo QA ${identity.slice(0, 8)}`;
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), `salarivo-install-result-${identity}`);
await mkdir(output, { recursive: true });

// A unique loopback origin isolates the manifest identity from any other app.
// Only its display names change, preventing collisions in native shortcut names.
const server = createServer(async (request, response) => {
  try {
    const target = new URL(request.url, upstream);
    if (target.origin !== upstream.origin || !['GET', 'HEAD'].includes(request.method)
      || target.pathname.startsWith('/api/')) {
      response.writeHead(403); response.end('SYNTHETIC_INSTALL_ONLY'); return;
    }
    const result = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const headers = Object.fromEntries([...result.headers].filter(([name]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(name)));
    if (target.pathname === '/manifest.webmanifest' && result.ok) {
      const manifest = await result.json();
      assert.equal(manifest.id, '/');
      assert.equal(manifest.start_url, '/');
      response.writeHead(result.status, headers);
      response.end(JSON.stringify({ ...manifest, name: testName, short_name: testName }));
    } else {
      response.writeHead(result.status, headers);
      response.end(Buffer.from(await result.arrayBuffer()));
    }
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end('LOCAL_INSTALL_PROXY_FAILURE');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const manifestId = `${base}/`;
const profile = await mkdtemp(join(tmpdir(), 'salarivo-pwa-install-'));
let context;
let session;
let installAttempted = false;
let failure;
let cleanupFailure;
const errors = [];
const result = { identity, manifestId, displayName: testName, syntheticSession: true, nativeStandalone: false,
  installed: false, uninstalled: false, profileRemoved: false, checks: [] };

async function assertAbsent() {
  await assert.rejects(session.send('PWA.getOsAppState', { manifestId }),
    (error) => error.message.includes(`Unknown web-app manifest id ${manifestId}`),
    'The isolated manifest must be absent from the native app registry.');
}

async function checkApp(page, name) {
  await page.waitForFunction(() => Boolean(window.__salarivoFixture)
    && document.querySelector('#private-content .page h1')
    && ![...document.querySelectorAll('.loader,[aria-busy=true]')].some((element) => element.getClientRects().length));
  assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true, `${name}: native standalone`);
  assert.equal(await page.getByRole('button', { name: 'Instalar Salarivo', exact: true }).count(), 0, `${name}: install action hidden`);
  assert.deepEqual(await page.evaluate(() => window.__salarivoFixture.unhandled), [], `${name}: synthetic API coverage`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no global overflow`);
  result.checks.push(name);
}

try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    chromiumSandbox: true, viewport: null, args: ['--window-size=1280,900'] });
  context.setDefaultTimeout(20000);
  await context.addInitScript({ content: fixtureSource() });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  session = await context.browser().newBrowserCDPSession();
  result.browser = await session.send('Browser.getVersion');
  await assertAbsent();
  const page = context.pages()[0];
  await page.goto(base);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const pageSession = await context.newCDPSession(page);
  const manifest = await pageSession.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  assert.equal(JSON.parse(manifest.data).name, testName);
  assert.deepEqual((await pageSession.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), false);

  installAttempted = true; // Cleanup also runs if installation returns an uncertain failure.
  await session.send('PWA.install', { manifestId, installUrlOrBundleUrl: base });
  result.osState = await session.send('PWA.getOsAppState', { manifestId });
  result.installed = true;
  // CDP's URL installer defaults its user preference to browser. Select the
  // native "open in app window" preference; do not emulate display-mode.
  await session.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' });
  let launched;
  let appPage;
  result.openMethod = 'PWA.launch';
  try { launched = await session.send('PWA.launch', { manifestId }); }
  catch (error) {
    if (!error.message.includes(`Protocol error (PWA.launch): Failed to launch ${manifestId}`)) throw error;
    result.launchError = error.message;
    result.openMethod = 'PWA.openCurrentPageInApp';
    await pageSession.send('PWA.openCurrentPageInApp', { manifestId });
    appPage = page;
  }
  if (launched) {
    const launchWindow = await session.send('Browser.getWindowForTarget', { targetId: launched.targetId });
    result.launchTargetType = (await session.send('Target.getTargetInfo', { targetId: launched.targetId })).targetInfo.type;
    const deadline = Date.now() + 20000;
    while (!appPage && Date.now() < deadline) {
      for (const candidate of context.pages()) {
        const candidateSession = await context.newCDPSession(candidate);
        try {
          const info = (await candidateSession.send('Target.getTargetInfo')).targetInfo;
          // Chromium can return a tab target while Playwright attaches its page target.
          const candidateWindow = await session.send('Browser.getWindowForTarget', { targetId: info.targetId });
          if (candidate !== page && candidateWindow.windowId === launchWindow.windowId) { appPage = candidate; break; }
        } finally { await candidateSession.detach(); }
      }
      if (!appPage) await new Promise((done) => setTimeout(done, 100));
    }
  }
  assert.ok(appPage, 'The native launch target must become a Playwright page.');
  await appPage.waitForURL(`${base}/`);
  await appPage.waitForFunction(() => matchMedia('(display-mode: standalone)').matches);
  await checkApp(appPage, 'native launch');
  result.nativeStandalone = true;
  await appPage.goto(`${base}/?section=history&tab=documents`);
  await appPage.locator('.document-row').first().waitFor();
  await checkApp(appPage, 'deep link');
  await appPage.goBack();
  await appPage.waitForURL(`${base}/`);
  await appPage.locator('.salary-metrics').waitFor();
  await checkApp(appPage, 'native back');
  await appPage.reload();
  await checkApp(appPage, 'native reload');
  await appPage.screenshot({ path: join(output, 'standalone.png') });
  assert.deepEqual(errors, [], 'Native app runtime errors');
} catch (error) {
  failure = error;
} finally {
  if (installAttempted) {
    try {
      try { await session.send('PWA.uninstall', { manifestId }); }
      catch (error) { await assertAbsent(); result.uninstallResponse = error.message; }
      await assertAbsent();
      result.uninstalled = true;
    } catch (error) { cleanupFailure = error; }
  }
  try { await context?.close(); }
  catch (error) { cleanupFailure ||= error; }
  // Preserve the exact profile for native recovery if uninstall was not verified.
  // Never manually remove OS shortcuts, registrations, or other applications.
  if (!cleanupFailure) {
    try {
      const target = resolve(profile);
      assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}salarivo-pwa-install-`));
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      result.profileRemoved = true;
    } catch (error) { cleanupFailure = error; }
  }
  if (cleanupFailure) result.retainedProfile = profile;
  result.errors = errors;
  result.failure = failure?.message || null;
  result.cleanupFailure = cleanupFailure?.message || null;
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
}
if (cleanupFailure) throw new AggregateError([failure, cleanupFailure].filter(Boolean), `Native cleanup incomplete; preserve ${profile} for recovery.`);
if (failure) throw failure;
console.log(`Native PWA install passed in ${result.browser.product} via ${result.openMethod}: ${result.checks.join(', ')}; uninstall verified and isolated profile removed. Evidence: ${output}`);
