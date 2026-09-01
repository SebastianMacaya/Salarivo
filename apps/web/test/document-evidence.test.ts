import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceIdForPage,
  extractionRunChanged,
  fetchDocumentPrefix,
  parseNormalizedRegion,
  readDocumentLocation,
  readOwnerLocation,
  regionPixels,
  reviewValueChanged,
  safeCanvasScale,
  writeDocumentLocation,
  writeOwnerLocation,
} from '../app/document-evidence.ts';
import { createStepUpGate } from '../app/sensitive-action.ts';

const documentId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const employmentId = '33333333-3333-4333-8333-333333333333';
const employmentContext = 'detected:44444444-4444-4444-8444-444444444444';
const region = parseNormalizedRegion({
  version: 1,
  space: 'PAGE_NORMALIZED',
  origin: 'TOP_LEFT',
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.1,
});

test('deep-link conserva sólo ids y página válidos', () => {
  assert.deepEqual(readDocumentLocation(`?document=${documentId}&page=3&evidence=${evidenceId}&salary=ignored`), {
    documentId,
    page: 3,
    evidenceId,
  });
  assert.equal(readDocumentLocation('?document=../secret&page=-1'), null);
  assert.equal(writeDocumentLocation('?auth=ok&salary=100', { documentId, page: 1, evidenceId }), `?document=${documentId}&evidence=${evidenceId}`);
  assert.equal(writeDocumentLocation('', { documentId: 'salary=100', page: 999, evidenceId: 'ocr text' }), '');
  assert.equal(writeDocumentLocation(`?document=${documentId}&page=2`, null), '');
});

test('la ubicación owner lee sólo navegación y filtros válidos', () => {
  assert.deepEqual(readOwnerLocation(
    `?currencyCode=ARS&section=history&employmentContext=${employmentContext}&employmentId=${employmentId}&tab=documents&range=24&year=2026&period=2026-08`
      + '&documentType=PAYROLL&settlementType=OTRO_LABORAL&status=REVIEW'
      + '&privacy=blur&search=sebastian&filename=recibo.pdf&ocr=texto&salary=100&amount=200&unknown=value',
  ), {
    currencyCode: 'ARS',
    section: 'history',
    employmentContext,
    employmentId,
    tab: 'documents',
    range: '24',
    year: '2026',
    period: '2026-08',
    documentType: 'PAYROLL',
    settlementType: 'OTRO_LABORAL',
    status: 'REVIEW',
  });

  assert.deepEqual(readOwnerLocation(
    '?currencyCode=ARS1&section=admin&employmentContext=detected%3Aempresa&employmentId=all&tab=raw&range=365&year=1999&period=2026-13'
      + '&documentType=PDF&settlementType=neto%20100&status=DELETED',
  ), {});
});

test('la ubicación owner aplica patches, permite borrar y conserva el documento válido', () => {
  const search = `?section=summary&employmentContext=${employmentContext}&employmentId=${employmentId}&tab=summary&document=${documentId}`
    + `&page=3&evidence=${evidenceId}&auth=secret&salary=999&unknown=value`;
  assert.equal(
    writeOwnerLocation(search, { section: 'history', tab: 'documents', year: '2026', status: 'READY' }),
    `?section=history&employmentContext=${encodeURIComponent(employmentContext)}&employmentId=${employmentId}&tab=documents&year=2026&status=READY`
      + `&document=${documentId}&page=3&evidence=${evidenceId}`,
  );
  assert.equal(
    writeOwnerLocation(search, { employmentContext: null, employmentId: null, section: null, tab: null }),
    `?document=${documentId}&page=3&evidence=${evidenceId}`,
  );
  assert.equal(
    writeOwnerLocation(search, { employmentId: undefined }),
    `?section=summary&employmentContext=${encodeURIComponent(employmentContext)}&employmentId=${employmentId}&tab=summary`
      + `&document=${documentId}&page=3&evidence=${evidenceId}`,
  );
  assert.equal(
    writeOwnerLocation('?section=history&year=2026', {
      section: 'admin' as 'history',
      year: '20xx',
      settlementType: 'neto 100',
    }),
    '',
  );
});

