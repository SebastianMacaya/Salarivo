import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovedDocumentLayout, LayoutAliases } from '@salarivo/database/document-layouts';
import { extractArgentinePayroll, payrollExtractionNeedsReview } from '../src/engine.ts';
import { orchestrateExtraction } from '../src/extraction-orchestrator.ts';
import { fingerprintLayout } from '../src/layout-fingerprint.ts';
import { OCRProviderError, type OCRResult } from '../src/ocr-provider.ts';

const receipt = `RECIBO DE SUELDO
Moneda: ARS
Empleador: Empresa Sintética S.A.
Ciclo liquidado: 08/2026
Asignación contractual $ 1.000,00
Jubilación $ 100,00
Total bruto $ 1.000,00
Total descuentos $ 100,00
Neto a cobrar $ 900,00`;
const aliases: LayoutAliases = {
  'settlement.basicAmount': ['Asignación contractual'],
  'settlement.payrollPeriod': ['Ciclo liquidado'],
};
const profile: ApprovedDocumentLayout = {
  id: 'synthetic-version', layoutId: 'synthetic-layout', version: 1,
  fingerprint: fingerprintLayout(receipt, 1)!, fingerprintVersion: '1', aliases,
  countryCode: 'AR', documentType: 'PAYROLL', parserVersion: '8',
};
const input = (text: string) => ({ text, source: 'PDF_TEXT' as const, evidence: [] });

test('fingerprint uses structural anchors and column order, independent of amounts, dates and identities', () => {
  assert.match(profile.fingerprint, /^[a-f0-9]{64}$/);
  const changed = receipt.replace('Empresa Sintética S.A.', 'Otra Empresa S.R.L.').replaceAll('1.000,00', '2.000,00')
    .replace('08/2026', '09/2026').replace('100,00', '200,00').replace('900,00', '1.800,00');
  assert.equal(fingerprintLayout(changed, 1), profile.fingerprint);
  assert.equal(fingerprintLayout(receipt.replace('Empresa Sintética S.A.', 'Código Concepto Unidades S.A.'), 1), profile.fingerprint);
  assert.notEqual(fingerprintLayout(changed, 2), profile.fingerprint);
  assert.notEqual(fingerprintLayout(receipt.replace('Total bruto $ 1.000,00\nTotal descuentos $ 100,00',
    'Total descuentos $ 100,00\nTotal bruto $ 1.000,00'), 1), profile.fingerprint);
  assert.notEqual(fingerprintLayout(`${receipt}\nCódigo Concepto Unidades`, 1),
    fingerprintLayout(`${receipt}\nConcepto Código Unidades`, 1));
  assert.equal(fingerprintLayout('Nombre privado 123 456', 1), null);
  assert.equal(fingerprintLayout(receipt, 0), null);
});

test('approved literal aliases fill only missing fields and retain raw values and normal validators', () => {
  const original = extractArgentinePayroll(receipt, 'PDF_TEXT');
  assert.equal(original.payrollPeriod, null);
  assert.equal(original.basicAmount, null);
  assert.equal(original.needsReview, true);
  const learned = extractArgentinePayroll(receipt, 'PDF_TEXT', aliases);
  assert.equal(learned.payrollPeriod, '2026-08');
  assert.equal(learned.basicAmount, '1000.00');
  assert.equal(learned.fields.find((field) => field.fieldPath === 'settlement.basicAmount')?.rawValue, '$ 1.000,00');
  assert.equal(learned.fields.find((field) => field.fieldPath === 'settlement.payrollPeriod')?.rawValue, '08/2026');
  assert.equal(learned.needsReview, false);
  assert.equal(payrollExtractionNeedsReview(learned), false);
  assert.equal(extractArgentinePayroll(`${receipt}\nSueldo básico $ 1.234,56`, 'PDF_TEXT', aliases).basicAmount, '1234.56');
  const invalidTotals = extractArgentinePayroll(receipt.replace('900,00', '800,00'), 'OCR', aliases);
  assert.equal(invalidTotals.needsReview, true);
  assert.equal(payrollExtractionNeedsReview(invalidTotals), true);
});

