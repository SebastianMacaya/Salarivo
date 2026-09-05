import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocumentCountry, detectDocumentCountry } from '../src/document-country.ts';
import { orchestrateExtraction } from '../src/extraction-orchestrator.ts';

const salary = `RECIBO DE SUELDO
Empleador: Empresa Sintética
Período: 08/2026
Sueldo básico $ 1.000,00
Total bruto $ 1.000,00
Total descuentos $ 0,00
Neto a cobrar $ 1.000,00`;

test('country needs document evidence; language, dollar sign and an Argentine parser do not establish it', async () => {
  assert.equal(detectDocumentCountry(salary).countryCode, null);
  assert.equal(detectDocumentCountry('Factura Argentina ARS').countryCode, null);
  assert.equal(detectDocumentCountry(`${salary}\nPaís: ES`).countryCode, 'ES');
  assert.equal(detectDocumentCountry(`${salary}\nPaís: ZZ`).countryCode, null);
  const result = await orchestrateExtraction({ text: salary, source: 'PDF_TEXT', evidence: [] });
  assert.equal(result.country.countryCode, null);
  assert.deepEqual(result.issues, ['COUNTRY_UNCONFIRMED']);
  assert.equal(result.extraction.grossAmount, '1000.00');
  for (const evidence of ['Moneda ARS', 'País: Argentina', 'CUIT: 30-00000000-7']) {
    assert.equal(detectDocumentCountry(`${salary}\n${evidence}`).countryCode, 'AR');
  }
});

test('confirmed employment takes precedence and contradictions remain reviewable without changing history', () => {
  const snapshot = { countryCode: 'AR', source: 'DOCUMENT_DETECTION' as const, confidence: 'MEDIUM' as const };
  const context = { confirmedEmploymentCountryCode: 'US', snapshot };
  const country = classifyDocumentCountry(`${salary}\nMoneda ARS`, context);
  assert.equal(country.countryCode, 'US');
  assert.equal(country.detectedCountryCode, 'AR');
  assert.deepEqual(country.issues, ['COUNTRY_EMPLOYMENT_CONFLICT', 'COUNTRY_SNAPSHOT_CONFLICT', 'COUNTRY_NOT_SUPPORTED']);
  assert.equal(snapshot.countryCode, 'AR');
  assert.deepEqual(classifyDocumentCountry(salary, { confirmedEmploymentCountryCode: 'AR' }).issues, []);
});

test('a foreign employment never invokes Argentine layouts, the salary parser or external OCR', async () => {
  let resolutions = 0;
  let calls = 0;
  const outcome = await orchestrateExtraction({ text: `${salary}\nARS`, source: 'PDF_TEXT', evidence: [] }, {
    countryContext: { confirmedEmploymentCountryCode: 'US' },
    resolveLayout: async () => { resolutions++; return null; },
    fallback: async () => { calls++; throw new Error('unexpected OCR'); },
  });
  assert.equal(calls, 0);
  assert.equal(resolutions, 0);
  assert.equal(outcome.extraction.grossAmount, null);
  assert.equal(outcome.layout.fingerprint, null);
  assert.deepEqual(outcome.issues, ['COUNTRY_EMPLOYMENT_CONFLICT', 'COUNTRY_NOT_SUPPORTED']);
  const foreignReceipt = await orchestrateExtraction({ text: `${salary}\nPaís: ES`, source: 'PDF_TEXT', evidence: [] }, {
    countryContext: { confirmedEmploymentCountryCode: 'AR' },
  });
  assert.equal(foreignReceipt.extraction.grossAmount, null);
  assert.deepEqual(foreignReceipt.issues, ['COUNTRY_EMPLOYMENT_CONFLICT']);
});

test('country is classified again before templates and parsing after OCR', async () => {
  const outcome = await orchestrateExtraction({ text: '', source: 'PDF_TEXT', evidence: [] }, {
    fallback: async () => ({ text: `${salary}\nARS`, pages: [{ pageNumber: 1, blocks: [] }], provider: 'synthetic',
      model: 'synthetic', providerVersion: '1', externalRequestId: 'synthetic', durationMs: 1, retryCount: 0 }),
    resolveLayout: async (_text, _employer, countryCode) => { assert.equal(countryCode, 'AR'); return null; },
  });
  assert.equal(outcome.country.countryCode, 'AR');
  assert.equal(outcome.extraction.netAmount, '1000.00');
  assert.deepEqual(outcome.issues, []);
});

test('explicit owner country correction overrides detection but cannot override a conflicting confirmed employment', async () => {
  const snapshot = { countryCode: 'AR', source: 'USER_CONFIRMED' as const, confidence: 'HIGH' as const };
  const text = `${salary}\nPaís: ES`;
  const corrected = await orchestrateExtraction({text,source:'PDF_TEXT',evidence:[]},
    {countryContext:{snapshot,confirmedEmploymentCountryCode:'AR'}});
  assert.deepEqual(corrected.country.issues, []);
  assert.equal(corrected.country.source,'USER_CONFIRMED');
  assert.equal(corrected.country.detectedCountryCode,'ES');
  assert.equal(corrected.extraction.netAmount,'1000.00');
  const conflict = classifyDocumentCountry(text,{snapshot,confirmedEmploymentCountryCode:'US'});
  assert.deepEqual(conflict.issues,['COUNTRY_EMPLOYMENT_CONFLICT','COUNTRY_SNAPSHOT_CONFLICT','COUNTRY_NOT_SUPPORTED']);
  assert.equal(conflict.countryCode,'US');
});
