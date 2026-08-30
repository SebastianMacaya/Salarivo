import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPayrollText,
  extractArgentinePayroll,
  hasPdfMagic,
  parseArgentineAmount,
  parseJobMessage,
  pendingUploadCutoff,
  selectDispatchCandidates,
  uploadCleanupStatus,
  validatePdfInfo,
  validateRenderPixels,
} from '../src/engine.ts';

const syntheticReceipt = `
RECIBO DE SUELDO
Empleador: Empresa-Sintética S.A.
CUIL: 20-00000000-0
Período de liquidación: 08/2026
Sueldo básico                         $ 1.234.567,89
Presentismo                             $ 123.456,78
Jubilación                              $ 135.802,47
Obra social                              $ 37.037,04
Total bruto                           $ 1.358.024,67
Total descuentos                        $ 172.839,51
Neto a cobrar                         $ 1.185.185,16
`;

test('valida magic bytes y estructura acotada', () => {
  assert.equal(hasPdfMagic(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(hasPdfMagic(Buffer.from('MZ executable')), false);
  assert.deepEqual(validatePdfInfo('Pages:          2\nEncrypted:      no\n', 20), { pages: 2 });
  assert.deepEqual(validatePdfInfo('Pages:          21\nEncrypted:      no\n', 20), { errorCode: 'DOCUMENT_TOO_MANY_PAGES' });
  assert.deepEqual(validatePdfInfo('Pages:          2\nEncrypted:      yes\n', 20), { errorCode: 'DOCUMENT_ENCRYPTED' });
  assert.equal(validateRenderPixels('Page size:      595 x 842 pts\n', 144, 10_000_000), true);
  assert.equal(validateRenderPixels('Page size:      100000 x 100000 pts\n', 144, 10_000_000), false);
});

test('la cola acepta exclusivamente un jobId interno', () => {
  const id = '3a626c65-d2f4-4af5-b827-6fd6459a3f72';
  assert.equal(parseJobMessage(JSON.stringify({ jobId: id })), id);
  assert.equal(parseJobMessage(JSON.stringify({ jobId: id, ocr: 'dato sensible' })), null);
  assert.equal(parseJobMessage('{malformado'), null);
});

test('el dispatcher no publica más jobs que los slots globales y por usuario', () => {
  const sameUser = Array.from({ length: 40 }, (_, index) => ({ id: `job-${index}`, userId: 'user-a' }));
  assert.deepEqual(selectDispatchCandidates(sameUser, new Map(), 2, 1), ['job-0']);
  assert.deepEqual(
    selectDispatchCandidates(
      [{ id: 'job-a', userId: 'user-a' }, { id: 'job-b', userId: 'user-b' }],
      new Map([['user-a', 1]]),
      2,
      1,
    ),
    ['job-b'],
  );
});

test('cleanup conserva la referencia durante la gracia y acota lotes sin upload', () => {
  const expiresAt = Date.UTC(2026, 7, 27, 12);
  const uploadTtl = 5 * 60 * 1_000;
  const grace = 15 * 60 * 1_000;
  assert.equal(uploadCleanupStatus(expiresAt, expiresAt + grace - 1, grace), 'EXPIRED');
  assert.equal(uploadCleanupStatus(expiresAt, expiresAt + grace, grace), 'CANCELLED');
  assert.equal(uploadCleanupStatus(expiresAt, expiresAt, grace), 'EXPIRED');
  assert.equal(uploadCleanupStatus(expiresAt, expiresAt, grace, true), 'CANCELLED');
  assert.equal(
    pendingUploadCutoff(expiresAt + uploadTtl + grace, uploadTtl, grace).getTime(),
    expiresAt,
  );
});

test('normaliza montos argentinos sin usar punto flotante', () => {
  assert.equal(parseArgentineAmount('$ 1.234.567,89'), '1234567.89');
  assert.equal(parseArgentineAmount('$ 1 234 567,89'), '1234567.89');
  assert.equal(parseArgentineAmount('(12.345,6)'), '-12345.60');
  assert.equal(parseArgentineAmount('1.2.34'), null);
  assert.equal(parseArgentineAmount('(123'), null);
  assert.equal(parseArgentineAmount('1234567890123456789,00'), null);
  assert.equal(parseArgentineAmount('texto'), null);
});

test('clasifica y extrae un recibo completamente sintético', () => {
  const classification = classifyPayrollText(syntheticReceipt);
  assert.equal(classification.decision, 'SUPPORTED');
  assert.ok(classification.confidence >= 0.55);

  const result = extractArgentinePayroll(syntheticReceipt, 'PDF_TEXT');
  assert.equal(result.payrollPeriod, '2026-08');
  assert.equal(result.employerName, 'Empresa-Sintética S.A.');
  assert.equal(result.basicAmount, '1234567.89');
  assert.equal(result.grossAmount, '1358024.67');
  assert.equal(result.netAmount, '1185185.16');
  assert.equal(result.needsReview, false);
  assert.deepEqual(
    result.fields.find(({ fieldPath }) => fieldPath === 'settlement.type'),
    { confidence: 0.8, fieldPath: 'settlement.type', interpretedValue: 'NORMAL', rawValue: 'NORMAL', source: 'RULE' },
  );
  assert.equal(result.lineItems.length, 4);
  assert.equal(result.lineItems.find((item) => item.amount === '135802.47')?.itemType, 'DEDUCTION');
  assert.equal(result.lineItems.some((item) => item.normalizedConceptCode === 'HEALTH_INSURANCE'), false);
  assert.equal(result.lineItems.find((item) => item.amount === '37037.04')?.rawDescription, 'Deducción');
  assert.equal(extractArgentinePayroll(`${syntheticReceipt}\nBono productividad $ 10.000,00`, 'PDF_TEXT').settlementType, 'NORMAL');
  assert.equal(extractArgentinePayroll(`${syntheticReceipt}\nTipo de liquidación: BONO`, 'PDF_TEXT').settlementType, 'BONO');

  const oversizedEmployer = extractArgentinePayroll(`RECIBO DE SUELDO\nEmpresa: ${'A'.repeat(10_000)}\nPeríodo: 08/2026\nTotal bruto $ 1.000,00\nNeto a cobrar $ 900,00`, 'PDF_TEXT');
  const employerField = oversizedEmployer.fields.find(({ fieldPath }) => fieldPath === 'employer.name');
  assert.equal(oversizedEmployer.employerName?.length, 160);
  assert.equal(String(employerField?.rawValue).length, 160);
});

test('extrae totales en filas adyacentes y acepta etiquetas habituales', () => {
  const receipt = `
RECIBO DE HABERES
Período: julio 2026
Salario básico
  $ 1.000.000,00
Total de remuneraciones
  $ 1.250.000,00
Total de deducciones
  $ 250.000,00
Líquido a percibir
  UN MILLÓN CON 00/100                 $ 1.000.000,00
`;
  const result = extractArgentinePayroll(receipt, 'PDF_TEXT');

  assert.equal(classifyPayrollText(receipt).decision, 'SUPPORTED');
  assert.equal(result.basicAmount, '1000000.00');
  assert.equal(result.grossAmount, '1250000.00');
  assert.equal(result.deductionsAmount, '250000.00');
  assert.equal(result.netAmount, '1000000.00');
  assert.equal(result.needsReview, true);
});

test('manda a revisión un desglose que no coincide con el total', () => {
  const result = extractArgentinePayroll(`
RECIBO DE SUELDO
Período: 08/2026
Jubilación $ 100,00
Total bruto $ 1.000,00
Total descuentos $ 150,00
Neto a cobrar $ 850,00
`, 'PDF_TEXT');
  assert.equal(result.needsReview, true);
});

test('deriva el bruto sólo para la tabla salarial reconocida', () => {
  const tableReceipt = `
RECIBO DE SUELDO
Período: 07/2026
Haberes con             Haberes sin
Conceptos del período
                                                Descuentos              Contrib./Otros
Conceptos sintéticos intermedios
Totales  1.200.000,00   50.000,00                250.000,00             400.000,00
Neto a Cobrar
UN MILLÓN CON 00/100                                      $ 1.000.000,00
Contribución Jubilación                                  $ 120.000,00
`;
  const result = extractArgentinePayroll(tableReceipt, 'PDF_TEXT');

  assert.equal(result.grossAmount, '1250000.00');
  assert.equal(result.remunerativeAmount, '1200000.00');
  assert.equal(result.nonRemunerativeAmount, '50000.00');
  assert.equal(result.deductionsAmount, '250000.00');
  assert.equal(result.netAmount, '1000000.00');
  assert.equal(result.needsReview, true);
  assert.equal(result.fields.find(({ fieldPath }) => fieldPath === 'settlement.grossAmount')?.source, 'RULE');
  assert.deepEqual(
    result.fields.find(({ fieldPath }) => fieldPath === 'settlement.remunerativeAmount'),
    { confidence: 0.84, fieldPath: 'settlement.remunerativeAmount', interpretedValue: { amount: '1200000.00', currencyCode: 'ARS' }, rawValue: '1.200.000,00', source: 'PDF_TEXT' },
  );
  assert.deepEqual(
    result.fields.find(({ fieldPath }) => fieldPath === 'settlement.nonRemunerativeAmount'),
    { confidence: 0.84, fieldPath: 'settlement.nonRemunerativeAmount', interpretedValue: { amount: '50000.00', currencyCode: 'ARS' }, rawValue: '50.000,00', source: 'PDF_TEXT' },
  );
  assert.equal(result.lineItems.some(({ normalizedConceptCode }) => normalizedConceptCode === 'RETIREMENT'), false);

  const unknownTable = extractArgentinePayroll(`RECIBO DE SUELDO\nPeríodo: 07/2026\nTotales 1.200.000,00 50.000,00 250.000,00 400.000,00\nNeto a cobrar $ 1.000.000,00`, 'PDF_TEXT');
  assert.equal(unknownTable.grossAmount, null);
  assert.equal(unknownTable.remunerativeAmount, null);
  assert.equal(unknownTable.nonRemunerativeAmount, null);
  assert.equal(
    unknownTable.fields.find(({ fieldPath }) => fieldPath === 'settlement.remunerativeAmount')?.signals?.missingReason,
    'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
  );
  assert.equal(unknownTable.needsReview, true);

  const threeColumns = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nRemunerativos  No remunerativos  Retenciones\nTotal 1.200.000,00 50.000,00 250.000,00\nNeto a pagar $ 1.000.000,00`, 'PDF_TEXT');
  assert.equal(threeColumns.grossAmount, '1250000.00');
  assert.equal(threeColumns.remunerativeAmount, '1200000.00');
  assert.equal(threeColumns.nonRemunerativeAmount, '50000.00');
  assert.equal(threeColumns.deductionsAmount, '250000.00');

  const pageNumber = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nTotal bruto $ 1.000.000,00\nNeto a cobrar\nPágina 1`, 'PDF_TEXT');
  assert.equal(pageNumber.netAmount, null);

  const malformedTotal = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nTotal bruto 1.2.34\nNeto a cobrar $ 1.000,00`, 'PDF_TEXT');
  assert.equal(malformedTotal.grossAmount, null);
  assert.equal(
    malformedTotal.fields.find(({ fieldPath }) => fieldPath === 'settlement.grossAmount')?.signals?.missingReason,
    'VALUE_NOT_INTERPRETABLE',
  );
  assert.equal(malformedTotal.fields.find(({ fieldPath }) => fieldPath === 'settlement.basicAmount')?.signals?.missingReason, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED');
  assert.equal(malformedTotal.fields.find(({ fieldPath }) => fieldPath === 'employer.name')?.signals?.missingReason, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED');

  const malformedPeriod = extractArgentinePayroll('RECIBO DE HABERES\nPeríodo: desconocido', 'PDF_TEXT');
  assert.equal(malformedPeriod.fields.find(({ fieldPath }) => fieldPath === 'settlement.payrollPeriod')?.signals?.missingReason, 'VALUE_NOT_INTERPRETABLE');

  const adjacentLabel = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nTotal bruto\nTotal descuentos $ 250.000,00\nNeto a cobrar $ 1.000.000,00`, 'PDF_TEXT');
  assert.equal(adjacentLabel.grossAmount, null);
  assert.equal(adjacentLabel.deductionsAmount, '250000.00');

  const identifierSuffix = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nTotal bruto CUIT20-12345678-9,00\nNeto a cobrar ABC123,45`, 'PDF_TEXT');
  assert.equal(identifierSuffix.grossAmount, null);
  assert.equal(identifierSuffix.netAmount, null);

  const overflowHeader = 'Remunerativos'.padEnd(40) + 'No remunerativos'.padEnd(30) + 'Retenciones';
  const maximumTotals = 'Total 999.999.999.999.999.998,99'.padEnd(40) + '0,01'.padEnd(30) + '1,00';
  const maximum = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\n${overflowHeader}\n${maximumTotals}\nNeto a pagar $ 1,00`, 'PDF_TEXT');
  assert.equal(maximum.grossAmount, '999999999999999999.00');
  const overflowTotals = 'Total 999.999.999.999.999.999,99'.padEnd(40) + '0,01'.padEnd(30) + '1,00';
  const overflow = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\n${overflowHeader}\n${overflowTotals}\nNeto a pagar $ 1,00`, 'PDF_TEXT');
  assert.equal(overflow.grossAmount, null);

  const shifted = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nRemunerativos  No remunerativos  Retenciones\nTotal                                              1.000,00 200,00 100,00\nNeto a pagar $ 1.100,00`, 'PDF_TEXT');
  assert.equal(shifted.grossAmount, null);
  assert.equal(
    shifted.fields.find(({ fieldPath }) => fieldPath === 'settlement.grossAmount')?.signals?.missingReason,
    'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
  );

  const ambiguous = extractArgentinePayroll(`RECIBO DE HABERES\nPeríodo: 07/2026\nTotal bruto $ 1.000.000,00 $ 100.000,00 $ 200.000,00\nNeto a cobrar $ 800.000,00`, 'PDF_TEXT');
  assert.equal(ambiguous.grossAmount, null);
  assert.equal(ambiguous.needsReview, true);
});

