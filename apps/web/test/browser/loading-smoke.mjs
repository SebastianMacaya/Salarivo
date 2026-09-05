import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './cdp.mjs';
import { fixtureSource } from './fixtures.mjs';

const base = process.env.SALARIVO_TEST_URL || 'http://localhost:3000';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-loading-qa');
const browser = await openBrowser();
const measurements = [];
let injection;

async function visit(path, options = {}, extra = '') {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource({ mode: 'owner', ...options }) + extra })).identifier;
  await browser.navigate(new URL(path, base).href);
}

async function measure(width, area, mfaEnabled = true) {
  const summary = area === 'summary';
  const selector = summary ? '.recent-panel' : '.sessions-card';
  const loading = summary ? '.salary-loading' : '.mfa-loading';
  await browser.viewport(width, 844);
  await visit(summary ? '/' : '/?section=settings&tab=security', {}, `
    const syntheticFetch = window.fetch;
    window.fetch = async (...args) => {
      const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
      if (path === ${JSON.stringify(summary ? '/api/v1/salary-history' : '/api/v1/auth/mfa')}) {
        window.__delayedRequest = true;
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      const response = await syntheticFetch(...args);
      if (!${mfaEnabled} && (path === '/api/v1/auth/me' || path === '/api/v1/auth/mfa')) {
        const payload = await response.json();
        if (path.endsWith('/me')) payload.data.mfaEnabled = false;
        else payload.data = { enabled: false, pendingEnrollment: false, recoveryCodesRemaining: 0 };
        return Response.json(payload);
      }
      return response;
    };
  `);
  await browser.waitFor(`window.__delayedRequest && document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(`${selector} .compact-loading`)})`);
  assert.ok(await browser.evaluate(`!!document.querySelector(${JSON.stringify(loading)})`), `${area}: capture must start while the delayed response is still loading`);
  const before = await browser.evaluate(`(() => {
    window.__loadingShifts = [];
    window.__loadingObserver = new PerformanceObserver(list => window.__loadingShifts.push(...list.getEntries().filter(entry => !entry.hadRecentInput).map(entry => entry.value)));
    window.__loadingObserver.observe({ type: 'layout-shift' });
    return document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top;
  })()`);
  await browser.screenshot(join(output, `${area}-${mfaEnabled ? 'enabled' : 'disabled'}-${width}-loading.png`));
  await browser.waitFor(`!document.querySelector(${JSON.stringify(loading)}) && ${summary ? "document.querySelector('.salary-metrics') && document.querySelector('.salary-chart')" : "document.querySelector('#settings-panel-security .setting-heading .status')"}`);
  // Let the observer receive the render; there are no clicks or recent-input exclusions in this interval.
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const result = await browser.evaluate(`({ cls: window.__loadingShifts.reduce((sum, value) => sum + value, 0), top: document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top, width: innerWidth, scroll: document.documentElement.scrollWidth, unhandled: window.__salarivoFixture.unhandled })`);
  await browser.screenshot(join(output, `${area}-${mfaEnabled ? 'enabled' : 'disabled'}-${width}-ready.png`));
  assert.deepEqual(result.unhandled, [], `${area}: unexpected fixture request`);
  assert.ok(result.scroll <= result.width + 1, `${area}: horizontal overflow`);
  measurements.push({ area, mfaEnabled: summary ? undefined : mfaEnabled, width, delayMs: 2500, before, after: result.top, displacement: result.top - before, cls: result.cls });
}

try {
  await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1280]) {
    await measure(width, 'summary');
    await measure(width, 'mfa');
    await measure(width, 'mfa', false);
  }
  await browser.viewport(390, 844);
  await visit('/?section=settings&tab=security', { failPaths: ['/auth/sessions'] });
  await browser.waitFor("document.querySelector('.sessions-card .message.error')");
  assert.deepEqual(await browser.evaluate("({ count: !!document.querySelector('.sessions-card .setting-heading .status'), list: !!document.querySelector('.sessions-card .session-list'), bulkAction: !!document.querySelector('.sessions-card .session-footer'), empty: !!document.querySelector('.sessions-card .session-empty') })"), { count: false, list: false, bulkAction: false, empty: false }, 'A failed request must not assert that there are zero sessions or allow actions on unconfirmed state.');
  await browser.evaluate("window.__salarivoFixture.failPaths = []; document.querySelector('.sessions-card .message.error button').click()");
  await browser.waitFor("document.querySelectorAll('.sessions-card .session-row').length === 2 && !document.querySelector('.sessions-card .message.error')");
  assert.equal(await browser.evaluate("document.querySelector('.sessions-card .setting-heading .status').textContent"), '2', 'Retry restores the confirmed session count.');
  await writeFile(join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ measurements, sessionsErrorRetry: 'passed', output }, null, 2));
  for (const result of measurements) assert.ok(result.cls < 0.1, `${result.area} ${result.width}px MFA ${result.mfaEnabled}: CLS ${result.cls} should be below 0.1`);
} finally {
  await browser.close();
}
