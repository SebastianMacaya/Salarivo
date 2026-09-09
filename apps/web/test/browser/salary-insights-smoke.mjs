import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id, sacHistory } from './fixtures.mjs';
import { analyzeSalaryHistory, compareSalaryPeriods } from '../../../api/src/salary-analytics.ts';
import { addEconomicProjections, buildEconomicAnalytics, compareEconomicPeriods } from '../../../api/src/economic-analytics.ts';

const base = process.env.SALARIVO_TEST_URL || 'http://localhost:3000';
const output = process.env.SALARIVO_TEST_OUTPUT || join(tmpdir(), 'salarivo-salary-insights-qa');
const monthly = '.monthly-review';
const planner = '.salary-raise-planner';
const percentageInput = `${planner} input`;

// Every amount, identifier and economic observation in this test is synthetic.
function settlement(period, net, options = {}) {
  const suffix = Number(period.slice(-2)) + (options.employmentId === id(11) ? 30 : 0) + (options.settlementType === 'SAC' ? 60 : 0);
  return { id: id(200 + suffix), documentId: id(300 + suffix), employmentId: id(10), employmentContext: id(10), employmentStartPeriod: '2026-05', employmentStatus: 'ACTIVE', countryCode: 'AR', currencyCode: 'ARS', payrollPeriod: period, paymentDate: null, issueDate: null, settlementType: 'NORMAL', isRecurring: true, basicAmount: net, grossAmount: net, netAmount: net, deductionsAmount: '0.00', remunerativeAmount: net, nonRemunerativeAmount: '0.00', earnings: [{ code: 'BASIC_SALARY', amount: net, isRecurring: true }], ...options };
}

