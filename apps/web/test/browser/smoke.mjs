import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './cdp.mjs';
import { fixtureSource, id, manyEmployments, syntheticPdf } from './fixtures.mjs';

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
async function filterJobs(value, status = 'ALL') {
  await browser.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Empresa, puesto o año"]');
    const select = [...document.querySelectorAll('select')].find(el => [...el.labels].some(label => label.textContent.startsWith('Estado')));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(status)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
const employmentIds = '[...document.querySelectorAll(".employment-row .employment-card-link")].map(el => new URL(el.href).searchParams.get("employmentId"))';

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
        await browser.evaluate('document.querySelector(".bar-group:last-child")?.focus()');
        const reading = await browser.evaluate(`(() => { const reading = document.querySelector('.chart-reading'); const chart = document.querySelector('.bar-chart'); const last = chart?.querySelector('.bar-group:last-child'); const rect = reading?.getBoundingClientRect(); return { period: reading?.querySelector('strong')?.textContent, last: last?.querySelector('small')?.textContent, left: rect?.left, right: rect?.right, width: innerWidth, tooltipCount: document.querySelectorAll('.chart-tooltip').length, chartOverflow: chart && chart.scrollHeight > chart.clientHeight + 1 }; })()`);
        assert.equal(reading.period, reading.last, 'Keyboard focus updates the visible monthly amounts');
        assert.equal(reading.tooltipCount, 0, 'Monthly amounts are outside the clipped scrolling graph');
        assert.ok(reading.left >= 0 && reading.right <= reading.width + 1, 'Monthly amounts stay inside the viewport');
        assert.equal(reading.chartOverflow, false);
        const grossChart = await browser.evaluate(`(() => {
          const chart = document.querySelector('.salary-evolution');
          const grossReading = [...chart.querySelectorAll('.chart-reading > span')].find(el => el.textContent.startsWith('Bruto:'));
          return { legend: [...chart.querySelectorAll('.legend > span')].map(el => el.textContent),
            series: [...chart.querySelectorAll('.bars')].map(el => [...el.children].map(bar => bar.className)),
            heights: [...chart.querySelectorAll('.bar')].map(el => parseFloat(el.style.height)),
            maximum: chart.querySelector('.bar-group:last-child .gross')?.style.height,
            reading: grossReading?.textContent.replace(/^Bruto:\\s*/, ''),
            table: chart.querySelector('tbody tr:last-child [data-label="Bruto total"]')?.textContent };
        })()`);
        assert.deepEqual(grossChart.legend, ['Básico comparable', 'Bruto total', 'Neto total']);
        assert.ok(grossChart.series.length > 0 && grossChart.series.every(series => JSON.stringify(series) === JSON.stringify(['bar comparable', 'bar gross', 'bar net'])), 'Each month shows comparable, gross and net in order');
        assert.equal(grossChart.maximum, '100%', 'The largest synthetic gross sets the chart scale');
        assert.ok(grossChart.heights.every(height => height <= 100), 'Gross bars fit within the shared scale');
        assert.ok(grossChart.reading && /[0-9]/.test(grossChart.reading), 'Monthly reading includes the exact gross amount');
        assert.equal(grossChart.reading, grossChart.table, 'Gross reading matches the exact table for the focused month');
        await layout(`${name}-chart-last-month`, true);
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

  for (const width of [320, 390, 768, 1440]) {
    await browser.viewport(width, 900);
    await visit('/?section=jobs', 'owner', { employments: manyEmployments });
    assert.deepEqual(await browser.evaluate(employmentIds), [601, 10, 602, 603, 604, 605, 606, 607, 608, 600, 609, 610].map(id), 'Every employment episode is visible, current jobs first and each group newest first');
    assert.deepEqual(await browser.evaluate(String.raw`[...document.querySelectorAll('.employment-group h2')].map(el => el.textContent.replace(/\s*\d+\s*$/, ''))`), ['Actuales', 'Anteriores', 'Por confirmar']);
    assert.equal(await browser.evaluate(`[...document.querySelector('input[placeholder="Empresa, puesto o año"]').labels].some(label => label.textContent.includes('Buscar empleos'))`), true);
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".employment-row")].filter(el => el.textContent.includes("Sin sueldo mensual registrado")).length'), 11, 'Missing salary history is explicit for every other employment');
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".employment-row h3")].filter(el => el.textContent.includes("Empresa Sintética")).length'), 2, 'Re-entry into one employer remains two separate episodes');
    await layout('many-employments', true);
    await filterJobs('', 'ACTIVE');
    assert.deepEqual(await browser.evaluate(employmentIds), [601, 10].map(id));
    await layout('many-employments-active', true);
    await filterJobs('', 'ENDED');
    assert.equal((await browser.evaluate(employmentIds)).length, 9);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".employment-milestones dt")].map(el => el.textContent)'), Array(9).fill('Duración del empleo'), 'Ended employment rows show duration without a future anniversary');
    await filterJobs('', 'UNKNOWN');
    assert.deepEqual(await browser.evaluate(employmentIds), [id(610)]);
    assert.equal(await browser.evaluate('document.querySelectorAll(".employment-milestones").length'), 0, 'Unknown continuity does not invent tenure or an anniversary');
    for (const [query, expected] of [['nandu', 601], ['coordinacion', 603], ['2026', 601]]) {
      await filterJobs(query);
      assert.deepEqual(await browser.evaluate(employmentIds), [id(expected)], 'Search matches employer, role or year without requiring accents');
    }
    await filterJobs('nandu', 'ENDED');
    assert.deepEqual(await browser.evaluate(employmentIds), [], 'Search and status filters combine');
    await layout('many-employments-no-match', true);
    await clickText('Limpiar filtros');
    await browser.waitFor('document.querySelectorAll(".employment-row").length === 12');
    const menu = '.employment-row .employment-menu summary';
    await browser.evaluate(`document.querySelector(${JSON.stringify(menu)}).scrollIntoView({block:'center'})`);
    const menuHit = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(menu)}); const box = el.getBoundingClientRect(); return { width: box.width, height: box.height, menu: !!document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.employment-menu') }; })()`);
    assert.ok(menuHit.menu && menuHit.width >= 44 && menuHit.height >= 44, 'The actions menu has its own accessible hit target');
    await click(menu);
    assert.equal(await browser.evaluate('!!document.querySelector(".employment-detail-actions")'), false, 'Opening actions does not open the employment');
    await clickText('Editar');
    await browser.waitFor('document.querySelector("dialog:modal")');
    await layout('many-employments-edit', true);
    await clickText('Cancelar');
    await click('.employment-row .employment-card-link');
    await browser.waitFor('document.querySelector(".employment-detail-actions")');
    assert.equal(await browser.evaluate('new URLSearchParams(location.search).get("employmentId")'), id(601), 'The row opens its own episode, including jobs without salary history');
    await layout('many-employments-detail', true);
  }
  process.stdout.write('Twelve employment episodes, search, filters and independent actions at 320–1440px passed.\n');

  for (const width of [320, 1440]) {
    await browser.viewport(width, 850);
    await visit('/?section=summary', 'owner', { private: true });
    assert.ok(await browser.evaluate('document.body.innerText.includes("••••••••")'));
    await clickText('Mostrar importes');
    await browser.waitFor('!document.body.innerText.includes("••••••••")');
    await clickText('Ocultar importes');
    await browser.waitFor('document.body.innerText.includes("••••••••")');
    const protectedChart = await browser.evaluate(`(() => {
      const chart = document.querySelector('.salary-evolution');
      return { gross: [...chart.querySelectorAll('.chart-reading > span,[data-label="Bruto total"]')].filter(el => el.matches('[data-label]') || el.textContent.startsWith('Bruto:')).map(el => el.textContent),
        heights: [...chart.querySelectorAll('.bar')].map(el => el.style.height),
        maximum: chart.querySelector('.bar-group:last-child .gross')?.style.height };
    })()`);
    assert.ok(protectedChart.gross.length > 1 && protectedChart.gross.every(text => text.includes('••••••••') && !/[0-9]/.test(text)), 'Privacy masks gross in the monthly reading and exact table');
    assert.ok(protectedChart.heights.every(height => ['30%', '52%', '74%', '96%'].includes(height)), 'Every series uses protected chart heights');
    assert.equal(protectedChart.maximum, '96%', 'The largest gross uses its protected rank instead of a proportional height');

    await visit('/?section=jobs');
    const employmentCard = await browser.evaluate(`(() => {
      const card = document.querySelector('.employment-row');
      return { milestones: card.querySelector('.employment-milestones')?.textContent,
        milestoneLabels: [...card.querySelectorAll('.employment-milestones dt')].map(el => el.textContent),
        salaryLabels: [...card.querySelectorAll('.employment-salary dt')].map(el => el.textContent),
        salaries: [...card.querySelectorAll('.employment-salary dd')].map(el => el.textContent),
        summary: card.querySelector('.employment-card-summary')?.textContent };
    })()`);
    assert.equal(employmentCard.milestoneLabels[0], 'Antigüedad');
    assert.ok(['Próximo aniversario', 'Aniversario hoy'].includes(employmentCard.milestoneLabels[1]));
    assert.match(employmentCard.milestones, /\d+ (año|mes|día)/, 'Employment tenure is visible');
    assert.match(employmentCard.milestones, /Cumplís \d+ año/, 'The next employment anniversary is visible');
    assert.deepEqual(employmentCard.salaryLabels, ['Bruto', 'Neto']);
    assert.deepEqual(employmentCard.salaries, ['ARS 1.937.507,98', 'ARS 1.637.507,98'], 'Both amounts come from the latest synthetic settlement');
    assert.match(employmentCard.summary, /Último sueldo mensual · Agosto 2026/);
    assert.match(employmentCard.summary, /20 períodos con recibos · 20 documentos/);
    await layout('employment-milestones', true);
    await clickText('Ocultar importes');
    const hiddenSalaries = await browser.evaluate('[...document.querySelectorAll(".employment-salary dd")].map(el => el.textContent)');
    assert.ok(hiddenSalaries.length === 2 && hiddenSalaries.every(text => text.includes('••••••••') && !/[0-9]/.test(text)), 'Privacy hides gross and net in employment cards');
    assert.equal(await browser.evaluate('document.querySelector(".employment-milestones").textContent'), employmentCard.milestones, 'Tenure and anniversary remain visible with private salaries');
    await clickText('Mostrar importes');
    await clickText('Agregar empleo');
    await browser.waitFor('document.querySelector("dialog:modal,[role=dialog]")');
    await layout('employment-form', true);
    await clickText('Cancelar');
    await click('.employment-card-link');
    await browser.waitFor('document.querySelector(".employment-detail-actions")');
    assert.equal(await browser.evaluate('document.querySelector(".employment-milestones")?.textContent'), employmentCard.milestones, 'The employment detail shows the same tenure and anniversary as its card');
    await layout('employment-detail-milestones', true);

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
  await writeFile(join(output, 'results.json'), JSON.stringify({ measurements, checks: ['all-owner-routes', 'mobile-widths', 'landscape', 'long-names-money', 'many-employments-filters-actions', 'employment-milestones-salaries', 'forms', 'privacy', 'pdf-fit-zoom', 'upload-synthetic', 'empty-error', 'logout'], exceptions }, null, 2));
  process.stdout.write(`${measurements.length} responsive checks passed. Screenshots: ${output}\n`);
} finally { await browser.close(); }
