import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id, syntheticPdf } from './fixtures.mjs';

const base = process.env.SALARIVO_TEST_URL || 'http://localhost:3000';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-responsive-qa');
await mkdir(output, { recursive: true });
const browser = await openBrowser();
const measurements = [];
const exceptions = [];
browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
let injection;

async function visit(path, mode = 'owner', options = {}) {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource({ mode, ...options }) })).identifier;
  await browser.navigate(new URL(path, base).href);
  try {
    await browser.waitFor('window.__salarivoFixture && document.querySelector("h1,h2") && !Array.from(document.querySelectorAll(".loader,[aria-busy=true]")).some(el => el.getClientRects().length)');
  } catch (error) {
    await browser.screenshot(join(output, 'failure.png'));
    const state = await browser.evaluate('({fixture:!!window.__salarivoFixture, ready:document.readyState, path:location.pathname, title:document.title, loaders:[...document.querySelectorAll(".loader,[aria-busy=true]")].map(el=>el.className)})');
    throw new Error(`${mode} ${path}: ${JSON.stringify(state)}`, { cause: error });
  }
  assert.deepEqual(await browser.evaluate('window.__salarivoFixture.unhandled'), [], `Unmocked route at ${path}`);
}

async function layout(name, screenshot = false) {
  const result = await browser.evaluate(`(() => {
    const root = document.documentElement;
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"],dialog:modal');
    return { width: innerWidth, scrollWidth: root.scrollWidth, height: innerHeight,
      dialog: dialog && { width: dialog.getBoundingClientRect().width, height: dialog.getBoundingClientRect().height },
      chartVerticalOverflow: [...document.querySelectorAll('.bar-chart')].some(el => el.getClientRects().length && el.scrollHeight > el.clientHeight + 1),
      tinyInputs: [...document.querySelectorAll('input:not([type="checkbox"]):not([type="file"]),select,textarea')].filter(el => el.getClientRects().length && !el.closest('[hidden]') && parseFloat(getComputedStyle(el).fontSize) < 16).length };
  })()`);
  measurements.push({ name, ...result });
  assert.ok(result.scrollWidth <= result.width + 1, `${name}: overflow ${result.scrollWidth}/${result.width}`);
  assert.equal(result.tinyInputs, 0, `${name}: inputs below 16px`);
  assert.equal(result.chartVerticalOverflow, false, `${name}: chart labels need vertical scrolling`);
  if (result.dialog) {
    assert.ok(result.dialog.width <= result.width + 1, `${name}: dialog too wide`);
    assert.ok(result.dialog.height <= result.height + 1, `${name}: dialog too tall`);
  }
  if (screenshot) await browser.screenshot(join(output, `${result.width}-${name}.png`));
}

async function clickText(text, selector = 'button') {
  const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.getClientRects().length && !el.disabled && (el.getAttribute('aria-label') || el.textContent.trim()) === ${JSON.stringify(text)})`;
  await browser.waitFor(target);
  const found = await browser.evaluate(`(() => { const el = ${target}; if (!el) return false; el.click(); return true; })()`);
  assert.ok(found, `Missing visible control: ${text}`);
}
async function click(selector) {
  assert.ok(await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`), `Missing selector: ${selector}`);
}

