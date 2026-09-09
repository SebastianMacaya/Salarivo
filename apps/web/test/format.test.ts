import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amountFromCents,
  buenosAiresDateTimeIso,
  dateLabel,
  documentStatusLabel,
  economicStatusMessage,
  economicTrendLabel,
  earningLabels,
  employmentMilestones,
  employmentOptionLabel,
  extractionSourceLabel,
  money,
  percentage,
  percentageFromBasisPoints,
  periodLabel,
  recentPeriodRange,
  relevantEvolutionRanges,
  salaryContextForEmployment,
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
  assert.equal(money('123456789012345678.90', 'USD', 'en-US'), 'USD 123,456,789,012,345,678.90');
  assert.equal(money('-0.05', 'BRL', 'pt-BR'), 'BRL -0,05');
});

test('no presenta un empleo sin estado confirmado como actualmente vigente', () => {
  const label = employmentOptionLabel({ employerName: 'Empresa sintética', startDate: '2025-01-01', status: 'UNKNOWN' });
  assert.match(label, /Continuidad sin confirmar/);
  assert.doesNotMatch(label, /actualidad/);
});

test('muestra antigüedad calendario y próximo aniversario sólo con continuidad conocida', () => {
  const employment = { startDate: '2024-11-01', status: 'ACTIVE' };
  assert.deepEqual(employmentMilestones(employment, '2026-09-09'), {
    tenureLabel: '1 año y 10 meses', anniversary: { date: '2026-11-01', years: 2, daysUntil: 53 },
  });
  assert.deepEqual(employmentMilestones({ ...employment, status: 'ENDED', endDate: '2025-12-01' }, '2026-09-09'), {
    tenureLabel: '1 año y 1 mes', anniversary: null,
  });
  assert.equal(employmentMilestones({ ...employment, status: 'UNKNOWN' }, '2026-09-09'), null);
  assert.equal(employmentMilestones({ ...employment, status: 'ENDED' }, '2026-09-09'), null);
  assert.deepEqual(employmentMilestones({ ...employment, endDate: '2025-12-01' }, '2026-09-09'), {
    tenureLabel: '1 año y 1 mes', anniversary: null,
  });
  for (const dates of [
    { startDate: '2026-09-10' }, { startDate: '2026-02-30' }, { startDate: 'invalid' },
    { endDate: '2026-09-10' }, { endDate: '2024-10-31' }, { endDate: '' },
  ]) assert.equal(employmentMilestones({ ...employment, ...dates }, '2026-09-09'), null);
  assert.equal(employmentMilestones(employment, '2026-02-30'), null);
});

test('respeta días, fin de mes, bisiestos y aniversarios de hoy o del año siguiente', () => {
  const active = (startDate: string, today: string) => employmentMilestones({ startDate, status: 'ACTIVE' }, today);
  assert.deepEqual(active('2026-09-09', '2026-09-09'), {
    tenureLabel: '0 días', anniversary: { date: '2027-09-09', years: 1, daysUntil: 365 },
  });
  assert.equal(active('2026-09-08', '2026-09-09')?.tenureLabel, '1 día');
  assert.equal(active('2026-09-01', '2026-09-09')?.tenureLabel, '8 días');
  assert.equal(active('2026-01-31', '2026-02-27')?.tenureLabel, '27 días');
  assert.equal(active('2026-01-31', '2026-02-28')?.tenureLabel, '1 mes');
  assert.equal(active('2026-01-31', '2026-03-30')?.tenureLabel, '1 mes');
  assert.equal(active('2026-01-31', '2026-03-31')?.tenureLabel, '2 meses');
  assert.deepEqual(active('2024-02-29', '2025-02-28'), {
    tenureLabel: '1 año', anniversary: { date: '2025-02-28', years: 1, daysUntil: 0 },
  });
  assert.deepEqual(active('2024-02-29', '2028-02-28'), {
    tenureLabel: '3 años y 11 meses', anniversary: { date: '2028-02-29', years: 4, daysUntil: 1 },
  });
  assert.deepEqual(active('2024-01-01', '2026-12-31'), {
    tenureLabel: '2 años y 11 meses', anniversary: { date: '2027-01-01', years: 3, daysUntil: 1 },
  });
  assert.deepEqual(active('2024-11-01', '2026-11-01'), {
    tenureLabel: '2 años', anniversary: { date: '2026-11-01', years: 2, daysUntil: 0 },
  });
});

