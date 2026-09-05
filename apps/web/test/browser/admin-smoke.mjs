import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id } from './fixtures.mjs';

const base = process.env.SALARIVO_TEST_URL || 'http://localhost:3000';
const browser = await openBrowser();
const screenshots = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-admin-qa');
const routes = ['/admin', '/admin/users', `/admin/users/${id(2)}`, ...['employments', 'documents', 'security'].map((tab) => `/admin/users/${id(2)}?tab=${tab}`), '/admin/documents', `/admin/documents/${id(300)}`, '/admin/employers', `/admin/employers/${id(20)}`, '/admin/processing', '/admin/storage', '/admin/privacy', '/admin/security', '/admin/audit', '/admin/legal', '/admin/access', '/admin/system', '/admin/not-found'];
let checks = 0;

async function ready(path) {
  await browser.navigate(`${base}${path}`);
  try { await browser.waitFor("Boolean(document.querySelector('.admin-page-content h1')) && !document.querySelector('.admin-loading')"); }
  catch (error) { throw new Error(`${path}: ${JSON.stringify(await browser.evaluate("({ title: document.querySelector('h1')?.textContent, gate: document.querySelector('.admin-gate')?.textContent, errors: [...document.querySelectorAll('.message.error')].map((el) => el.textContent), calls: window.__salarivoFixture?.calls, unhandled: window.__salarivoFixture?.unhandled })"))}`, { cause: error }); }
  assert.deepEqual(await browser.evaluate('window.__salarivoFixture.unhandled'), [], path);
}

async function fits(context) {
  const layout = await browser.evaluate(`({ width: innerWidth, scroll: document.documentElement.scrollWidth, errors: [...document.querySelectorAll('.message.error')].map((el) => el.textContent), tableRoles: [...document.querySelectorAll('.admin-table')].every((table) => table.getAttribute('role') === 'table' && [...table.querySelectorAll('th')].every((th) => th.scope === 'col')) })`);
  assert.ok(layout.scroll <= layout.width + 1, `${context}: horizontal overflow ${layout.scroll}/${layout.width}`);
  assert.deepEqual(layout.errors, [], context);
  assert.ok(layout.tableRoles, `${context}: table headers`);
  checks++;
}

async function key(key, windowsVirtualKeyCode) {
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode });
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode });
}