test('lee tablas alineadas a derecha y deriva el neto sólo con evidencia suficiente', () => {
  const header = `${' '.repeat(10)}Haberes con${' '.repeat(41)}Haberes sin`;
  const deductionHeader = `${' '.repeat(75)}Descuentos`;
  const totals = `${'Totales'.padEnd(48)}1.200.000,00  50.000,00 250.000,00`;
  const deduction = `${'Jubilación'.padEnd(72)}250.000,00`;
  const receipt = [
    'RECIBO DE HABERES',
    'Período: 08/2026',
    header,
    deductionHeader,
    deduction,
    totals,
    'SON PESOS UN MILLÓN NETO A',
  ].join('\n');
  const result = extractArgentinePayroll(receipt, 'PDF_TEXT');

  assert.equal(result.grossAmount, '1250000.00');
  assert.equal(result.deductionsAmount, '250000.00');
  assert.equal(result.netAmount, '1000000.00');
  assert.equal(result.needsReview, false);
  assert.equal(result.fields.find(({ fieldPath }) => fieldPath === 'settlement.netAmount')?.source, 'RULE');

  const withoutNetEvidence = extractArgentinePayroll(receipt.replace('\nSON PESOS UN MILLÓN NETO A', ''), 'PDF_TEXT');
  assert.equal(withoutNetEvidence.netAmount, null);
  assert.equal(withoutNetEvidence.needsReview, true);
  assert.equal(
    withoutNetEvidence.fields.find(({ fieldPath }) => fieldPath === 'settlement.netAmount')?.signals?.missingReason,
    'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
  );

  const signed = extractArgentinePayroll(
    receipt.replace('  50.000,00', ' -50.000,00').replace('UN MILLÓN', 'NOVECIENTOS MIL'),
    'PDF_TEXT',
  );
  assert.equal(signed.grossAmount, '1150000.00');
  assert.equal(signed.netAmount, '900000.00');
  assert.equal(signed.needsReview, false);
});

