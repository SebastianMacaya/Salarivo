import assert from 'node:assert/strict';
import test from 'node:test';
import { extractArgentinePayroll } from '../src/engine.ts';
import { orchestrateExtraction } from '../src/extraction-orchestrator.ts';
import { DisabledOCRProvider, OCRProviderError, type OCRResult } from '../src/ocr-provider.ts';

const syntheticReceipt = `RECIBO DE SUELDO
Moneda: ARS
Empleador: Empresa-Sintética S.A.
Período de liquidación: 08/2026
Sueldo básico $ 1.000,00
Jubilación $ 100,00
Total bruto $ 1.000,00
Total descuentos $ 100,00
Neto a cobrar $ 900,00`;
const result = (text = syntheticReceipt): OCRResult => ({
  provider: 'synthetic-ocr', model: 'test', providerVersion: '1', text,
  pages: [{ pageNumber: 1, blocks: [{ type: 'TEXT', content: '$ 1.000,00',
    sourceRegion: { version: 1, space: 'PAGE_NORMALIZED', origin: 'TOP_LEFT', x: 0.1, y: 0.2, width: 0.3, height: 0.05 } }] }],
  externalRequestId: 'synthetic-request', durationMs: 1, retryCount: 0,
});
const input = (text: string) => ({ text, evidence: [], source: 'PDF_TEXT' as const });

test('el recibo conocido conserva todos los valores y no llama al proveedor', async () => {
  let calls = 0;
  const outcome = await orchestrateExtraction(input(syntheticReceipt), {
    fallback: async () => { calls++; return result(); },
  });
  assert.deepEqual(outcome.extraction, extractArgentinePayroll(syntheticReceipt, 'PDF_TEXT'));
  assert.equal(calls, 0);
  assert.equal(outcome.triggerReason, null);
});

test('OCR que cambia la columna remunerativa conserva el conflicto aunque concilien importes y conceptos', async () => {
  const row = (label: string, remunerative = '', nonRemunerative = '', deductions = '') =>
    `${label.padEnd(48)}${remunerative.padStart(20)}${nonRemunerative.padStart(20)}${deductions.padStart(20)}`;
  const receipt = (swapped: boolean) => [
    'RECIBO DE SUELDO', 'Moneda: ARS', 'Empleador: Empresa Sintética S.A.', 'Período: 08/2026',
    row('Concepto', 'Remunerativo', 'No remunerativo', 'Descuentos'),
    row('Sueldo básico', swapped ? '' : '100,00', swapped ? '100,00' : ''),
    row('Adicional empresa', swapped ? '100,00' : '', swapped ? '' : '100,00'),
    row('Deducción', '', '', '20,00'), row('Totales', '100,00', '100,00', '20,00'),
    'Neto a cobrar $ 180,00',
  ].join('\n');
  const outcome = await orchestrateExtraction(input(receipt(false)), {
    requiredReason: 'FIELD_RECOVERY', fallback: async () => result(receipt(true)),
  });
  assert.equal(outcome.extraction.needsReview, false);
  assert.ok(outcome.issues.includes('OCR_RESULT_CONFLICT'));
});