test('la antigüedad por defecto cambia de día en Buenos Aires', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T02:30:00Z') });
  const employment = { startDate: '2024-11-01', status: 'ACTIVE' };
  assert.equal(employmentMilestones(employment)?.anniversary?.daysUntil, 1);
  context.mock.timers.tick(60 * 60 * 1000);
  assert.equal(employmentMilestones(employment)?.anniversary?.daysUntil, 0);
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

test('explica disponibilidad y tendencia económica sin contradecir el estado', () => {
  assert.equal(economicStatusMessage('AVAILABLE', null), 'Cálculo económico disponible.');
  assert.equal(economicStatusMessage('AVAILABLE', 'NOT_CONFIGURED'), 'Cálculo económico disponible.');
  assert.equal(economicStatusMessage('PENDING', 'SYNC_PENDING'), 'Los datos económicos se están sincronizando.');
  assert.equal(economicTrendLabel('125'), 'Mejoró');
  assert.equal(economicTrendLabel('-1'), 'Empeoró');
  assert.equal(economicTrendLabel('0'), 'Sin cambio');
  assert.equal(economicTrendLabel(null), null);
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

test('convierte la vigencia administrativa desde Buenos Aires sin normalizar fechas inválidas', () => {
  assert.equal(buenosAiresDateTimeIso('2026-09-02T10:30'), '2026-09-02T13:30:00.000Z');
  assert.equal(buenosAiresDateTimeIso('2026-02-30T10:30'), null);
  assert.equal(buenosAiresDateTimeIso('invalid'), null);
});

test('distingue episodios laborales y contextos salariales en selectores', () => {
  assert.equal(employmentOptionLabel({
    employerName: 'Empresa sintética', role: 'Analista', startDate: '2024-11-01',
    endDate: null, status: 'ACTIVE', currencyCode: 'ARS',
  }), 'Empresa sintética · Analista · Activo · 1 nov 2024 a actualidad · ARS');
  assert.equal(employmentOptionLabel({
    employerName: 'Empresa favorita', isFavorite: true, startDate: '2024-11-01',
    endDate: null, status: 'ACTIVE', currencyCode: 'ARS',
  }), 'Empresa favorita · Favorita · Puesto sin especificar · Activo · 1 nov 2024 a actualidad · ARS');
  assert.equal(salaryContextOptionLabel({
    employerName: 'Empresa sintética', state: 'CONFIRMED', currencyCode: 'ARS',
    employmentStatus: 'ACTIVE', startDate: '2024-11-01', endDate: null,
    firstPeriod: '2026-06', lastPeriod: '2026-07',
  }), 'Empresa sintética · Confirmado · Activo · 1 nov 2024 a actualidad · ARS');
  assert.equal(salaryContextOptionLabel({
    employerName: 'Empresa favorita', isFavorite: true, state: 'CONFIRMED', currencyCode: 'ARS',
    employmentStatus: 'ENDED', startDate: '2020-01-01', endDate: '2024-11-30',
  }), 'Empresa favorita · Favorita · Confirmado · Finalizado · 1 ene 2020 a 30 nov 2024 · ARS');
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
  assert.equal(salaryContextForEmployment([usd, ars], employmentId), usd);
  assert.equal(salaryContextForEmployment([usd, ars], employmentId, { currencyCode: 'ARS' }), ars);
});

test('muestra tipos y fuentes sin exponer códigos internos', () => {
  assert.equal(earningLabels.UNKNOWN, 'Concepto sin clasificar');
  assert.equal(earningLabels.BASIC_SALARY, 'Sueldo básico');
  assert.equal(earningLabels.REMUNERATIVE_TOTAL, 'Total remunerativo');
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