test('separa descuentos del empleado de contribuciones y minimiza cada deducción', () => {
  const row = (description: string, remunerative = '', nonRemunerative = '', deduction = '', contribution = '') =>
    `${description.padEnd(50)}${remunerative.padEnd(20)}${nonRemunerative.padEnd(20)}${deduction.padEnd(20)}${contribution}`;
  const receipt = [
    'RECIBO DE HABERES',
    'Período: 07/2026',
    'Empresa Sintética S.A.',
    'CUIT: 30-00000000-0',
    row('', 'Haberes con', 'Haberes sin', 'Descuentos', 'Contribuciones'),
    row('1000 Sueldo básico', '1.200.000,00'),
    row('2000 Jubilación 11%', '1.000.000,00', '', '110.000,00', '180.000,00'),
    row('2001 Jubilación patronal', '1.000.000,00', '', '', '180.000,00'),
    row('2002 Ley 19.032', '1.000.000,00', '', '30.000,00', '50.000,00'),
    row('2003 Obra social', '1.000.000,00', '', '40.000,00', '60.000,00'),
    row('2004 Imp. a los Ingresos Personales', '1.000.000,00', '', '50.000,00'),
    row('2999 Seguro colectivo', '1.000.000,00', '', '20.000,00'),
    row('Totales', '1.200.000,00', '50.000,00', '250.000,00', '470.000,00'),
    'Neto a cobrar $ 1.000.000,00',
  ].join('\n');
  const result = extractArgentinePayroll(receipt, 'PDF_TEXT');
  const deductions = result.lineItems.filter(({ itemType }) => itemType === 'DEDUCTION');

  assert.equal(result.employerName, 'Empresa Sintética S.A.');
  assert.equal(result.grossAmount, '1250000.00');
  assert.equal(result.deductionsAmount, '250000.00');
  assert.equal(deductions.length, 5);
  assert.ok(deductions.every(({ normalizedConceptCode, rawDescription, isRecurring }) =>
    normalizedConceptCode === null && rawDescription === 'Deducción' && isRecurring === null));
  assert.equal(deductions.some(({ amount }) => amount === '180000.00'), false);

  const narrowRow = (description: string, remunerative = '', nonRemunerative = '', deduction = '') =>
    `${description.padEnd(28)}${remunerative.padEnd(17)}${nonRemunerative.padEnd(17)}${deduction}`;
  const narrow = extractArgentinePayroll([
    'RECIBO DE HABERES',
    'Período: 07/2026',
    narrowRow('', 'Haberes con', 'Haberes sin', 'Descuentos'),
    narrowRow('2000 Jubilación', '', '', '110.000,00'),
    narrowRow('Totales', '1.000.000,00', '0,00', '110.000,00'),
    'Neto a cobrar $ 890.000,00',
  ].join('\n'), 'PDF_TEXT');
  assert.deepEqual(
    narrow.lineItems.find(({ itemType }) => itemType === 'DEDUCTION'),
    { amount: '110000.00', confidence: 0.86, isRecurring: null, itemType: 'DEDUCTION', normalizedConceptCode: null, rawDescription: 'Deducción' },
  );
});