test('el deep-link documental conserva sólo el estado owner permitido', () => {
  assert.equal(
    writeDocumentLocation(
      `?section=history&employmentId=${employmentId}&tab=documents&range=all&year=all`
        + '&documentType=ALL&settlementType=SAC&status=ALL&privacy=on&search=empresa'
        + `&filename=recibo.pdf&ocr=texto&amount=100&auth=secret&salary=999&unknown=value&document=${evidenceId}`,
      { documentId, page: 2, evidenceId },
    ),
    `?section=history&employmentId=${employmentId}&tab=documents&range=all&year=all`
      + '&documentType=ALL&settlementType=SAC&status=ALL'
      + `&document=${documentId}&page=2&evidence=${evidenceId}`,
  );
  assert.equal(writeDocumentLocation(`?section=history&document=${documentId}`, null), '?section=history');
});

test('un refresh silencioso conserva las páginas ya cargadas y su próximo cursor', async () => {
  const calls: Array<[string | undefined, number]> = [];
  const page = await fetchDocumentPrefix(async (cursor, limit) => {
    calls.push([cursor, limit]);
    const start = cursor ? Number(cursor) : 0;
    const items = Array.from({ length: limit }, (_, index) => start + index);
    return { items, nextCursor: String(start + limit), pendingReview: 3, total: 250 };
  }, 150);
  assert.deepEqual(calls, [[undefined, 100], ['100', 50]]);
  assert.equal(page.items.length, 150);
  assert.equal(page.nextCursor, '150');
  assert.equal(page.total, 250);
});

test('la evidencia no sobrevive a una página o documento incompatibles', () => {
  const fields = [{ id: evidenceId, pageNumber: 1 }, { id: '33333333-3333-4333-8333-333333333333', pageNumber: 2 }];
  assert.equal(evidenceIdForPage(evidenceId, 1, fields), evidenceId);
  assert.equal(evidenceIdForPage(evidenceId, 2, fields), undefined);
  assert.equal(evidenceIdForPage('44444444-4444-4444-8444-444444444444', 1, fields), undefined);
});

test('una edición conserva el run base y detecta un reproceso concurrente', () => {
  const firstRun = '55555555-5555-4555-8555-555555555555';
  const nextRun = '66666666-6666-4666-8666-666666666666';
  assert.equal(extractionRunChanged(firstRun, firstRun), false);
  assert.equal(extractionRunChanged(firstRun, nextRun), true);
  assert.equal(extractionRunChanged(firstRun, null), true);
});

test('una sola reautenticación libera callers sensibles concurrentes sin reemplazarlos', async () => {
  const gate = createStepUpGate();
  const resumed: string[] = [];
  const first = gate.promise.then((approved) => { if (approved) resumed.push('first'); });
  const second = gate.promise.then((approved) => { if (approved) resumed.push('second'); });
  gate.complete(true);
  await Promise.all([first, second]);
  assert.deepEqual(resumed.sort(), ['first', 'second']);
});

test('la región normalizada escala sin desviarse con zoom o viewport mobile', () => {
  assert.ok(region);
  assert.deepEqual(regionPixels(region, 600, 800), { left: 60, top: 160, width: 180, height: 80 });
  assert.deepEqual(regionPixels(region, 900, 1200), { left: 90, top: 240, width: 270, height: 120 });
  assert.deepEqual(regionPixels(region, 320, 480), { left: 32, top: 96, width: 96, height: 48 });
  assert.deepEqual(regionPixels(region, 800, 600, 90), { left: 560, top: 60, width: 80, height: 180 });
});

test('rechaza regiones falsas o fuera de página', () => {
  assert.equal(parseNormalizedRegion({ x: 0, y: 0, width: 1, height: 1 }), null);
  assert.equal(parseNormalizedRegion({ version: 1, space: 'PAGE_NORMALIZED', origin: 'TOP_LEFT', x: 0.9, y: 0, width: 0.2, height: 1 }), null);
});

test('limita el canvas de páginas con relación de aspecto extrema', () => {
  const scale = safeCanvasScale(1, 10_000, 600, 2);
  assert.ok(scale);
  assert.ok(1 * scale * 2 <= 8192);
  assert.ok(10_000 * scale * 2 <= 8192);
  assert.ok(1 * 10_000 * scale * scale * 4 <= 16_777_216);
  assert.equal(safeCanvasScale(0, 100, 1, 1), null);
});

test('dirty state compara el valor financiero y no su formato', () => {
  assert.equal(reviewValueChanged('settlement.netAmount', '5.327.075', '5327075.00'), false);
  assert.equal(reviewValueChanged('settlement.netAmount', '$ 5.327.075,00', '5327075'), false);
  assert.equal(reviewValueChanged('settlement.netAmount', '-5.327.075,00', '-5327075'), false);
  assert.equal(reviewValueChanged('settlement.netAmount', '5.372.075', '5327075.00'), true);
});