async function scenario(settlements, { missingCpi = [], indexes = { '2026-06-01': '100.000000000000', '2026-07-01': '150.000000000000' } } = {}) {
  const source = { async query(_sql, values) { return { rows: JSON.parse(values[0]).map(request => {
    const fx = request.series_code.startsWith('FX.');
    const date = request.selection === 'LATEST' ? '2026-07-01' : request.target_date;
    const missing = !fx && (missingCpi.includes(date) || !indexes[date]);
    return { ...request, requested_series_code: request.series_code, series_id: fx ? 'synthetic-fx' : 'synthetic-cpi', external_series_id: 'synthetic-series', name: 'Observación sintética', provider_code: 'SYNTHETIC', source_url: 'https://example.test/source', methodology: 'Serie sintética para pruebas.', series_status: 'ACTIVE', series_valid_from: '2020-01-01', series_valid_to: null, series_metadata: { licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' }, observation_id: missing ? null : `${request.series_code}:${date}`, observation_date: missing ? null : date, observation_value: missing ? null : fx ? '1000.000000000000' : indexes[date], observation_metadata: { source: 'Fuente sintética' }, revision: 1, fetched_at: '2026-09-01T12:00:00.000Z', job_state: missing ? 'PENDING' : 'COMPLETED', job_error_code: null };
  }) }; } };
  const analytics = analyzeSalaryHistory(settlements);
  const economics = await buildEconomicAnalytics(source, settlements);
  const contexts = analytics.scopes.map(scope => {
    const matching = settlements.filter(item => item.employmentContext === scope.employmentContext && item.currencyCode === scope.currencyCode);
    return { ...sacHistory.contexts[0], employmentId: matching[0].employmentId, employmentContext: scope.employmentContext, currencyCode: scope.currencyCode, countryCode: matching[0].countryCode, employerName: `Empresa sintética ${matching[0].employmentId === id(11) ? 'B' : 'A'}`, firstPeriod: scope.evolution[0].period, lastPeriod: scope.evolution.at(-1).period };
  });
  const comparisons = contexts.flatMap(context => {
    const periods = [...new Set(settlements.filter(item => item.employmentContext === context.employmentContext && item.currencyCode === context.currencyCode).map(item => item.payrollPeriod))].sort();
    return periods.flatMap(fromPeriod => periods.filter(toPeriod => toPeriod > fromPeriod).map(toPeriod => {
      const options = { employmentContext: context.employmentContext, currencyCode: context.currencyCode, fromPeriod, toPeriod };
      return { ...compareSalaryPeriods(settlements, options), economic: compareEconomicPeriods(economics, options) };
    }));
  });
  return { history: { ...sacHistory, contexts, analytics: { ...analytics, scopes: addEconomicProjections(analytics.scopes, economics) } }, comparisons };
}

function observeRequests(options) {
  const originalFetch = window.fetch;
  window.__insightRequests = [];
  window.fetch = async (...args) => {
    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
    if (url.pathname.startsWith('/api/v1/')) window.__insightRequests.push({ url: url.href, method: args[1]?.method || 'GET' });
    const response = await originalFetch(...args);
    if (options.holdFirstComparison && url.pathname.endsWith('/salary-history/comparison') && !window.__comparisonHeld) {
      window.__comparisonHeld = true;
      await new Promise(resolve => { window.__releaseComparison = resolve; });
    }
    return response;
  };
}

const ordinary = [settlement('2026-06', '1000.00'), settlement('2026-07', '1200.00')];
const standard = await scenario([settlement('2026-05', '800.00'), ...ordinary], { indexes: { '2026-05-01': '75', '2026-06-01': '100', '2026-07-01': '150' } });
const browser = await openBrowser();
const exceptions = [];
browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
let injection;

async function visit(options = {}, requestOptions = {}) {
  if (injection) await browser.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
  injection = (await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource({ ...standard, ...options }) + `(${observeRequests.toString()})(${JSON.stringify(requestOptions)});` })).identifier;
  await browser.navigate(new URL('/?section=summary', base).href);
  await browser.waitFor(`document.querySelector('${monthly}') && document.querySelector('${planner}')`);
}
async function text(selector) { return browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`); }
async function click(selector) {
  assert.ok(await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`), `Missing control: ${selector}`);
}
async function change(selector, value) {
  await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function openPlanner() {
  await click(`${planner} summary`);
  await browser.waitFor(`document.querySelector('${planner}').open`);
}
async function metric(label) {
  return browser.evaluate(`([...document.querySelectorAll('${planner} dt')].find(el => el.textContent.startsWith(${JSON.stringify(label)}))?.nextElementSibling?.textContent || '')`);
}
async function checkLayout(name, width) {
  const layout = await browser.evaluate(`({ width: innerWidth, scroll: document.documentElement.scrollWidth, tiny: [...document.querySelectorAll('${planner} input,${planner} select')].filter(el => el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < 16).length, unhandled: window.__salarivoFixture.unhandled })`);
  assert.ok(layout.scroll <= layout.width + 1, `${name}: horizontal overflow ${layout.scroll}/${layout.width}`);
  assert.equal(layout.tiny, 0, 'Visible inputs must be at least 16px');
  assert.deepEqual(layout.unhandled, []);
  await browser.evaluate(`document.querySelector('${monthly}').scrollIntoView({block:'start'})`);
  await browser.screenshot(join(output, `${name}-${width}.png`));
  await browser.evaluate(`document.querySelector('${planner}').scrollIntoView({block:'start'})`);
  await browser.screenshot(join(output, `${name}-planner-${width}.png`));
  await browser.evaluate(`document.querySelector('${planner} .salary-raise-results').scrollIntoView({block:'center'})`);
  await browser.screenshot(join(output, `${name}-results-${width}.png`));
}

try {
  await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1440]) {
    await browser.viewport(width, 1000);
    await visit();
    await browser.waitFor(`document.querySelector('${monthly}').textContent.includes('ARS 200,00')`);
    assert.match(await text(monthly), /Junio 2026.*Julio 2026/s, 'Monthly review names the actual two periods');
    assert.equal(await text(`${monthly} .comparison-conclusion`), 'Tu neto habitual subió. Su poder de compra bajó.', 'The headline distinguishes nominal growth from lost purchasing power');
    const requests = await browser.evaluate("window.__insightRequests.filter(item => new URL(item.url).pathname.endsWith('/comparison'))");
    assert.equal(requests.length, 1);
    for (const [key, value] of Object.entries({ fromPeriod: '2026-06', toPeriod: '2026-07', employmentContext: id(10), currencyCode: 'ARS' })) assert.equal(new URL(requests[0].url).searchParams.get(key), value);
    await openPlanner();
    await change(`${planner} select`, '2026-05');
    assert.match(await metric('Objetivo a precios de'), /ARS 1\.600,00/, 'Changing the reference month recalculates the target');
    await change(`${planner} select`, '2026-06');
    await change(percentageInput, '25');
    assert.match(await metric('Objetivo a precios de'), /ARS 1\.500,00/);
    assert.match(await metric('Aumento para alcanzar'), /25,00%/);
    assert.match(await metric('Neto simulado'), /ARS 1\.500,00/);
    assert.match(await metric('Diferencia contra'), /ARS 0,00/);
    await change(percentageInput, '10,00');
    assert.match(await metric('Neto simulado'), /ARS 1\.320,00/);
    assert.match(await metric('Diferencia contra'), /ARS -180,00/);
    await checkLayout('ready', width);
    await change(percentageInput, '-1');
    assert.doesNotMatch(await metric('Neto simulado'), /1\.320,00/, 'Invalid input withdraws the previous simulation');
    await change(percentageInput, '25');
    await click('button[aria-label="Ocultar importes"]');
    const privateDom = await browser.evaluate(`({ html: document.querySelector('${monthly}').outerHTML + document.querySelector('${planner}').outerHTML, input: [...document.querySelectorAll('${planner} input')].map(el => el.value), storage: Object.entries(localStorage), url: location.href, requests: window.__insightRequests })`);
    assert.doesNotMatch(privateDom.html, /1\.000,00|1\.200,00|1\.500,00|25,00%|1200\.00|1500\.00|mejoró|empeoró|subió|bajó/i);
    assert.deepEqual(privateDom.input, [], 'Privacy mode removes the salary-derived input from DOM');
    assert.doesNotMatch(JSON.stringify(privateDom.storage), /1200|1500|25\.00/);
    assert.doesNotMatch(privateDom.url, /1200|1500|25/);
    assert.ok(privateDom.requests.every(request => request.method === 'GET'), 'The simulation stays in memory');
    assert.ok(privateDom.requests.every(request => !/1200|1500|25\.00/.test(request.url)), 'Salary and simulation amounts never enter URLs');
    await checkLayout('private', width);
    await click('button[aria-label="Mostrar importes"]');
    assert.match(await metric('Neto simulado'), /ARS 1\.500,00/);
  }

  await visit({ failPaths: ['/salary-history/comparison'] });
  await browser.waitFor(`document.querySelector('${monthly} [role="alert"]')`);
  assert.doesNotMatch(await text(monthly), /ARS 200,00/, 'Failed request does not assert a monthly result');
  await browser.evaluate("window.__salarivoFixture.failPaths = []; [...document.querySelectorAll('.monthly-review button')].find(el => el.textContent.includes('Reintentar resumen mensual')).click()");
  await browser.waitFor(`document.querySelector('${monthly}').textContent.includes('ARS 200,00')`);

  const sac = await scenario([settlement('2026-06', '1000.00'), settlement('2026-07', '1000.00'), settlement('2026-06', '400.00', { settlementType: 'SAC', isRecurring: false, earnings: [{ code: 'SAC', amount: '400.00', isRecurring: false }] })], { indexes: { '2026-06-01': '100', '2026-07-01': '100' } });
  await visit(sac);
  await browser.waitFor(`document.querySelector('${monthly}').textContent.includes('ARS 0,00')`);
  assert.match(await text(monthly), /SAC|aguinaldo/i);
  assert.equal(await text(`${monthly} .comparison-conclusion`), 'Tu neto habitual no cambió. Su poder de compra se mantuvo.', 'Removing SAC does not report a fall in habitual salary');
  await openPlanner();
  await change(`${planner} select`, '2026-06');
  await change(percentageInput, '0');
  assert.match(await metric('Objetivo a precios de'), /ARS 1\.000,00/, 'SAC is excluded from the reference salary');
  assert.match(await metric('Último neto'), /ARS 1\.000,00/);
  assert.match(await metric('Aumento para alcanzar'), /0,00%/);

  await visit(await scenario([ordinary[0], settlement('2026-07', '800.00')], { indexes: { '2026-06-01': '100', '2026-07-01': '100' } }));
  await browser.waitFor(`document.querySelector('${monthly}').textContent.includes('ARS -200,00')`);
  assert.equal(await text(`${monthly} .comparison-conclusion`), 'Tu neto habitual bajó. Su poder de compra bajó.', 'A negative nominal change is explained as a decrease');

  const partial = await scenario(ordinary, { missingCpi: ['2026-06-01'] });
  await visit(partial);
  await openPlanner();
  await change(`${planner} select`, '2026-06');
  assert.doesNotMatch(await metric('Objetivo a precios de'), /ARS [0-9]/, 'Missing CPI is never interpolated');
  assert.equal(await metric('Neto simulado'), '', 'The IPC planner requires a covered reference');
  assert.match(await text(planner), /IPC|cobertura|sincroniz|disponible|falt/i);

  const mixed = await scenario([ordinary[0], { ...ordinary[1], earnings: [{ code: 'BASIC_SALARY', amount: '800.00', isRecurring: true }, { code: 'SAC', amount: '400.00', isRecurring: false }] }]);
  await visit(mixed);
  await openPlanner();
  assert.doesNotMatch(await metric('Último neto'), /ARS 1\.200,00|ARS 1\.000,00/, 'A mixed latest receipt must not use its total or silently fall back to an earlier salary');
  assert.match(await text(planner), /discriminar|separar|habitual|disponible/i);

  const ambiguous = await scenario([...ordinary, settlement('2026-07', '300.00', { id: id(290), documentId: id(390) })]);
  await visit(ambiguous);
  await openPlanner();
  assert.equal(await metric('Neto simulado'), '', 'Two normal salaries with ambiguous basics do not become one salary');
  assert.match(await text(planner), /básico|ambigu|comparab/i);

  const sacOnly = await scenario([...ordinary, settlement('2026-08', '400.00', { settlementType: 'SAC', isRecurring: false, earnings: [{ code: 'SAC', amount: '400.00', isRecurring: false }] })]);
  await visit(sacOnly);
  await browser.waitFor(`document.querySelector('${monthly} .monthly-review-metrics')`);
  assert.match(await text(monthly), /Julio 2026.*Agosto 2026/s, 'Monthly review preserves an extra-only latest period');
  assert.match(await text(monthly), /No hay dos netos habituales separables/);
  await openPlanner();
  assert.match(await metric('Último neto'), /ARS 1\.200,00/, 'A SAC-only period does not replace the latest normal salary');

  const single = await scenario([ordinary[1]]);
  await visit(single);
  assert.match(await text(monthly), /Importá otro recibo|otro período/i);
  assert.equal((await browser.evaluate("window.__insightRequests.filter(item => new URL(item.url).pathname.endsWith('/comparison'))")).length, 0);

  const second = ordinary.map((item, index) => ({ ...item, id: id(240 + index), documentId: id(340 + index), employmentId: id(11), employmentContext: id(11), currencyCode: 'USD', countryCode: 'US', basicAmount: '1700.00', grossAmount: '1700.00', netAmount: '1700.00', remunerativeAmount: '1700.00', earnings: [{ code: 'BASIC_SALARY', amount: '1700.00', isRecurring: true }] }));
  const multiple = await scenario([...ordinary, ...second]);
  await visit(multiple, { holdFirstComparison: true });
  await browser.waitFor('window.__comparisonHeld');
  const secondValue = await browser.evaluate("[...document.querySelectorAll('#summary-salary-scope option')].find(el => el.textContent.includes('Empresa sintética B')).value");
  await change('#summary-salary-scope', secondValue);
  await browser.waitFor(`document.querySelector('${monthly}').textContent.includes('USD 0,00')`);
  const selectedReview = await text(monthly);
  await browser.evaluate('window.__releaseComparison()');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await text(monthly), selectedReview, 'A late response from another employment cannot overwrite the selected context');
  await openPlanner();
  assert.equal(await metric('Neto simulado'), '', 'The planner is unavailable for unsupported profiles');
  assert.match(await text(planner), /Argentina.*ARS/);
  assert.doesNotMatch(await metric('Objetivo a precios de'), /ARS|USD [0-9]/, 'Unsupported country/currency does not reuse Argentine CPI');

  await visit();
  await openPlanner();
  await change(`${planner} select`, '2026-05');
  await browser.evaluate("[...document.querySelectorAll('.salary-raise-planner button')].find(el => el.textContent === 'Ver recibo de referencia').click()");
  await browser.waitFor("new URLSearchParams(location.search).get('section') === 'history'");
  const referenceUrl = new URL(await browser.evaluate('location.href'));
  assert.equal(referenceUrl.searchParams.get('period'), '2026-05');
  assert.equal(referenceUrl.searchParams.get('employmentContext'), id(10));
  assert.equal(referenceUrl.searchParams.get('currencyCode'), 'ARS');
  await visit();
  await browser.evaluate("[...document.querySelectorAll('.monthly-review button')].find(el => el.textContent === 'Ver detalle del período').click()");
  await browser.waitFor("new URLSearchParams(location.search).get('section') === 'history'");
  assert.equal(new URL(await browser.evaluate('location.href')).searchParams.get('period'), '2026-07');
  assert.deepEqual(exceptions, [], 'No unhandled browser exceptions');
  assert.deepEqual(await browser.evaluate('window.__salarivoFixture.unhandled'), []);
  process.stdout.write(`Salary insights: 320/390/1440px, exact simulations, privacy, SAC, partial IPC, mixed receipt, one period, retry and context race passed. Screenshots: ${output}\n`);
} finally {
  await browser.close();
}