test('preserva haberes desconocidos y normaliza extraordinarios sin cambiar una liquidación normal', () => {
  const row = (description: string, remunerative = '', nonRemunerative = '', deduction = '') =>
    `${description.padEnd(38)}${remunerative.padEnd(20)}${nonRemunerative.padEnd(20)}${deduction}`;
  const receipt = [
    'RECIBO DE HABERES',
    'Período: 08/2026',
    row('Concepto', 'Remunerativos', 'No remunerativos', 'Descuentos'),
    row('9000 Adicional\u0000 sintético', '100.000,00'),
    row('9001 Aguinaldo', '', '20.000,00'),
    row('9002 Retroactivo', '10.000,00'),
    row('9003 Vacaciones', '10.000,00'),
    row('9004 Premio', '10.000,00'),
    row('9005 Comisión', '10.000,00'),
    row('9006 Horas extra', '10.000,00'),
    row('9007 Reintegro', '', '10.000,00'),
    row('9008 Ajuste sintético', '-5.000,00'),
    row('9100 Obra social Plan Sintético', '', '', '10.000,00'),
    row('Totales', '145.000,00', '30.000,00', '10.000,00'),
    'Neto a cobrar $ 165.000,00',
  ].join('\n');
  const result = extractArgentinePayroll(receipt, 'PDF_TEXT');
  const unknown = result.lineItems.find(({ rawDescription }) => rawDescription === '9000 Adicional sintético');

  assert.equal(result.settlementType, 'NORMAL');
  assert.deepEqual(unknown, {
    amount: '100000.00',
    confidence: 0.86,
    isRecurring: null,
    itemType: 'EARNING',
    normalizedConceptCode: null,
    rawDescription: '9000 Adicional sintético',
  });
  assert.equal(result.lineItems.find(({ rawDescription }) => rawDescription === '9008 Ajuste sintético')?.amount, '-5000.00');
  assert.deepEqual(
    result.lineItems.filter(({ itemType, normalizedConceptCode }) => itemType === 'EARNING' && normalizedConceptCode)
      .map(({ normalizedConceptCode, isRecurring }) => [normalizedConceptCode, isRecurring]),
    [
      ['SAC', false],
      ['RETROACTIVE', false],
      ['VACATION', false],
      ['BONUS', false],
      ['COMMISSION', false],
      ['OVERTIME', false],
      ['REIMBURSEMENT', false],
    ],
  );
  assert.deepEqual(result.lineItems.find(({ itemType }) => itemType === 'DEDUCTION'), {
    amount: '10000.00',
    confidence: 0.86,
    isRecurring: null,
    itemType: 'DEDUCTION',
    normalizedConceptCode: null,
    rawDescription: 'Deducción',
  });
  assert.equal(/obra social|plan sintetico/i.test(JSON.stringify(result.lineItems)), false);
  assert.equal(extractArgentinePayroll(`${receipt}\nTipo de liquidación: REINTEGRO`, 'PDF_TEXT').settlementType, 'REINTEGRO');
  assert.equal(extractArgentinePayroll(`${receipt}\nTipo de liquidación: AJUSTE A FAVOR`, 'PDF_TEXT').settlementType, 'REINTEGRO');
  assert.equal(extractArgentinePayroll(`${receipt}\nTipo de liquidación: DEVOLUCIÓN`, 'PDF_TEXT').settlementType, 'REINTEGRO');
  assert.equal(extractArgentinePayroll(`${receipt}\nTipo de liquidación: CRÉDITO`, 'PDF_TEXT').settlementType, 'REINTEGRO');

  const collisions = extractArgentinePayroll([
    'RECIBO DE HABERES',
    'Período: 08/2026',
    row('Concepto', 'Remunerativos', 'No remunerativos', 'Descuentos'),
    row('SAC sueldo básico', '10.000,00'),
    row('Retroactivo sueldo básico', '10.000,00'),
    row('Premio presentismo', '10.000,00'),
    row('Antigüedad s/ sueldo básico', '2.000,00'),
    row('Presentismo s/ sueldo básico', '3.000,00'),
    row('1000 Sueldo básico', '20.000,00'),
    row('Crédito devolución', '', '', '-5.000,00'),
    row('Totales', '55.000,00', '0,00', '-5.000,00'),
    'Neto a cobrar $ 60.000,00',
  ].join('\n'), 'PDF_TEXT');
  assert.deepEqual(
    collisions.lineItems.map(({ normalizedConceptCode, isRecurring, itemType, amount, rawDescription }) =>
      ({ normalizedConceptCode, isRecurring, itemType, amount, rawDescription })),
    [
      { normalizedConceptCode: 'SAC', isRecurring: false, itemType: 'EARNING', amount: '10000.00', rawDescription: 'SAC sueldo básico' },
      { normalizedConceptCode: 'RETROACTIVE', isRecurring: false, itemType: 'EARNING', amount: '10000.00', rawDescription: 'Retroactivo sueldo básico' },
      { normalizedConceptCode: 'BONUS', isRecurring: false, itemType: 'EARNING', amount: '10000.00', rawDescription: 'Premio presentismo' },
      { normalizedConceptCode: 'SENIORITY', isRecurring: true, itemType: 'EARNING', amount: '2000.00', rawDescription: 'Antigüedad s/ sueldo básico' },
      { normalizedConceptCode: 'ATTENDANCE', isRecurring: true, itemType: 'EARNING', amount: '3000.00', rawDescription: 'Presentismo s/ sueldo básico' },
      { normalizedConceptCode: 'BASIC_SALARY', isRecurring: true, itemType: 'EARNING', amount: '20000.00', rawDescription: '1000 Sueldo básico' },
      { normalizedConceptCode: null, isRecurring: null, itemType: 'DEDUCTION', amount: '-5000.00', rawDescription: 'Deducción' },
    ],
  );
  assert.equal(collisions.basicAmount, '20000.00');
  assert.equal(collisions.needsReview, false);
});