try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource({ mode: 'admin' }) });
  for (const width of [320, 768, 1280]) {
    await browser.viewport(width);
    for (const route of routes) {
      await ready(route);
      await fits(`${width}px ${route}`);
      if (screenshots && ['/admin/users', '/admin/employers', '/admin/legal'].includes(route)) await browser.screenshot(join(screenshots, `admin-${route.split('/').at(-1)}-${width}.png`));
    }
  }
  for (const width of [360, 375, 390, 414, 430, 1024, 1920, 2560]) {
    await browser.viewport(width);
    await ready('/admin/documents');
    await fits(`${width}px document cards/table`);
  }

  await browser.viewport(320, 568);
  await ready('/admin/users');
  assert.equal(await browser.evaluate("document.querySelector('.admin-filter-panel').open"), false);
  await browser.evaluate("document.querySelector('.admin-filter-panel summary').click()");
  assert.equal(await browser.evaluate("document.querySelector('.admin-filter-panel').open"), true);
  await ready(`/admin/users?status=ACTIVE&search=${id(2)}`);
  assert.match(await browser.evaluate("document.querySelector('.admin-filter-panel summary').textContent"), /\(2\)/);
  const appliedUrl = await browser.evaluate('location.href');
  await browser.evaluate("(() => { const form = document.querySelector('.admin-filters'); form.elements.search.value = 'draft-query'; form.elements.status.value = 'BLOCKED'; form.querySelector('button[type=button]').click(); })()");
  assert.equal(await browser.evaluate("document.querySelector('.admin-filter-panel').open"), false, 'cancel closes filters');
  assert.equal(await browser.evaluate("document.activeElement.matches('.admin-filter-panel summary')"), true, 'cancel restores summary focus');
  await browser.evaluate("document.querySelector('.admin-filter-panel summary').click()");
  assert.deepEqual(await browser.evaluate("(() => { const form = document.querySelector('.admin-filters'); return { search: form.elements.search.value, status: form.elements.status.value }; })()"), { search: id(2), status: 'ACTIVE' }, 'cancel discards draft filters and restores applied values');
  assert.equal(await browser.evaluate('location.href'), appliedUrl, 'cancel leaves applied URL unchanged');

  await browser.evaluate("const trigger = document.querySelector('[aria-controls=admin-navigation]'); trigger.focus(); trigger.click()");
  await browser.waitFor("document.querySelector('#admin-navigation').matches(':modal')");
  assert.equal(await browser.evaluate("getComputedStyle(document.body).overflowY"), 'hidden');
  for (let i = 0; i < 20; i++) {
    await key('Tab', 9);
    assert.equal(await browser.evaluate("document.querySelector('main').contains(document.activeElement)"), false, 'drawer contains keyboard focus');
  }
  if (screenshots) await browser.screenshot(join(screenshots, 'admin-menu-320.png'));
  await key('Escape', 27);
  await browser.waitFor("!document.querySelector('#admin-navigation').open");
  assert.equal(await browser.evaluate("document.activeElement.getAttribute('aria-controls')"), 'admin-navigation');
  await browser.evaluate("document.querySelector('[aria-controls=admin-navigation]').click()");
  await browser.viewport(1280);
  await browser.waitFor("document.querySelector('#admin-navigation').open && !document.querySelector('#admin-navigation').matches(':modal')");
  assert.deepEqual(await browser.evaluate("(() => { const navigation = document.querySelector('#admin-navigation'); return { open: navigation.open, modal: navigation.matches(':modal') }; })()"), { open: true, modal: false });
  await browser.viewport(320, 400);
  await browser.waitFor("!document.querySelector('#admin-navigation').open");

  await ready('/admin/legal');
  await browser.evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent === 'Publicar versiones').click()");
  await browser.waitFor("Boolean(document.querySelector('.admin-dialog:modal'))");
  const dialog = await browser.evaluate("(() => { const dialog = document.querySelector('.admin-dialog'); const rect = dialog.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, right: rect.right, bottom: rect.bottom, top: rect.top, scroll: dialog.scrollHeight > dialog.clientHeight, fieldWidths: [...dialog.querySelectorAll('input, select, textarea')].every((el) => el.getBoundingClientRect().right <= rect.right) }; })()");
  assert.ok(dialog.right <= dialog.width && dialog.bottom <= dialog.height && dialog.top >= 0 && dialog.scroll && dialog.fieldWidths, 'long legal form fits short landscape/keyboard viewport');
  if (screenshots) await browser.screenshot(join(screenshots, 'admin-publication-320x400.png'));
  await key('Escape', 27);

  await ready(`/admin/users/${id(2)}`);
  await browser.evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent === 'Suspender').click()");
  await browser.waitFor("Boolean(document.querySelector('.admin-dialog:modal'))");
  await browser.evaluate("(() => { const form = document.querySelector('.admin-dialog form'); form.elements.reasonCode.value = 'OPERATIONAL_RECOVERY'; form.elements.reference.value = 'SYNTHETIC-123'; form.requestSubmit(); })()");
  await browser.waitFor("Boolean(document.querySelector('.admin-dialog input[name=code]'))");
  await browser.evaluate("(() => { const form = document.querySelector('.admin-dialog form'); form.elements.code.value = '111111'; form.requestSubmit(); })()");
  await browser.waitFor("Boolean(document.querySelector('.admin-dialog .message.error'))");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.admin-page-content'))"), true, 'invalid MFA does not clear the authenticated session');
  await browser.evaluate("(() => { const form = document.querySelector('.admin-dialog form'); form.elements.code.value = '123456'; form.requestSubmit(); })()");
  await browser.waitFor("!document.querySelector('.admin-dialog') && Boolean(document.querySelector('.message.success'))");

  await browser.evaluate("window.__salarivoFixture.mode = 'guest'; window.dispatchEvent(new Event('focus'))");
  await browser.waitFor("Boolean(document.querySelector('.admin-gate'))");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.admin-page-content'))"), false, 'expired session removes admin metadata');
  await ready('/admin/users');
  await browser.evaluate("window.__salarivoFixture.mode = 'owner'; window.dispatchEvent(new Event('focus'))");
  await browser.waitFor("Boolean(document.querySelector('.admin-gate'))");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.admin-page-content'))"), false, 'revoked admin access removes metadata');
  await ready('/admin/users');
  await browser.evaluate("window.dispatchEvent(new Event('offline')); window.__salarivoFixture.mode = 'guest'; window.dispatchEvent(new Event('online'))");
  await browser.waitFor("Boolean(document.querySelector('.admin-gate'))");
  assert.equal(await browser.evaluate("Boolean(document.querySelector('.admin-page-content'))"), false, 'reconnecting revalidates the session and removes expired metadata');
  process.stdout.write(`Admin browser smoke passed: ${checks} viewport/route checks, drawer keyboard/resize, filters, legal dialog, step-up and session invalidation on focus/reconnect.\n`);
} finally {
  await browser.close();
}
