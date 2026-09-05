import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id } from './fixtures.mjs';
import { calculateTerminationEstimate } from '../../../api/src/termination-calculator.ts';

const base = process.env.SALARIVO_TEST_URL || 'http://127.0.0.1:3042';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-jurisdiction-qa');
await mkdir(output, { recursive: true });
const current = new Date();
const today = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
const future = `${current.getFullYear() + 1}-01-15`;
const employment = { id: id(10), employerName: 'Empresa Sintética Internacional de Prueba', countryCode: 'AR', currencyCode: 'ARS', countryConfirmedAt: '2026-01-01', startDate: '2019-07-01', startDateSource: 'CONFIRMED', legalRegimeCode: 'AR_LCT_GENERAL', status: 'ACTIVE', statusConfirmedAt: '2026-01-01', employmentType: 'DEPENDENT' };
const estimates = Object.fromEntries([today, '2024-12-15', future].map(terminationDate => [terminationDate, calculateTerminationEstimate({ employment, today, terminationDate, settlements: [], overrides: { monthlyRemuneration: '2000000.00' } })]));
assert.ok(Object.values(estimates).every(result => result.status === 'AVAILABLE' && result.scenarios.length === 2));

function installJurisdictionFixture(employment, estimates, options) {
  const priorFetch = window.fetch;
  const state = window.__jurisdictionFixture = { requests: [], employment: { ...employment, ...(options.unknown ? { status: 'UNKNOWN', statusConfirmedAt: null, employmentType: 'UNKNOWN', countryConfirmedAt: null, legalRegimeCode: null } : {}), ...(options.legacyActive ? { statusConfirmedAt: null } : {}) }, primaryCountryCode: options.unconfirmed ? null : 'AR', primaryCountryConfirmedAt: options.unconfirmed ? null : '2026-01-01' };
  const ok = data => Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname;
    if (path === '/api/v1/auth/me') {
      const response = await priorFetch(input, init);
      const body = await response.json();
      return ok({ ...body.data, primaryCountryCode: state.primaryCountryCode, primaryCountryConfirmedAt: state.primaryCountryConfirmedAt });
    }
    if (path === '/api/v1/profile/country') {
      if (init.method === 'PATCH') { state.primaryCountryCode = JSON.parse(init.body).primaryCountryCode; state.primaryCountryConfirmedAt = '2026-09-05'; }
      return ok({ primaryCountryCode: state.primaryCountryCode, primaryCountryConfirmedAt: state.primaryCountryConfirmedAt, suggestion: { countryCode: 'AR', confidence: 'MEDIUM', source: 'BROWSER_LOCALE' } });
    }
    if (path === '/api/v1/employments') return ok(options.empty ? [] : [state.employment]);
    if (path === `/api/v1/employments/${employment.id}` && init.method === 'PATCH') {
      Object.assign(state.employment, JSON.parse(init.body), { countryConfirmedAt: '2026-09-05', statusConfirmedAt: '2026-09-05' });
      return ok(state.employment);
    }
    if (path === `/api/v1/employments/${employment.id}/termination-estimate`) {
      state.requests.push({ method: init.method, url: url.href, body: JSON.parse(init.body), cache: init.cache, credentials: init.credentials });
      if (options.fail) return Response.json({ error: { code: 'SYNTHETIC_FAILURE', message: 'Fallo sintético. Reintentá.' } }, { status: 503 });
      await new Promise(resolve => setTimeout(resolve, 200));
      return ok(estimates[JSON.parse(init.body).terminationDate]);
    }
    return priorFetch(input, init);
  };
}
const browser = await openBrowser();
const exceptions = [];
browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
let injection;
async function visit(path, options = {}) {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  const source = `${fixtureSource({ ...options, private: options.private ?? false })}\n(${installJurisdictionFixture})(${JSON.stringify(employment)}, ${JSON.stringify(estimates)}, ${JSON.stringify(options)});`;
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
  await browser.navigate(new URL(path, base).href);
  await browser.waitFor('window.__jurisdictionFixture && document.querySelector("h1") && !document.querySelector("main .loader")');
}
async function click(label) {
  const found = await browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.getClientRects().length && !el.disabled && (el.getAttribute('aria-label') || el.textContent.trim()) === ${JSON.stringify(label)}); button?.click(); return !!button; })()`);
  assert.ok(found, `Missing button: ${label}`);
}
async function input(selector, value) {
  await browser.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw Error('Missing field'); const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
async function layout(name) {
  const size = await browser.evaluate('({width: innerWidth, scroll:document.documentElement.scrollWidth, tiny:[...document.querySelectorAll("input,select")].filter(el=>el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize)<16).length})');
  assert.ok(size.scroll <= size.width + 1, `${name}: overflow`);
  assert.equal(size.tiny, 0);
  await browser.screenshot(join(output, `${size.width}-${name}.png`));
}
try {
  if (!process.argv.includes('--document-country-only')) {
  for (const width of [320, 390, 1440]) {
    await browser.viewport(width, 900);
    await visit('/?section=termination');
    assert.equal(await browser.evaluate('document.querySelector("select[aria-label]").value'), employment.id);
    await click('Calcular estimación');
    await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
    if (width < 768) {
      assert.equal(await browser.evaluate('document.querySelectorAll(".termination-mobile-totals dd").length'), 2);
      await browser.evaluate('document.querySelector(".termination-mobile-totals").scrollIntoView({block:"start"})');
      assert.ok(await browser.evaluate('document.querySelector(".termination-mobile-totals").getBoundingClientRect().bottom < innerHeight - 80'));
      await layout('mobile-totals');
    }
    await browser.evaluate('document.querySelector(".termination-scenarios").scrollIntoView({block:"start"})');
    await layout('comparison');
    await click('Ocultar importes');
    const hidden = await browser.evaluate('({text:document.querySelector(".termination-result").innerText, accessible:document.querySelector(".termination-result").innerHTML})');
    for (const scenario of estimates[today].scenarios) {
      assert.ok(!hidden.accessible.includes(scenario.total));
    }
    assert.ok(hidden.text.includes('••••••••'));
    await browser.evaluate('document.querySelector(".termination-page form details").open=true');
    assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").type'), 'password');
    await input('[name=monthlyRemuneration]', '2.000.000,00');
    await input('[name=terminationDate]', future);
    assert.ok(await browser.evaluate('document.body.innerText.includes("Es una proyección")'));
    assert.equal(await browser.evaluate('document.querySelectorAll(".termination-result").length'), 0, 'Input change removes stale result');
    await click('Calcular estimación');
    await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
    const request = await browser.evaluate('window.__jurisdictionFixture.requests.at(-1)');
    assert.equal(request.method, 'POST'); assert.equal(request.cache, 'no-store'); assert.equal(request.credentials, 'include');
    assert.equal(request.body.overrides.monthlyRemuneration, '2000000.00');
    assert.ok(!request.url.includes('2000000')); assert.ok(!request.url.includes('?'));
    await input('[name=terminationDate]', '2024-12-15');
    await click('Calcular estimación');
    await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
    assert.ok(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(estimates['2024-12-15'].legalRuleVersion.version)})`));
    await layout('historical-private');
  }
  await browser.viewport(390, 844);
  await visit('/?section=summary', { unconfirmed: true });
  await browser.waitFor('document.querySelector("select[name=primaryCountryCode]")');
  await input('.country-settings input[type=search]', 'estados unidos');
  assert.equal(await browser.evaluate('document.querySelectorAll("select[name=primaryCountryCode] option").length'), 3);
  await browser.evaluate('document.querySelector("select[name=primaryCountryCode]").focus()');
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  assert.equal(await browser.evaluate('document.querySelector("select[name=primaryCountryCode]").value'), 'US');
  await click('Confirmar país');
  await browser.waitFor('!document.querySelector("select[name=primaryCountryCode]")');
  assert.equal(await browser.evaluate('window.__jurisdictionFixture.employment.countryCode'), 'AR');
  assert.equal(await browser.evaluate('window.__jurisdictionFixture.primaryCountryCode'), 'US');
  await visit(`/?section=termination&employmentId=${employment.id}`, { unknown: true });
  await browser.waitFor('document.querySelector("select[name=status]")');
  await input('select[name=status]', 'ACTIVE');
  await input('select[name=employmentType]', 'DEPENDENT');
  await input('select[name=legalRegimeCode]', 'AR_LCT_GENERAL');
  await click('Confirmar datos del empleo');
  await browser.waitFor('!document.querySelector("select[name=status]")');
  assert.equal(await browser.evaluate('window.__jurisdictionFixture.employment.status'), 'ACTIVE');
  await visit('/?section=termination', { empty: true });
  assert.ok(await browser.evaluate('document.body.innerText.includes("Primero, registrá tu empleo")'));
  await visit('/?section=termination', { fail: true });
  await click('Calcular estimación');
  await browser.waitFor('document.querySelector("[role=alert]")');
  assert.equal(await browser.evaluate('document.querySelectorAll(".termination-scenario").length'), 0);
  await visit('/?section=termination', { legacyActive: true });
  assert.equal(await browser.evaluate('document.querySelector("select[aria-label]").value'), '');
  await input('select[aria-label]', employment.id);
  await browser.waitFor('document.querySelector("select[name=status]")');
  assert.ok(await browser.evaluate('!document.body.innerText.includes("Continuidad confirmada")'));
  await visit('/?section=jobs');
  await click('Agregar empleo');
  await browser.waitFor('document.querySelector("select[name=currencyCode]")');
  assert.ok(await browser.evaluate('Boolean(document.querySelector("select[name=currencyCode] option[value=INR]") && document.querySelector("select[name=currencyCode] option[value=NZD]"))'));
  await click('Cancelar');
  }
  for (const width of [320, 1440]) {
    await browser.viewport(width, 900);
    await visit(`/?section=history&tab=documents&document=${id(319)}`, { private: true, documentCountry: { countryCode: 'US', countrySource: 'DOCUMENT_DETECTION', countryConfidence: 'LOW', countrySnapshotAt: null } });
    await browser.waitFor('document.querySelector("select[name=documentCountryCode]")');
    await browser.evaluate('document.querySelector("select[name=documentCountryCode]").closest("details").open = true');
    await input('select[name=documentCountryCode]', 'AR');
    await click('Confirmar país');
    await browser.waitFor('document.body.innerText.includes("País del documento confirmado")');
    assert.deepEqual(await browser.evaluate('window.__salarivoFixture.countryRequests'), [{ countryCode: 'AR', extractionRunId: id(40), expectedCountryCode: 'US' }]);
    assert.equal(await browser.evaluate('document.querySelector("select[name=documentCountryCode]").value'), 'AR');
    assert.equal(await browser.evaluate('window.__salarivoFixture.documentCountry.countrySource'), 'USER_CONFIRMED');
    assert.ok(!await browser.evaluate('window.__salarivoFixture.calls.some(call => call.path.endsWith("/original") || call.path.endsWith("/corrections"))'));
    await browser.evaluate('document.querySelector("select[name=documentCountryCode]").closest("details").scrollIntoView({block:"start"})');
    await layout('document-country-confirmed');
    await input('select[name=documentCountryCode]', 'US');
    await click('Cancelar país');
    assert.equal(await browser.evaluate('document.querySelector("select[name=documentCountryCode]").value'), 'AR');
  }
  await visit(`/?section=history&tab=documents&document=${id(319)}`, { failCountry: true });
  await browser.waitFor('document.querySelector("select[name=documentCountryCode]")');
  await browser.evaluate('document.querySelector("select[name=documentCountryCode]").closest("details").open = true');
  await input('select[name=documentCountryCode]', 'US');
  await click('Confirmar país');
  await browser.waitFor('document.querySelector("dialog [role=alert]")');
  assert.ok(await browser.evaluate('document.querySelector("dialog [role=alert]").innerText.includes("no coincide")'));
  assert.equal(await browser.evaluate('window.__salarivoFixture.documentCountry'), undefined);
  assert.deepEqual(exceptions, []);
  process.stdout.write(`Jurisdiction browser smoke passed${process.argv.includes('--document-country-only') ? ': document confirmation/cancel/conflict at 320/1440' : ': 320/390/1440, historical/future, privacy, overrides, confirmation, empty/error, document country'}. Screenshots: ${output}\n`);
} finally { await browser.close(); }