test('scan sintético recupera por OCR, reintenta el parser y conserva evidencia real', async () => {
  let calls = 0;
  const outcome = await orchestrateExtraction(input(''), {
    fallback: async (reason) => { calls++; assert.equal(reason, 'NO_NATIVE_TEXT'); return result(); },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.extraction.netAmount, '900.00');
  assert.equal(outcome.extraction.fields.find((field) => field.fieldPath === 'settlement.basicAmount')?.source, 'OCR');
  assert.equal(outcome.extraction.fields.find((field) => field.fieldPath === 'settlement.basicAmount')?.pageNumber, 1);
  assert.deepEqual(outcome.issues, []);
});

test('layout desconocido y proveedor desactivado dejan issues de revisión sin HTTP', async () => {
  const unknown = await orchestrateExtraction(input(''), { fallback: async () => result('Texto sintético ilegible') });
  assert.ok(unknown.issues.includes('UNKNOWN_LAYOUT'));
  const disabled = new DisabledOCRProvider();
  const outcome = await orchestrateExtraction(input(''), {
    fallback: () => disabled.extract({ bytes: new Uint8Array(), mimeType: 'application/pdf', pageCount: 1 }),
  });
  assert.deepEqual(outcome.issues, ['COUNTRY_UNCONFIRMED', 'OCR_DISABLED']);
  assert.equal(outcome.extraction.payrollPeriod, null);
});

test('un error de proveedor conserva la extracción previa; un error de código no dispara otro OCR', async () => {
  const partialText = syntheticReceipt.replace('Sueldo básico $ 1.000,00', '');
  const failed = await orchestrateExtraction(input(partialText), {
    fallback: async () => { throw new OCRProviderError('OCR_TIMEOUT', true); },
  });
  assert.deepEqual(failed.extraction, extractArgentinePayroll(partialText, 'PDF_TEXT'));
  assert.deepEqual(failed.issues, ['OCR_TIMEOUT']);
  await assert.rejects(orchestrateExtraction(input(partialText), {
    fallback: async () => { throw new Error('synthetic programming error'); },
  }), /synthetic programming error/);
});

test('cache normalizada evita pagar otro OCR y diferencias de valores requieren revisión', async () => {
  let calls = 0;
  const cached = await orchestrateExtraction(input(''), {
    cachedOcr: result(), fallback: async () => { calls++; return result(); },
  });
  assert.equal(calls, 0);
  assert.equal(cached.extraction.netAmount, '900.00');
  const partial = syntheticReceipt.replace('Sueldo básico $ 1.000,00', '');
  const changed = await orchestrateExtraction(input(partial), {
    fallback: async () => result(syntheticReceipt.replace('900,00', '800,00')),
  });
  assert.ok(changed.issues.includes('OCR_RESULT_CONFLICT'));
});

test('OCR local parcial requiere recuperación y una caja de bloque no inventa coordenadas de palabras', async () => {
  let calls = 0;
  const blockResult = result();
  blockResult.pages[0]!.blocks[0]!.content = 'Sueldo básico $ 1.000,00';
  const outcome = await orchestrateExtraction(input(syntheticReceipt), {
    requiredReason: 'PARSER_PARTIAL_RESULT',
    fallback: async () => { calls++; return blockResult; },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.extraction.fields.find((field) => field.fieldPath === 'settlement.basicAmount')?.sourceRegion, undefined);
});

test('OCR no reemplaza ni elimina conceptos nativos aunque los totales coincidan, y permite completar otros', async () => {
  const native = syntheticReceipt.replace('Empleador: Empresa-Sintética S.A.\n', '')
    .replace('Jubilación', 'Bono productividad $ 100,00\nHoras extra $ 50,00\nJubilación')
    .replace('Total bruto $ 1.000,00', 'Total bruto $ 1.150,00')
    .replace('Neto a cobrar $ 900,00', 'Neto a cobrar $ 1.050,00');
  const withEmployer = (text: string) => text.replace('RECIBO DE SUELDO', 'RECIBO DE SUELDO\nEmpleador: Empresa-Sintética S.A.');
  for (const changed of [
    native.replace('Bono productividad $ 100,00', 'Bono productividad $ 50,00').replace('Horas extra $ 50,00', 'Horas extra $ 100,00'),
    native.replace('Bono productividad $ 100,00\n', ''),
  ]) {
    const outcome = await orchestrateExtraction(input(native), { fallback: async () => result(withEmployer(changed)) });
    assert.equal(outcome.triggerReason, 'UNKNOWN_EMPLOYER');
    assert.equal(outcome.extraction.grossAmount, '1150.00');
    assert.equal(outcome.extraction.netAmount, '1050.00');
    assert.ok(outcome.issues.includes('OCR_RESULT_CONFLICT'));
  }
  const completed = await orchestrateExtraction(input(native.replace('Bono productividad $ 100,00\n', '')), {
    fallback: async () => result(withEmployer(native)),
  });
  assert.deepEqual(completed.issues, []);
  const reordered = await orchestrateExtraction(input(native), {
    fallback: async () => result(withEmployer(native.replace('Bono productividad $ 100,00\nHoras extra $ 50,00', 'Horas extra $ 50,00\nPremio productividad $ 100,00'))),
  });
  assert.deepEqual(reordered.issues, []);
  const duplicate = native.replace('Horas extra $ 50,00', 'Horas extra $ 50,00\nHoras extra $ 50,00');
  const lostDuplicate = await orchestrateExtraction(input(duplicate), { fallback: async () => result(withEmployer(native)) });
  assert.ok(lostDuplicate.issues.includes('OCR_RESULT_CONFLICT'));
});
