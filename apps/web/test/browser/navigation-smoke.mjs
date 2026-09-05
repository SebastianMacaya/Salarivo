import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id, syntheticPdf } from './fixtures.mjs';

const base = process.env.SALARIVO_TEST_URL || 'http://127.0.0.1:3040';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-navigation-qa');
await mkdir(output, { recursive: true });
const browser = await openBrowser();
const results = [];
const dialogs = [];
const exceptions = [];
let injection;
let dialogAccept = false;
browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
browser.on('Page.javascriptDialogOpening', event => {
  dialogs.push({ type: event.type, message: event.message, accepted: dialogAccept });
  void browser.command('Page.handleJavaScriptDialog', { accept: dialogAccept });
});

// Chrome's CDP media override ignores display-mode. Only this PWA signal is
// emulated; history entries, popstate, reload and native dialogs remain real.
const standalone = `const originalMatchMedia = window.matchMedia.bind(window); window.matchMedia = query => { const media = originalMatchMedia(query); if (query === '(display-mode: standalone)') Object.defineProperty(media, 'matches', { value: true }); return media; };`;
async function configure(options = {}) {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `${fixtureSource(options)}\n${standalone}` })).identifier;
}
async function settle() {
  await browser.waitFor('window.__salarivoFixture && document.querySelector("h1,h2") && ![...document.querySelectorAll(".loader,[aria-busy=true]")].some(el=>el.getClientRects().length)');
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function reload() {
  let loaded = false;
  const remove = browser.on('Page.loadEventFired', () => { loaded = true; });
  try {
    await browser.command('Page.reload');
    const deadline = Date.now() + 15000;
    while (!loaded && Date.now() < deadline) await delay(50);
    assert.ok(loaded, 'Reload did not finish');
    await settle();
  } finally { remove(); }
}
async function visit(path, options = {}) {
  dialogAccept = true;
  await configure(options);
  await browser.navigate(new URL(path, base).href);
  await settle();
  dialogAccept = false;
}
async function click(selector) {
  await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
  assert.ok(await browser.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el || el.disabled) return false; el.click(); return true; })()`), `Missing control ${selector}`);
}
async function textClick(text, selector = 'button') {
  const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length && !el.disabled && (el.getAttribute('aria-label') || el.innerText.trim()).endsWith(${JSON.stringify(text)}))`;
  await browser.waitFor(target);
  await browser.evaluate(`(${target}).click()`);
}
async function fill(selector, value) {
  await browser.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function back() { await browser.evaluate('history.back(); true'); }
async function forward() { await browser.evaluate('history.forward(); true'); }
async function review() { await browser.waitFor('document.querySelector("#review-title")'); }
async function openFromBottom() {
  await textClick('Recibos', '.mobile-navigation button');
  await browser.waitFor('document.querySelector(".document-row")');
  await click('.document-row');
  await review();
}
async function check(name, action) {
  const firstDialog = dialogs.length;
  try {
    await action();
    assert.deepEqual(await browser.evaluate('window.__salarivoFixture.unhandled'), [], 'Unmocked API route');
    results.push({ name, passed: true, dialogs: dialogs.slice(firstDialog) });
  } catch (error) {
    results.push({ name, passed: false, error: error.message, state: await browser.evaluate('({url:location.href, title:document.querySelector("h1")?.innerText, review:!!document.querySelector("#review-title"), dialogs:[...document.querySelectorAll("dialog[open]")].map(el=>el.getAttribute("aria-labelledby")), inputs:[...document.querySelectorAll("dialog input")].map(el=>({name:el.name,value:el.value}))})'), dialogs: dialogs.slice(firstDialog) });
    await browser.screenshot(join(output, `${name}-failure.png`));
  }
  process.stdout.write(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
}

try {
  await browser.viewport(390, 844);
  await check('bottom-review-back-forward-refresh', async () => {
    await visit('/?section=summary');
    assert.equal(await browser.evaluate('matchMedia("(display-mode: standalone)").matches'), true);
    await openFromBottom();
    const deepLink = await browser.evaluate('location.href');
    await back();
    await browser.waitFor('!document.querySelector("#review-title") && document.querySelector(".document-row")');
    await forward(); await review();
    assert.equal(await browser.evaluate('location.href'), deepLink);
    await reload(); await review();
    assert.equal(await browser.evaluate('location.href'), deepLink);
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(c=>c.path.endsWith("/original"))'));
    await textClick('Cerrar revisión');
    await browser.waitFor('!document.querySelector("#review-title")');
    await browser.screenshot(join(output, 'standalone-documents-return.png'));
  });
  await check('history-tabs-back-forward', async () => {
    await visit('/?section=summary');
    await textClick('Historial', '.mobile-navigation button');
    await click('#history-tab-evolution');
    await browser.waitFor('document.querySelector("#history-panel-evolution")');
    await click('#history-tab-annual');
    await browser.waitFor('document.querySelector("#history-panel-annual")');
    await back(); await browser.waitFor('document.querySelector("#history-panel-evolution")');
    await back(); await browser.waitFor('document.querySelector("#history-panel-summary")');
    await forward(); await browser.waitFor('document.querySelector("#history-panel-evolution")');
    assert.equal(await browser.evaluate('new URLSearchParams(location.search).get("tab")'), 'evolution');
  });
  await check('employment-document-links-back', async () => {
    await visit('/?section=summary');
    await textClick('Más: empleos y cuenta', '.mobile-navigation button');
    await textClick('Empleos', '#private-navigation nav button');
    await click('.employment-card-link');
    await browser.waitFor('document.querySelector(".employment-detail-actions")');
    const employmentUrl = await browser.evaluate('location.href');
    await click('.employment-detail-actions a:last-child');
    await browser.waitFor('document.querySelector(".document-row")');
    await click('.document-row'); await review();
    await back(); await browser.waitFor('!document.querySelector("#review-title")');
    await back(); await browser.waitFor('document.querySelector(".employment-detail-actions")');
    assert.equal(await browser.evaluate('location.href'), employmentUrl);
    await reload();
    await browser.waitFor('document.querySelector(".employment-detail-actions")');
    await click('.breadcrumbs a');
    await browser.waitFor('document.querySelector(".employment-card-link")');
  });
  await check('review-dirty-back-cancel-accept', async () => {
    await visit('/?section=summary'); await openFromBottom();
    await textClick('Editar');
    await fill('#review-data-panel input[inputmode=decimal]', '1234567.89');
    const url = await browser.evaluate('location.href');
    const before = dialogs.length;
    dialogAccept = false; await back();
    await browser.waitFor(`location.href === ${JSON.stringify(url)}`);
    assert.equal(dialogs.length, before + 1, 'Dirty Back did not ask to discard');
    assert.equal(await browser.evaluate('document.querySelector("#review-data-panel input[inputmode=decimal]")?.value'), '1234567.89');
    dialogAccept = true; await back();
    await browser.waitFor('!document.querySelector("#review-title") && document.querySelector(".document-row")');
    await forward(); await review();
    assert.equal(await browser.evaluate('!!document.querySelector("#review-data-panel input[inputmode=decimal]")'), false, 'Discarded draft survived Forward');
  });
  await check('review-dirty-refresh-cancel', async () => {
    await visit(`/?section=history&tab=documents&document=${id(319)}`); await review();
    await textClick('Editar'); await fill('#review-data-panel input[inputmode=decimal]', '1234567.89');
    dialogAccept = false;
    const before = dialogs.length;
    await browser.command('Page.reload');
    await browser.waitFor('document.querySelector("#review-data-panel input[inputmode=decimal]")?.value === "1234567.89"');
    assert.equal(dialogs.length, before + 1, 'Dirty refresh did not ask to leave');
  });
  await check('employment-dirty-back-cancel', async () => {
    await visit('/?section=summary');
    await textClick('Más: empleos y cuenta', '.mobile-navigation button');
    await textClick('Empleos', '#private-navigation nav button');
    await textClick('Agregar empleo'); await fill('input[name=employerName]', 'Empresa borrador sintética');
    const before = dialogs.length;
    dialogAccept = false; await back();
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
    assert.equal(await browser.evaluate('document.querySelector("input[name=employerName]")?.value'), 'Empresa borrador sintética', 'Back discarded an employment draft without confirmation');
    assert.equal(dialogs.length, before + 1);
    const beforeRefresh = dialogs.length;
    await browser.command('Page.reload');
    await browser.waitFor('document.querySelector("input[name=employerName]")?.value === "Empresa borrador sintética"');
    assert.equal(dialogs.length, beforeRefresh + 1, 'Employment refresh did not ask to leave');
    await textClick('Cancelar', 'dialog button');
    assert.equal(await browser.evaluate('document.querySelector("input[name=employerName]")?.value'), 'Empresa borrador sintética');
    await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await browser.evaluate('document.querySelector("input[name=employerName]")?.value'), 'Empresa borrador sintética');
    await fill('input[name=employerName]', '');
    const beforeUnchanged = dialogs.length;
    await back(); await browser.waitFor('!document.querySelector("#employment-title")');
    assert.equal(dialogs.length, beforeUnchanged, 'Restoring the initial values still prompted to discard');
  });
  await check('employment-edit-dirty-cancel-discard', async () => {
    await visit('/?section=jobs');
    await click('.employment-menu summary');
    await textClick('Editar', '.employment-menu button');
    const beforeUnchanged = dialogs.length;
    await textClick('Cancelar', 'dialog button');
    await browser.waitFor('!document.querySelector("#employment-title")');
    assert.equal(dialogs.length, beforeUnchanged, 'Unchanged editing prompted to discard');
    await textClick('Editar', '.employment-menu button');
    await fill('input[name=role]', 'Nuevo puesto sintético');
    dialogAccept = false; await textClick('Cerrar', 'dialog button');
    assert.equal(await browser.evaluate('document.querySelector("input[name=role]")?.value'), 'Nuevo puesto sintético');
    dialogAccept = true; await textClick('Cancelar', 'dialog button');
    await browser.waitFor('!document.querySelector("#employment-title")');
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(c=>c.method === "PATCH")'));
  });
  await check('employment-detection-dirty-back', async () => {
    await visit('/?section=summary', { detections: [{ employerId: id(20), employerName: 'Empresa sintética', currencyCode: 'ARS', firstPeriod: '2025-01', lastPeriod: '2026-08', documentCount: 2 }] });
    await textClick('Más: empleos y cuenta', '.mobile-navigation button');
    await textClick('Empleos', '#private-navigation nav button');
    await textClick('Asociar recibos');
    await browser.waitFor('document.querySelector("#employment-confirmation-title")');
    await fill('input[name=startDate]', '2025-02-01');
    dialogAccept = false; await back();
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
    assert.equal(await browser.evaluate('document.querySelector("input[name=startDate]")?.value'), '2025-02-01');
    dialogAccept = true; await textClick('Cancelar', 'dialog button');
    await browser.waitFor('!document.querySelector("#employment-confirmation-title")');
  });
  await check('import-busy-back-preserves-transfer', async () => {
    await visit('/?section=summary', { holdUpload: true });
    await textClick('Subir', '.mobile-navigation button');
    await browser.waitFor('document.querySelector("input[type=file]")');
    await browser.evaluate(`(() => { const transfer=new DataTransfer(); transfer.items.add(new File([${JSON.stringify(syntheticPdf())}], 'synthetic-payroll.pdf', {type:'application/pdf'})); const input=document.querySelector('input[type=file]'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await textClick('Iniciar importación');
    await browser.waitFor('typeof window.__salarivoFixture.releaseUpload === "function"');
    await back();
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
    const preserved = await browser.evaluate('new URLSearchParams(location.search).get("section") === "import" && !!document.querySelector(".upload-list")');
    await browser.evaluate('window.__salarivoFixture.releaseUpload()');
    await browser.waitFor('window.__salarivoFixture.calls.some(c=>c.path.endsWith("/complete"))');
    assert.equal(preserved, true, 'Back left the active upload and discarded its visible progress');
    await browser.waitFor('![...document.querySelectorAll(".mobile-navigation button")].some(el=>el.disabled)');
    await textClick('Inicio', '.mobile-navigation button');
    await browser.waitFor('new URLSearchParams(location.search).get("section") === "summary"');
  });
  await check('mfa-refresh-invalid-valid-deeplink', async () => {
    const path = `/?section=history&tab=documents&document=${id(319)}`;
    await visit(path, { mode: 'mfa' });
    await reload();
    assert.ok(await browser.evaluate('!!document.querySelector("#mfa-access-title") && !document.querySelector("#private-content")'));
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(c=>c.path === "/salary-history" || c.path === "/documents")'));
    await fill('input[name=code]', '000000'); await textClick('Continuar');
    await browser.waitFor('document.querySelector("[role=alert]")');
    assert.ok(await browser.evaluate('!!document.querySelector("#mfa-access-title")'));
    await fill('input[name=code]', '123456'); await textClick('Continuar'); await review();
    assert.equal(await browser.evaluate('new URLSearchParams(location.search).get("document")'), id(319));
    // This fixture change represents the server session promoted by valid MFA.
    await configure({ mode: 'owner' });
    await reload(); await review();
    assert.ok(await browser.evaluate('!window.__salarivoFixture.calls.some(c=>c.path.endsWith("/original"))'));
  });
  await check('owner-session-stepup-cancel-invalid-valid', async () => {
    await visit('/?section=settings', { stepUpRequired: true });
    await browser.waitFor('document.querySelectorAll(".session-row").length === 2');
    dialogAccept = true; await textClick('Finalizar sesión');
    await browser.waitFor('document.querySelector("#step-up-title")');
    await textClick('Cancelar', 'dialog button');
    assert.equal(await browser.evaluate('document.querySelectorAll(".session-row").length'), 2);
    await textClick('Finalizar sesión'); await browser.waitFor('document.querySelector("#step-up-title")');
    await fill('input[name=credential]', '000000'); await textClick('Continuar', 'dialog button');
    await browser.waitFor('document.querySelector("dialog [role=alert]")');
    assert.equal(await browser.evaluate('document.querySelectorAll(".session-row").length'), 2);
    await fill('input[name=credential]', '123456'); await textClick('Continuar', 'dialog button');
    await browser.waitFor('document.querySelectorAll(".session-row").length === 1 && !document.querySelector("dialog:modal")');
    assert.ok(await browser.evaluate('document.querySelector(".session-row").innerText.includes("Esta sesión")'));
    await browser.evaluate('document.querySelector(".sessions-card").scrollIntoView({block:"start"})');
    await browser.screenshot(join(output, 'standalone-sessions-revoked.png'));
  });
  await check('owner-session-revoke-all', async () => {
    await visit('/?section=settings');
    dialogAccept = true; await textClick('Cerrar las otras sesiones');
    await browser.waitFor('document.querySelectorAll(".session-row").length === 1');
    assert.deepEqual(await browser.evaluate('window.__salarivoFixture.sessions'), [1]);
  });
  await check('owner-auth-revalidate-network-versus-expiration', async () => {
    await visit('/?section=summary'); await openFromBottom();
    await textClick('Editar'); await fill('#review-data-panel input[inputmode=decimal]', '1234567.89');
    await browser.evaluate('window.__salarivoFixture.failPaths=["/auth/me"];window.dispatchEvent(new Event("focus"))');
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
    assert.equal(await browser.evaluate('document.querySelector("#review-data-panel input[inputmode=decimal]")?.value'), '1234567.89', 'Network error discarded the draft');
    await browser.evaluate('window.__salarivoFixture.failPaths=[];window.__salarivoFixture.mode="guest";window.dispatchEvent(new Event("online"))');
    await browser.waitFor('!document.querySelector("#private-content") && document.querySelector("#access-title")');
    assert.ok(await browser.evaluate('!document.querySelector("dialog:modal") && document.body.innerText.includes("Tu sesión finalizó")'));
    await back(); await settle();
    assert.ok(await browser.evaluate('!document.querySelector("#private-content")'));
  });
  assert.deepEqual(exceptions, [], 'Browser runtime errors');
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ base, emulation: '390×844 touch; JS display-mode standalone signal; native Chromium navigation', results, exceptions }, null, 2));
  dialogAccept = true;
  await browser.close();
}
if (results.some(result => !result.passed)) process.exitCode = 1;
process.stdout.write(`${results.filter(result => result.passed).length}/${results.length} navigation cases passed. ${output}\n`);