test('minimiza afiliación sindical, salud y cualquier deducción tabular', () => {
  const result = extractArgentinePayroll(`
RECIBO DE SUELDO
Período: 08/2026
Cuota sindical Sindicato Sintético $ 10.000,00
Obra social Plan Sintético $ 20.000,00
Total bruto $ 100.000,00
Total descuentos $ 30.000,00
Neto a cobrar $ 70.000,00
`, 'PDF_TEXT');
  const deductions = result.lineItems.filter(({ itemType }) => itemType === 'DEDUCTION');
  assert.deepEqual(deductions.map(({ normalizedConceptCode, rawDescription }) => ({ normalizedConceptCode, rawDescription })), [
    { normalizedConceptCode: null, rawDescription: 'Deducción' },
    { normalizedConceptCode: null, rawDescription: 'Deducción' },
  ]);
  assert.equal(JSON.stringify(deductions).match(/sindicat|obra social|health_insurance|union_dues/gi), null);

  const ambiguous = extractArgentinePayroll('RECIBO DE SUELDO\nPeríodo: 08/2026\nPremio obra social $ 10.000,00\nTotal bruto $ 100.000,00\nTotal descuentos $ 10.000,00\nNeto a cobrar $ 90.000,00', 'PDF_TEXT');
  assert.deepEqual(ambiguous.lineItems[0], {
    amount: '10000.00', confidence: 0.84, isRecurring: null, itemType: 'DEDUCTION',
    normalizedConceptCode: null, rawDescription: 'Deducción',
  });

  const row = (description: string, deduction = '') => `${description.padEnd(50)}${''.padEnd(20)}${''.padEnd(20)}${deduction}`;
  const table = extractArgentinePayroll([
    'RECIBO DE SUELDO',
    'Período: 08/2026',
    row('Concepto') + 'Descuentos',
    row('OSDE Plan 999', '20.000,00'),
    row('UPCN cuota solidaria', '10.000,00'),
    row('Totales', '30.000,00'),
    'Neto a cobrar $ 70.000,00',
  ].join('\n'), 'PDF_TEXT');
  assert.ok(table.lineItems.filter(({ itemType }) => itemType === 'DEDUCTION').every((item) =>
    item.rawDescription === 'Deducción' && item.normalizedConceptCode === null));
  assert.equal(/OSDE|UPCN|solidaria/i.test(JSON.stringify(table.lineItems)), false);
});

test('rechaza texto comercial sin señales salariales', () => {
  assert.equal(classifyPayrollText('FACTURA A\nIVA responsable inscripto\nTotal $ 100,00').decision, 'UNSUPPORTED');
  assert.equal(
    classifyPayrollText('Liquidación de impuesto a las ganancias\nRemuneración bruta\nDescuentos\nEmpleador').decision,
    'UNSUPPORTED',
  );
  assert.equal(
    classifyPayrollText('RECIBO DE HABERES\nSueldo básico\nDescuentos\nNeto\nLiquidación de impuesto a las ganancias').decision,
    'SUPPORTED',
  );
});
