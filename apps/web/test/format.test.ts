import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amountFromCents,
  dateLabel,
  documentStatusLabel,
  employmentOptionLabel,
  extractionSourceLabel,
  money,
  percentage,
  percentageFromBasisPoints,
  periodLabel,
  recentPeriodRange,
  relevantEvolutionRanges,
  salaryContextIdentityMatches,
  salaryContextOptionLabel,
  salaryContextMatches,
  settlementTypeLabel,
  timestampLabel,
} from '../app/format.ts';

test('formatea dinero sin perder precisión decimal', () => {
  assert.equal(money('123456789012345678.90'), 'ARS 123.456.789.012.345.678,90');
  assert.equal(money('-0.5', 'USD'), 'USD -0,50');
  assert.equal(percentage('12.34'), '12,34%');
  assert.equal(percentage(null), '—');
});

test('convierte centavos y puntos básicos sin pasar por punto flotante', () => {
  assert.equal(amountFromCents('12345678901234567890'), '123456789012345678.90');
  assert.equal(amountFromCents('-5'), '-0.05');
  assert.equal(amountFromCents('-0'), '0.00');
  assert.equal(percentageFromBasisPoints('1234'), '12.34');
  assert.equal(percentageFromBasisPoints('-25'), '-0.25');
  assert.equal(amountFromCents('1.5'), null);
  assert.equal(percentageFromBasisPoints(null), null);
});

test('formatea períodos válidos en español', () => {
  assert.equal(periodLabel('2026-02'), 'Febrero 2026');
  assert.equal(periodLabel('2026-02-28'), 'Febrero 2026');
  assert.equal(periodLabel('2026-02-30'), '—');
  assert.equal(periodLabel(null), '—');
});

test('separa fechas calendario de instantes en Buenos Aires', () => {
  assert.equal(dateLabel('2026-08-31'), '31 ago 2026');
  assert.equal(dateLabel('2026-02-30'), '—');
  assert.equal(timestampLabel('2026-08-31T01:30:00.000Z'), '30 de ago de 2026, 22:30');
  assert.equal(timestampLabel('2026-08-31T03:30:00.000Z'), '31 de ago de 2026, 00:30');
  assert.equal(timestampLabel('2026-08-31'), '—');
  assert.equal(timestampLabel('invalid'), '—');
});

test('distingue episodios laborales y contextos salariales en selectores', () => {
  assert.equal(employmentOptionLabel({
    employerName: 'Empresa sintética', role: 'Analista', startDate: '2024-11-01',
    endDate: null, status: 'ACTIVE', currencyCode: 'ARS',
  }), 'Empresa sintética · Analista · Activo · 1 nov 2024 a actualidad · ARS');
  assert.equal(salaryContextOptionLabel({
    employerName: 'Empresa sintética', state: 'CONFIRMED', currencyCode: 'ARS',
    employmentStatus: 'ACTIVE', startDate: '2024-11-01', endDate: null,
    firstPeriod: '2026-06', lastPeriod: '2026-07',
  }), 'Empresa sintética · Confirmado · Activo · 1 nov 2024 a actualidad · ARS');
  assert.equal(salaryContextOptionLabel({
    employerName: 'Empresa sintética', state: 'DETECTED', currencyCode: 'ARS',
    firstPeriod: '2026-07', lastPeriod: '2026-07',
  }), 'Empresa sintética · Recibos sin asociar · Julio 2026 · ARS');
});

test('los rangos temporales usan meses calendario aunque falten recibos', () => {
  const points = [{ period: '2025-01' }, { period: '2025-12' }, { period: '2026-01' }];
  assert.deepEqual(recentPeriodRange(points, 6), points.slice(1));
  assert.equal(recentPeriodRange(points), points);
  assert.deepEqual(relevantEvolutionRanges(['2026-01', '2026-11']), [6, 'all']);
  assert.deepEqual(relevantEvolutionRanges(['2026-01', '2026-05']), ['all']);
  assert.deepEqual(relevantEvolutionRanges(['2025-01', '2026-01']), [6, 12, 'all']);
});

test('busca contextos por empresa, puesto, estado y período sin depender de tildes', () => {
  const context = {
    employerName: 'Compañía sintética', state: 'CONFIRMED' as const, currencyCode: 'ARS',
    employmentStatus: 'ENDED', startDate: '2020-02-01', endDate: '2024-11-30',
    firstPeriod: '2020-02', lastPeriod: '2024-11',
  };
  assert.equal(salaryContextMatches(context, 'compania analista 2024 finalizado', { role: 'Analista sénior' }), true);
  assert.equal(salaryContextMatches(context, 'noviembre', { role: 'Analista sénior' }), true);
  assert.equal(salaryContextMatches(context, 'actual'), false);
});

test('mantiene separados los contextos de distinta moneda dentro del mismo empleo', () => {
  const employmentId = '00000000-0000-4000-8000-000000000001';
  const ars = { employmentContext: employmentId, employmentId, currencyCode: 'ARS' };
  const usd = { employmentContext: employmentId, employmentId, currencyCode: 'USD' };

  assert.equal(salaryContextIdentityMatches(ars, { employmentId, currencyCode: 'USD' }), false);
  assert.equal(salaryContextIdentityMatches(usd, { employmentId, currencyCode: 'USD' }), true);
  assert.equal(salaryContextIdentityMatches(usd, { employmentId, employmentContext: employmentId, currencyCode: 'USD' }), true);
});

test('muestra tipos y fuentes sin exponer códigos internos', () => {
  assert.equal(settlementTypeLabel('NORMAL'), 'Liquidación normal');
  assert.equal(settlementTypeLabel('SAC'), 'Aguinaldo');
  assert.equal(settlementTypeLabel('LIQUIDACION_FINAL'), 'Liquidación final');
  assert.equal(settlementTypeLabel('REINTEGRO'), 'Reintegro');
  assert.equal(extractionSourceLabel('PDF_TEXT'), 'Texto del PDF');
  assert.equal(extractionSourceLabel('AI_FALLBACK'), 'Asistencia con IA');
  assert.equal(extractionSourceLabel('MANUAL_REQUIRED'), 'Revisión manual necesaria');
  assert.equal(extractionSourceLabel('UNKNOWN'), '—');
  assert.equal(documentStatusLabel('REJECTED_UNSUPPORTED'), 'Tipo no soportado');
  assert.equal(documentStatusLabel('UNKNOWN'), 'Estado desconocido');
});
