import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id } from './fixtures.mjs';
import { calculateTerminationEstimate, reviewTerminationSalary } from '../../../api/src/termination-calculator.ts';
import { money, periodLabel } from '../../app/format.ts';

const base = process.env.SALARIVO_TEST_URL || 'http://127.0.0.1:3042';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-jurisdiction-qa');
await mkdir(output, { recursive: true });
const current = new Date();
const today = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
const future = `${current.getFullYear() + 1}-01-15`;
const employment = { id: id(10), employerName: 'Empresa Sintética Internacional de Prueba', countryCode: 'AR', currencyCode: 'ARS', countryConfirmedAt: '2026-01-01', startDate: '2019-07-01', startDateConfirmedAt: '2026-01-01', startDateSource: 'CONFIRMED', legalRegimeCode: 'AR_LCT_GENERAL', status: 'ACTIVE', statusConfirmedAt: '2026-01-01', employmentType: 'DEPENDENT' };
const reviewPeriod = new Date(Date.UTC(current.getFullYear(), current.getMonth() - 1, 1)).toISOString().slice(0, 7);
const reviewSettlement = { id: id(219), documentId: id(319), employmentId: employment.id, currencyCode: 'ARS', payrollPeriod: reviewPeriod, settlementType: 'NORMAL', grossAmount: '3000000.00', remunerativeAmount: '3000000.00', nonRemunerativeAmount: '0.00', netAmount: '2100000.00', deductionsAmount: '900000.00', basicAmount: '900000.00', earnings: [
  { code: 'UNKNOWN', lineItemId: id(60), amount: '300000.00', isRecurring: false },
  { code: 'BASIC_SALARY', lineItemId: id(61), amount: '900000.00', isRecurring: true },
] };
const normalSettlement = { ...reviewSettlement, grossAmount: '2000000.00', remunerativeAmount: '2000000.00', netAmount: '1660000.00', deductionsAmount: '340000.00', basicAmount: '2000000.00', earnings: [{ code: 'BASIC_SALARY', lineItemId: id(61), amount: '2000000.00', isRecurring: true }] };
const reviewEstimate = calculateTerminationEstimate({ employment, today, terminationDate: today, salaryMode: 'DOCUMENTS', settlements: [reviewSettlement] });
const sourceDescription = 'Premio sintético sin clasificación <texto del recibo>';
reviewEstimate.salaryBase.trace.forEach(line => { line.sourceDescription = line.lineItemId === id(60) ? sourceDescription : 'Básico sintético'; });
const reviewData = { estimate: reviewEstimate, settlement: reviewSettlement, issues: reviewTerminationSalary(reviewSettlement) };
assert.equal(reviewEstimate.status, 'UNAVAILABLE');
assert.ok(!reviewEstimate.salaryBase.missingPeriods.includes(reviewPeriod));
assert.deepEqual(reviewEstimate.salaryBase.unusablePeriods, [reviewPeriod]);