test('alias matching rejects invalid configuration, ambiguous amounts, prefixes and unrelated following labels', () => {
  for (const basicAlias of ['Asignación.*', 'Asignación contractual 1', 'https://example.com', 'Asignación\ncontractual']) {
    assert.equal(extractArgentinePayroll(receipt, 'PDF_TEXT', { 'settlement.basicAmount': [basicAlias] }).basicAmount, null);
  }
  for (const replacement of ['Asignación contractual adicional $ 1.000,00', 'Asignación contractual $ 1.000,00 $ 2.000,00',
    'Asignación contractual\nOtro valor $ 1.000,00', 'Asignación contractual $ 1.000,00\nAsignación contractual $ 2.000,00']) {
    assert.equal(extractArgentinePayroll(receipt.replace('Asignación contractual $ 1.000,00', replacement), 'PDF_TEXT', aliases).basicAmount, null);
  }
  assert.equal(extractArgentinePayroll(receipt.replace('Asignación contractual $ 1.000,00', 'Asignación contractual:\n$ 1.000,00'), 'OCR', aliases).basicAmount, '1000.00');
  const badPeriod = extractArgentinePayroll(receipt.replace('08/2026', '13/2026'), 'PDF_TEXT', aliases);
  assert.equal(badPeriod.payrollPeriod, null);
  assert.equal(badPeriod.fields.find((field) => field.fieldPath === 'settlement.payrollPeriod')?.signals?.missingReason, 'VALUE_NOT_INTERPRETABLE');
});

test('unknown label requires review; approval parses next salary locally without provider calls', async () => {
  let calls = 0;
  const fallback = async (): Promise<OCRResult> => { calls++; throw new OCRProviderError('OCR_DISABLED', false); };
  const unknown = await orchestrateExtraction(input(receipt), { fallback, resolveLayout: async () => null });
  assert.equal(unknown.extraction.needsReview, true);
  assert.equal(calls, 1);
  assert.equal(unknown.layout.fingerprint, profile.fingerprint);
  const next = receipt.replaceAll('1.000,00', '2.000,00').replaceAll('100,00', '200,00').replace('900,00', '1.800,00').replace('08/2026', '09/2026');
  const learned = await orchestrateExtraction(input(next), {
    fallback, resolveLayout: async (_text, employerName) => { assert.equal(employerName, 'Empresa Sintética S.A.'); return profile; },
  });
  assert.equal(calls, 1);
  assert.equal(learned.extraction.needsReview, false);
  assert.equal(learned.extraction.basicAmount, '2000.00');
  assert.equal(learned.extraction.payrollPeriod, '2026-09');
  assert.equal(learned.layout.profile?.id, profile.id);
  assert.equal(learned.triggerReason, null);
});

test('profiles are re-resolved after OCR and cannot apply across structural fingerprints', async () => {
  const result: OCRResult = { text: receipt, provider: 'synthetic', model: 'test', providerVersion: '1',
    pages: [{ pageNumber: 1, blocks: [] }], durationMs: 1, retryCount: 0, externalRequestId: 'synthetic' };
  let resolutions = 0;
  const learned = await orchestrateExtraction(input(''), { fallback: async () => result,
    resolveLayout: async () => { resolutions++; return profile; } });
  assert.equal(resolutions, 1);
  assert.equal(learned.extraction.basicAmount, '1000.00');
  assert.equal(learned.layout.profile?.id, profile.id);
  const mismatch = await orchestrateExtraction(input(receipt), {
    resolveLayout: async () => ({ ...profile, fingerprint: 'f'.repeat(64) }),
  });
  assert.equal(mismatch.extraction.basicAmount, null);
  assert.equal(mismatch.layout.profile, null);
});
