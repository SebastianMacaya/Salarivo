import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureSource, id, syntheticPdf } from './fixtures.mjs';

// Optional engine check: use an existing Playwright runtime, without adding a web dependency.
const { webkit } = await import(process.env.SALARIVO_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.SALARIVO_PLAYWRIGHT_MODULE).href : 'playwright');
const base = new URL(process.env.SALARIVO_TEST_URL || 'http://127.0.0.1:3040');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'WebKit smoke requires localhost');
assert.equal(base.protocol, 'https:', 'Serve the local build through HTTPS: WebKit honors upgrade-insecure-requests on localhost.');
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-webkit-qa');
await mkdir(output, { recursive: true });
const browser = await webkit.launch({ headless: true });
const results = [];
const errors = [];
const routes = ['/?section=summary', '/?section=jobs', '/?section=import',
  ...['summary', 'evolution', 'purchasing-power', 'annual', 'concepts', 'documents'].map(tab => `/?section=history&tab=${tab}`),
  '/?section=settings', '/terms', '/privacy', '/not-a-real-route'];

async function check(page, name) {
  try {
    await page.waitForFunction(() => ![...document.querySelectorAll('.loader,[aria-busy=true]')].some(el => el.getClientRects().length));
  } catch (error) {
    await page.screenshot({ path: join(output, 'failure.png') });
    const state = await page.evaluate(() => ({ calls: window.__salarivoFixture?.calls, unhandled: window.__salarivoFixture?.unhandled, loading: [...document.querySelectorAll('.loader,[aria-busy=true]')].filter(el => el.getClientRects().length).map(el => el.outerHTML) }));
    throw new Error(`${name}: ${JSON.stringify({ state, errors })}`, { cause: error });
  }
  const value = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    invalidInputs: [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]),select,textarea')].filter(el => el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < 16).length,
    chartOverflow: [...document.querySelectorAll('.bar-chart')].some(el => el.getClientRects().length && el.scrollHeight > el.clientHeight + 1),
    modalOutside: [...document.querySelectorAll('dialog:modal')].some(el => { const r = el.getBoundingClientRect(); return r.width > innerWidth + 1 || r.height > innerHeight + 1; }),
    unhandled: window.__salarivoFixture?.unhandled,
  }));
  assert.ok(value.scrollWidth <= value.width + 1, `${name}: global overflow`);
  assert.equal(value.invalidInputs, 0, `${name}: inputs smaller than 16px`);
  assert.equal(value.chartOverflow, false, `${name}: clipped chart labels`);
  assert.equal(value.modalOutside, false, `${name}: modal outside viewport`);
  assert.deepEqual(value.unhandled, [], `${name}: unmocked API`);
  results.push({ name, ...value });
}

try {
  for (const width of [320, 390, 768, 1440]) {
    // Only the isolated loopback test certificate is exempted, never a remote origin.
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768, ignoreHTTPSErrors: true });
    await context.addInitScript({ content: fixtureSource() });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    for (const route of routes) {
      await page.goto(new URL(route, base).href);
      await page.waitForFunction(() => document.querySelector('.page,.legal-document,.center-screen'));
      await check(page, `${width}:${route}`);
    }
    await page.goto(new URL('/?section=jobs', base).href);
    await page.getByRole('button', { name: 'Agregar empleo', exact: true }).click();
    await check(page, `${width}:employment-dialog`);
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog:modal')));
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

    await page.goto(new URL(`/?section=history&tab=documents&document=${id(319)}`, base).href);
    await page.locator('#review-title').waitFor();
    await check(page, `${width}:review`);
    assert.ok(await page.evaluate(() => !window.__salarivoFixture.calls.some(call => call.path.endsWith('/original'))));
    if (width < 1024) await page.locator('#review-tab-document').click();
    await page.getByRole('button', { name: 'Mostrar PDF', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas')?.style.width && !document.querySelector('[aria-busy=true]'));
    await page.getByRole('button', { name: 'Acercar', exact: true }).click();
    await check(page, `${width}:pdf-zoom`);
    await page.screenshot({ path: join(output, `${width}-pdf.png`) });
    await page.keyboard.press('Escape');
    await page.locator('#review-title').waitFor({ state: 'detached' });

    await page.goto(new URL('/?section=import', base).href);
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-payroll.pdf', mimeType: 'application/pdf', buffer: Buffer.from(syntheticPdf()) });
    await page.getByRole('button', { name: 'Iniciar importación', exact: true }).click();
    await page.waitForFunction(() => window.__salarivoFixture.calls.some(call => call.path.endsWith('/complete')));
    await check(page, `${width}:upload`);
    await context.setOffline(true);
    await page.getByRole('heading', { name: 'Sin conexión', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog:modal')));
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Sin conexión', exact: true }).waitFor();
    await context.setOffline(false);
    await page.getByRole('heading', { name: 'Sin conexión', exact: true }).waitFor({ state: 'hidden' });
    await check(page, `${width}:reconnect`);
    await context.close();
    console.log(`WebKit ${width}px routes, dialogs, PDF, upload and reconnect passed.`);
  }
  assert.deepEqual(errors, [], 'WebKit runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ engine: await browser.version(), results, errors }, null, 2));
  console.log(`${results.length} WebKit checks passed. This is not a physical Safari/iOS test.`);
} finally { await browser.close(); }