function installJurisdictionFixture(employment, reviewData, options) {
  const priorFetch = window.fetch;
  const state = window.__jurisdictionFixture = { requests: [], employmentPatch: null, employment: { ...employment, ...(options.unknown ? { status: 'UNKNOWN', statusConfirmedAt: null, employmentType: 'UNKNOWN', countryConfirmedAt: null, startDateConfirmedAt: null, legalRegimeCode: null } : {}), ...(options.legacyActive ? { statusConfirmedAt: null } : {}) }, primaryCountryCode: options.unconfirmed ? null : 'AR', primaryCountryConfirmedAt: options.unconfirmed ? null : '2026-01-01' };
  const ok = data => Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  const pending = new Map();
  state.resolveEstimate = (sequence, result) => { pending.get(sequence)?.(result); pending.delete(sequence); };
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
      state.employmentPatch = JSON.parse(init.body);
      Object.assign(state.employment, state.employmentPatch, { countryConfirmedAt: '2026-09-05', statusConfirmedAt: '2026-09-05', ...(state.employmentPatch.startDate ? { startDateConfirmedAt: '2026-09-05' } : {}) });
      return ok(state.employment);
    }
    if (path === `/api/v1/employments/${employment.id}/termination-estimate`) {
      const body = JSON.parse(init.body);
      state.requests.push({ method: init.method, url: url.href, body, cache: init.cache, credentials: init.credentials });
      const sequence = state.requests.length;
      if (options.fail) return Response.json({ error: { code: 'SYNTHETIC_FAILURE', message: 'Fallo sintético. Reintentá.' } }, { status: 503 });
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await new Promise(resolve => {
        pending.set(sequence, resolve);
        window.__calculateTerminationFixture(JSON.stringify({ sequence, body, employment: state.employment, review: options.review, noSalary: options.noSalary, grossOnly: options.grossOnly, priorUsable: options.priorUsable }));
      });
      if (body.terminationType) state.lastEstimate = result;
      return ok(result);
    }
    if (options.review && path === `/api/v1/documents/${reviewData.settlement.documentId}`) {
      const response = await priorFetch(input, init);
      const body = await response.json();
      const detail = body.data;
      return ok({ ...detail, payrollPeriod: reviewData.settlement.payrollPeriod, settlement: reviewData.settlement, terminationReview: reviewData.issues,
        extractedFields: [...detail.extractedFields.map(field => ({ ...field, effectiveValue: reviewData.settlement[field.fieldPath.replace('settlement.', '')] ?? field.effectiveValue })),
          { ...detail.extractedFields[3], id: '00000000-0000-4000-8000-000000000070', fieldPath: 'settlement.remunerativeAmount', effectiveValue: reviewData.settlement.remunerativeAmount }],
        lineItems: reviewData.settlement.earnings.map((earning, index) => ({ ...detail.lineItems[0], id: earning.lineItemId, amount: earning.amount, isRecurring: earning.isRecurring, normalizedConceptCode: earning.code, itemOrdinal: index + 1, rawDescription: reviewData.estimate.salaryBase.trace[index].sourceDescription })),
      });
    }
    return priorFetch(input, init);
  };
}
const browser = await openBrowser();
const exceptions = [];
browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
await browser.command('Runtime.addBinding', { name: '__calculateTerminationFixture' });
browser.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
  if (name !== '__calculateTerminationFixture') return;
  const request = JSON.parse(payload);
  const settlement = request.review ? reviewSettlement : normalSettlement;
  const settlements = request.noSalary ? [] : [{ ...settlement, ...(request.grossOnly ? { remunerativeAmount: null } : {}) }];
  if (request.priorUsable) settlements.push({ ...normalSettlement, id: id(218), documentId: id(318), payrollPeriod: new Date(Date.UTC(current.getFullYear(), current.getMonth() - 2, 1)).toISOString().slice(0, 7) });
  // Every synthetic POST runs the real Node motor, including submitted dates and overrides.
  const result = calculateTerminationEstimate({ ...request.body, employment: request.employment, today, settlements });
  if (request.review) result.salaryBase.trace.forEach(line => { line.sourceDescription = line.lineItemId === id(60) ? sourceDescription : 'Básico sintético'; });
  browser.command('Runtime.evaluate', { contextId: executionContextId, expression: `window.__jurisdictionFixture.resolveEstimate(${request.sequence}, ${JSON.stringify(result)})` }).catch(error => exceptions.push(error.message));
});
let injection;
async function visit(path, options = {}) {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  const source = `${fixtureSource({ ...options, private: options.private ?? false })}\n(${installJurisdictionFixture})(${JSON.stringify(employment)}, ${JSON.stringify(reviewData)}, ${JSON.stringify(options)});`;
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
  await browser.navigate(new URL(path, base).href);
  await browser.waitFor('window.__jurisdictionFixture && document.querySelector("h1") && !document.querySelector("main .loader")');
  if (new URL(path, base).searchParams.get('section') === 'termination' && !options.empty && !options.legacyActive) {
    await browser.waitFor('document.querySelector(".termination-form") && !document.querySelector(".termination-suggestion")?.textContent.includes("Buscando")');
  }
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
async function expectTotals() {
  await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
  const estimate = await browser.evaluate('window.__jurisdictionFixture.lastEstimate');
  const displayed = await browser.evaluate('[...document.querySelectorAll(".termination-scenario")].map(el => [...el.querySelectorAll(".termination-totals dd")].map(total => total.textContent))');
  assert.deepEqual(displayed, estimate.scenarios.map(scenario => [money(scenario.total), money(scenario.netEstimate.total)]));
  return estimate;
}
try {
  if (!process.argv.includes('--document-country-only')) {
  for (const width of [320, 390, 1440]) {
    await browser.viewport(width, 900);
    await visit('/?section=termination');
    assert.equal(await browser.evaluate('document.querySelector("select[aria-label]").value'), employment.id);
    assert.equal(await browser.evaluate('document.querySelector("[name=salaryMode]").value'), 'SIMPLE');
    assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), normalSettlement.remunerativeAmount);
    assert.equal(await browser.evaluate('document.querySelectorAll(".termination-result").length'), 0, 'Reference loading must not calculate a visible result');
    assert.equal(await browser.evaluate('window.__jurisdictionFixture.requests.length'), 1);
    assert.equal(await browser.evaluate('window.__jurisdictionFixture.requests[0].body.salaryMode'), 'DOCUMENTS');
    assert.ok(await browser.evaluate('["startDate", "terminationDate", "monthlyRemuneration", "pendingVacationDays"].every(name => document.querySelector(`.termination-form [name=${name}]`).getClientRects().length > 0)'));
    await browser.evaluate('document.querySelector(".termination-form").scrollIntoView({block:"start"})');
    await layout('simple-form');
    await click('Calcular estimación');
    const initial = await expectTotals();
    assert.equal(initial.inputs.salaryMode, 'SIMPLE');
    assert.ok(initial.scenarios.every(scenario => scenario.netEstimate.total !== scenario.total));
    await browser.evaluate('document.querySelector(".termination-scenarios").scrollIntoView({block:"start"})');
    await layout('comparison');
    await click('Ocultar importes');
    const hidden = await browser.evaluate('({text:document.querySelector(".termination-result").innerText, accessible:document.querySelector(".termination-result").innerHTML})');
    for (const scenario of initial.scenarios) {
      for (const amount of [scenario.total, scenario.netEstimate.total, scenario.netEstimate.contributionsAmount]) {
        assert.ok(!hidden.accessible.includes(amount));
        assert.ok(!hidden.accessible.includes(money(amount)));
      }
    }
    assert.ok(hidden.text.includes('••••••••'));
    await browser.evaluate('document.querySelector(".termination-page form details").open=true');
    assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").type'), 'password');
    assert.equal(await browser.evaluate('document.querySelector("[name=additionalWithholdings]").type'), 'password');
    assert.equal(await browser.evaluate('document.querySelector("[name=deductionRatePercent]").type'), 'password');
    assert.ok(!hidden.accessible.includes('17.00%'));
    await input('[name=monthlyRemuneration]', '2.400.000,00');
    await input('[name=pendingVacationDays]', '0');
    await input('[name=terminationDate]', future);
    assert.ok(await browser.evaluate('document.body.innerText.includes("Es una proyección")'));
    assert.equal(await browser.evaluate('document.querySelectorAll(".termination-result").length'), 0, 'Input change removes stale result');
    await click('Calcular estimación');
    await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
    const request = await browser.evaluate('window.__jurisdictionFixture.requests.at(-1)');
    assert.equal(request.method, 'POST'); assert.equal(request.cache, 'no-store'); assert.equal(request.credentials, 'include');
    assert.equal(request.body.salaryMode, 'SIMPLE');
    assert.equal(request.body.overrides.monthlyRemuneration, '2400000.00');
    assert.equal(request.body.overrides.pendingVacationDays, '0.00');
    assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), '2.400.000,00', 'Reference refresh preserves the edited salary');
    assert.ok(!request.url.includes('2400000')); assert.ok(!request.url.includes('?'));
    const zeroVacation = await browser.evaluate('window.__jurisdictionFixture.lastEstimate');
    assert.equal(zeroVacation.inputs.vacationDays, '0.00');
    assert.ok(zeroVacation.scenarios.every(scenario => scenario.breakdown.find(line => line.code === 'UNUSED_VACATION').amount === '0.00'));
    await input('[name=terminationDate]', '2024-12-15');
    await click('Calcular estimación');
    await browser.waitFor('document.querySelectorAll(".termination-scenario").length === 2');
    assert.equal(await browser.evaluate('window.__jurisdictionFixture.lastEstimate.legalRuleVersion.version'), '2024-07-09');
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
  assert.equal(await browser.evaluate('document.querySelector("input[name=startDate]").value'), employment.startDate);
  await input('select[name=status]', 'ACTIVE');
  await input('select[name=employmentType]', 'DEPENDENT');
  await input('select[name=legalRegimeCode]', 'AR_LCT_GENERAL');
  await click('Confirmar datos del empleo');
  await browser.waitFor('!document.querySelector("select[name=status]")');
  assert.equal(await browser.evaluate('window.__jurisdictionFixture.employment.status'), 'ACTIVE');
  assert.equal(await browser.evaluate('window.__jurisdictionFixture.employmentPatch.startDate'), employment.startDate);
  await visit('/?section=termination', { empty: true });
  assert.ok(await browser.evaluate('document.body.innerText.includes("Primero, registrá tu empleo")'));
  await visit('/?section=termination', { fail: true });
  await input('[name=monthlyRemuneration]', '2000000');
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
  for (const width of [320, 1440]) {
    await browser.viewport(width, 900);
    await visit(`/?section=termination&employmentId=${employment.id}`, { review: true, private: true });
    assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), reviewSettlement.remunerativeAmount);
    await browser.evaluate('document.querySelector(".termination-form details").open = true');
    await input('[name=salaryMode]', 'DOCUMENTS');
    await click('Calcular estimación');
    await browser.waitFor('document.querySelector(".termination-trace")');
    assert.equal(await browser.evaluate('window.__jurisdictionFixture.lastEstimate.status'), 'UNAVAILABLE');
    assert.ok(await browser.evaluate('document.querySelector(".termination-next-step").innerText.includes("sin revisar todos los recibos")'));
    assert.equal(await browser.evaluate('window.__jurisdictionFixture.requests.at(-1).body.overrides.monthlyRemuneration'), undefined, 'Document analysis must not silently use the suggested salary');
    assert.ok(!await browser.evaluate('document.querySelector(".termination-result > .panel-heading").innerText.includes("Completitud")'));
    await layout('termination-next-step');
    await browser.evaluate('document.querySelector(".termination-trace").closest("details").open = true');
    await click('Mostrar importes');
    const trace = await browser.evaluate('document.querySelector(".termination-trace").innerText');
    assert.ok(trace.includes('Concepto sin clasificar') && trace.includes('Sueldo básico'));
    assert.ok(trace.includes(sourceDescription));
    assert.ok(!trace.includes('UNKNOWN') && !trace.includes('BASIC_SALARY'));
    const coverage = await browser.evaluate('[...document.querySelectorAll(".termination-result p")].map(el => el.textContent)');
    assert.ok(coverage.some(text => text.startsWith('Recibos sin detalle suficiente') && text.includes(periodLabel(reviewPeriod))));
    assert.ok(!coverage.find(text => text.startsWith('Períodos sin recibos analizados:')).includes(periodLabel(reviewPeriod)));
    await browser.evaluate('document.querySelector(".termination-trace").scrollIntoView({block:"start"})');
    await layout('termination-review-trace');
    await click('Ocultar importes');
    assert.ok(!await browser.evaluate(`document.querySelector('.termination-trace').textContent.includes(${JSON.stringify(sourceDescription)})`));
    assert.ok(!await browser.evaluate('document.querySelector(".termination-trace").innerHTML.includes("Premio sintético")'));
    const href = await browser.evaluate('document.querySelector(".termination-trace a").href');
    assert.deepEqual(Object.fromEntries(new URL(href).searchParams), { currencyCode: 'ARS', section: 'history', employmentId: employment.id, tab: 'documents', document: id(319), review: 'termination', lineItem: id(60) });
    await browser.evaluate('document.querySelector(".termination-trace a").click()');
    await browser.waitFor('document.querySelector("#termination-review-title")');
    assert.ok(await browser.evaluate('document.activeElement.getAttribute("aria-labelledby") === "termination-review-title"'));
    assert.ok(!await browser.evaluate(`document.querySelector('dialog[aria-labelledby="review-title"]').textContent.includes(${JSON.stringify(sourceDescription)})`));
    assert.ok(!await browser.evaluate('document.querySelector("dialog[aria-labelledby=review-title]").innerHTML.includes("Premio sintético")'));
    assert.ok(!await browser.evaluate('window.__salarivoFixture.calls.some(call => call.path.endsWith("/original"))'));
    await layout('termination-source-review');
    await click('Ver concepto');
    await browser.waitFor(`document.activeElement.id === 'line-item-${id(60)}'`);
    await visit(new URL(href).pathname + new URL(href).search, { review: true, private: false });
    await browser.waitFor('document.querySelector("#termination-review-title")');
    await browser.waitFor(`document.querySelector('dialog[aria-labelledby="review-title"]').textContent.includes(${JSON.stringify(sourceDescription)})`);
    await click('Revisar Remunerativo');
    await browser.waitFor(`document.activeElement.closest('article')?.id === 'field-${id(70)}'`);
    assert.ok(await browser.evaluate(`document.querySelector('#field-${id(70)} input') !== null`));
    assert.ok(!await browser.evaluate('window.__salarivoFixture.calls.some(call => call.path.endsWith("/corrections") || call.path.endsWith("/original"))'));
  }
  await visit(`/?section=termination&employmentId=${employment.id}`, { review: true, priorUsable: true });
  assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), reviewSettlement.remunerativeAmount, 'Suggest the latest receipt even when an earlier usable month has a different salary');
  assert.equal(await browser.evaluate('document.querySelectorAll(".termination-result").length'), 0);
  await click('Calcular estimación');
  const fromAmbiguous = await expectTotals();
  assert.equal(fromAmbiguous.salaryBase.amount, reviewSettlement.remunerativeAmount);
  assert.equal(await browser.evaluate('document.querySelector(".termination-next-step")'), null);
  await input('[name=pendingVacationDays]', '10,5');
  await input('[name=monthlyRemuneration]', '2.000.000,00');
  await input('.termination-form [name=startDate]', '2018-07-01');
  await click('Calcular estimación');
  const vacation = await expectTotals();
  assert.equal(vacation.inputs.startDate, '2018-07-01');
  assert.equal(vacation.inputs.vacationDays, '10.50');
  assert.ok(vacation.scenarios.every(scenario => scenario.breakdown.find(line => line.code === 'UNUSED_VACATION').amount === '840000.00'));
  await browser.evaluate('document.querySelector(".termination-form details").open = true');
  assert.ok(await browser.evaluate('document.querySelector("[name=vacationDaysTaken]").disabled && document.querySelector("[name=priorVacationDays]").disabled'));
  await input('[name=deductionRatePercent]', '10');
  await input('[name=additionalWithholdings]', '10.000,00');
  await click('Calcular estimación');
  const adjustedNet = await expectTotals();
  assert.deepEqual(adjustedNet.scenarios.map(scenario => scenario.total), vacation.scenarios.map(scenario => scenario.total), 'Deductions must not change gross estimates');
  assert.notDeepEqual(adjustedNet.scenarios.map(scenario => scenario.netEstimate.total), vacation.scenarios.map(scenario => scenario.netEstimate.total));
  assert.ok(adjustedNet.scenarios.every(scenario => scenario.netEstimate.contributionPercent === '10.00' && scenario.netEstimate.additionalWithholdingsAmount === '10000.00'));
  assert.ok(!await browser.evaluate('window.__salarivoFixture.calls.some(call => call.path.endsWith("/corrections"))'));
  await visit(`/?section=termination&employmentId=${employment.id}`, { review: true });
  await browser.evaluate('document.querySelector(".termination-form details").open = true');
  await input('[name=salaryMode]', 'DOCUMENTS');
  await click('Calcular estimación');
  await browser.waitFor('document.querySelector(".termination-next-step")');
  await click('Usar estimación simple');
  await browser.waitFor('document.activeElement?.getAttribute("name") === "monthlyRemuneration"');
  assert.equal(await browser.evaluate('document.querySelector("[name=salaryMode]").value'), 'SIMPLE');
  await click('Calcular estimación');
  await expectTotals();
  await visit('/?section=termination', { review: true, grossOnly: true });
  assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), reviewSettlement.grossAmount);
  await click('Calcular estimación');
  await expectTotals();
  await visit('/?section=termination', { noSalary: true });
  assert.equal(await browser.evaluate('document.querySelector("[name=monthlyRemuneration]").value'), '');
  assert.equal(await browser.evaluate('document.querySelector(".termination-form").checkValidity()'), false);
  await input('[name=monthlyRemuneration]', '2000000');
  await click('Calcular estimación');
  await expectTotals();
  }
  await visit(`/?section=history&tab=documents&document=${id(319)}`, { documentIssues: [
    { code: 'COUNTRY_DETECTION_OVERRIDDEN', affectedFieldPath: 'document.countryCode', severity: 'INFO', recoverable: false },
  ] });
  await browser.waitFor('document.querySelector("dialog[aria-labelledby=review-title]")');
  assert.ok(await browser.evaluate('document.body.innerText.includes("Heredado del empleo confirmado")'));
  assert.equal(await browser.evaluate('document.querySelector("select[name=documentCountryCode]")'), null);
  assert.equal(await browser.evaluate('[...document.querySelectorAll("details")].find(el => el.querySelector("summary")?.textContent.includes("País del documento"))?.open'), false);
  await visit(`/?section=history&tab=documents&document=${id(319)}`, { documentIssues: [
    { code: 'COUNTRY_EMPLOYMENT_CONFLICT', affectedFieldPath: 'document.countryCode', severity: 'ERROR', recoverable: false },
  ] });
  await browser.waitFor('document.querySelector("select[name=documentCountryCode]")');
  assert.equal(await browser.evaluate('document.querySelector("select[name=documentCountryCode]").closest("details").open'), true);
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
  await visit(`/?section=history&tab=documents&document=${id(319)}`, { failCountry: true, documentCountry: { countryCode: 'AR', countrySource: 'DOCUMENT_DETECTION', countryConfidence: 'LOW', countrySnapshotAt: null } });
  await browser.waitFor('document.querySelector("select[name=documentCountryCode]")');
  await browser.evaluate('document.querySelector("select[name=documentCountryCode]").closest("details").open = true');
  await input('select[name=documentCountryCode]', 'US');
  await click('Confirmar país');
  await browser.waitFor('document.querySelector("dialog [role=alert]")');
  assert.ok(await browser.evaluate('document.querySelector("dialog [role=alert]").innerText.includes("no coincide")'));
  assert.equal(await browser.evaluate('window.__salarivoFixture.documentCountry.countryCode'), 'AR');
  assert.deepEqual(exceptions, []);
  process.stdout.write(`Jurisdiction browser smoke passed${process.argv.includes('--document-country-only') ? ': document confirmation/cancel/conflict at 320/1440' : ': 320/390/1440, historical/future, privacy, overrides, confirmation, empty/error, document country, termination trace and source review'}. Screenshots: ${output}\n`);
} finally { await browser.close(); }