try {
  const scenarios = [
    ['login', '/', 'guest'], ['registration', '/?auth=google-registration', 'guest'], ['oauth-error', '/?auth=google-failed', 'guest'], ['oauth-return', '/?auth=google-success'], ['mfa', '/', 'mfa'], ['onboarding', '/', 'onboarding'], ['acceptance', '/', 'acceptance'],
    ['summary', '/?section=summary'], ['jobs', '/?section=jobs'], ['import', '/?section=import'],
    ...['summary', 'evolution', 'purchasing-power', 'annual', 'concepts', 'documents'].map(tab => [`history-${tab}`, `/?section=history&tab=${tab}`]),
    ['settings', '/?section=settings'], ['terms', '/terms'], ['privacy', '/privacy'], ['not-found', '/not-a-real-route'],
  ];
  if (!process.argv.includes('--flows-only')) {
  for (const width of [320, 1440]) {
    await browser.viewport(width, 900);
    for (const [name, path, mode] of scenarios) {
      await visit(path, mode);
      await layout(name, true);
      if (name === 'summary' || name === 'history-evolution') {
        await browser.evaluate('document.querySelector(".chart-panel")?.scrollIntoView({block:"start"})');
        await layout(`${name}-chart`, true);
      }
      if (name === 'login') { await clickText('Consultar comprobante de eliminación'); await layout('deletion-receipt-lookup', true); }
      if (name === 'history-annual') { await click('.annual-card summary'); await layout(`${name}-expanded`, true); }
      if (name === 'history-documents') { await click('.filter-panel summary'); await layout('document-filters', true); }
      if (name === 'settings') {
        for (const tab of ['privacy', 'account']) { await click(`#settings-tab-${tab}`); await layout(`settings-${tab}`, true); }
        await clickText('Eliminar cuenta'); await browser.waitFor('document.querySelector("dialog:modal")'); await layout('account-deletion-confirmation', true); await clickText('Cancelar');
      }
    }
    process.stdout.write(`Core routes at ${width}px passed.\n`);
  }

  for (const [width, height] of [[360, 800], [375, 812], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1920, 1080], [2560, 1440], [844, 390]]) {
    await browser.viewport(width, height, width < 768 || height < 500);
    for (const tab of ['summary', 'documents', 'evolution']) {
      await visit(`/?section=history&tab=${tab}`);
      await layout(`range-${tab}`, width === 390 || height < 500);
      if (tab === 'evolution' && (width === 390 || height < 500)) {
        await browser.evaluate('document.querySelector(".chart-panel")?.scrollIntoView({block:"start"})');
        await layout('range-evolution-chart', true);
      }
    }
  }
  process.stdout.write('Viewport sweep 320–2560 and landscape passed.\n');
  }

  for (const width of [320, 1440]) {
    await browser.viewport(width, 850);
    await visit('/?section=summary', 'owner', { private: true });
    assert.ok(await browser.evaluate('document.body.innerText.includes("••••••••")'));
    await clickText('Mostrar importes');
    await browser.waitFor('!document.body.innerText.includes("••••••••")');
    await clickText('Ocultar importes');
    await browser.waitFor('document.body.innerText.includes("••••••••")');

    await visit('/?section=jobs');
    await clickText('Agregar empleo');
    await browser.waitFor('document.querySelector("dialog:modal,[role=dialog]")');
    await layout('employment-form', true);
    await clickText('Cancelar');

    await visit(`/?section=history&tab=documents&document=${id(319)}`);
    await browser.waitFor('document.querySelector("#review-title")');
    await layout('document-data', true);
    await browser.evaluate('document.querySelector("#review-data-panel article").scrollIntoView({block:"nearest"})');
    const scrollBeforeHover = await browser.evaluate('document.querySelector("#review-data-panel").scrollTop');
    await browser.evaluate('document.querySelector("#review-data-panel article").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await browser.evaluate('document.querySelector("#review-data-panel").scrollTop'), scrollBeforeHover, 'Hover unexpectedly scrolled the review form.');
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(call=>call.path.endsWith("/original")) && !document.querySelector("canvas")'), 'The original loaded before an explicit request.');
    await clickText('Ver fuente · pág. 1');
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(call=>call.path.endsWith("/original"))'), 'Selecting evidence unexpectedly downloaded the original.');
    if (width < 1024) await click('#review-tab-data');
    await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.ok(await browser.evaluate('!!document.activeElement.closest("dialog:modal")'), 'Focus escaped document review.');
    await clickText('Editar');
    await layout('document-edit', true);
    assert.ok(await browser.evaluate('!!document.querySelector("#review-data-panel input[inputmode=decimal]")'));
    if (width < 768) {
      await browser.viewport(width, 450);
      await browser.evaluate('const field = document.querySelector("#review-data-panel input[inputmode=decimal]"); field.focus(); field.scrollIntoView({block:"center"})');
      await layout('document-keyboard-height', true);
      await browser.viewport(width, 850);
    }
    await clickText('Cancelar');
    if (width < 1024) await click('#review-tab-document');
    if (!await browser.evaluate('!!document.querySelector("canvas")')) await clickText('Mostrar PDF');
    await browser.waitFor('document.querySelector("canvas")?.style.width && !document.querySelector("[aria-busy=true]")', 30000);
    await layout('pdf-fit', true);
    await clickText('Acercar'); await clickText('Acercar'); await clickText('Acercar');
    await browser.waitFor('!document.querySelector("[aria-busy=true]")');
    const edge = await browser.evaluate(`(() => { const canvas = document.querySelector('canvas'); const viewport = canvas.closest('[role="region"]'); viewport.scrollLeft = 0; return { canvasLeft: canvas.getBoundingClientRect().left, viewportLeft: viewport.getBoundingClientRect().left }; })()`);
    assert.ok(edge.canvasLeft >= edge.viewportLeft - 1, 'Zoom lost the left edge of the PDF.');
    await layout('pdf-zoom', true);
    await clickText('Vista y descarga', 'summary');
    await layout('pdf-options', true);
    await click('[aria-label="Evidencia de Neto"]');
    await browser.waitFor(`(() => { const field = document.getElementById('field-${id(55)}'); const pane = document.querySelector('#review-data-panel'); if (!field || !pane.getClientRects().length) return false; const rect=field.getBoundingClientRect(), bounds=pane.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom; })()`);
    await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.waitFor('!document.querySelector("#review-title")');

    await visit(`/?section=history&tab=documents&document=${id(319)}`, 'owner', { private: true });
    await browser.waitFor('document.querySelector("#review-title")');
    if (width < 1024) await click('#review-tab-document');
    const stopDismiss = browser.on('Page.javascriptDialogOpening', () => { void browser.command('Page.handleJavaScriptDialog', { accept: false }); });
    await clickText('Mostrar PDF');
    stopDismiss();
    assert.ok(await browser.evaluate('!document.querySelector("canvas") && !window.__salarivoFixture.calls.some(call=>call.path.endsWith("/original"))'), 'Cancelling the privacy warning loaded the original.');
    await layout('pdf-privacy-cancelled', true);

    await visit('/?section=import');
    await browser.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(syntheticPdf())}], 'synthetic-payroll.pdf', {type:'application/pdf'})); transfer.items.add(new File(['synthetic'], 'unsupported.txt', {type:'text/plain'})); const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.waitFor('document.body.innerText.includes("Omitimos archivos")');
    await layout('upload-selected', true);
    await clickText('Iniciar importación');
    await browser.waitFor('window.__salarivoFixture.calls.some(call=>call.path.endsWith("/complete"))');
    await browser.waitFor('!document.body.innerText.includes("Validación de seguridad en curso")', 10000);
    await browser.evaluate('document.querySelector(".upload-list")?.scrollIntoView({block:"start"})');
    await layout('upload-complete', true);
    assert.deepEqual(await browser.evaluate('window.__salarivoFixture.unhandled'), []);

    await visit('/?section=summary', 'owner', { empty: true }); await layout('empty', true);
    await visit('/?section=summary', 'owner', { failPaths: ['/salary-history', '/documents'] }); await layout('error', true);
    await visit('/?section=settings');
    if (width < 1024) await clickText('Abrir menú');
    await clickText('Cerrar sesión');
    await browser.waitFor('window.__salarivoFixture.mode === "guest"');
    await layout('logout', true);
  }
  assert.deepEqual(exceptions, [], 'Browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ measurements, checks: ['all-owner-routes', 'mobile-widths', 'landscape', 'long-names-money', 'forms', 'privacy', 'pdf-fit-zoom', 'upload-synthetic', 'empty-error', 'logout'], exceptions }, null, 2));
  process.stdout.write(`${measurements.length} responsive checks passed. Screenshots: ${output}\n`);
} finally { await browser.close(); }
