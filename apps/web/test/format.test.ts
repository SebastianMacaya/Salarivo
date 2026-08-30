import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractionSourceLabel,
  money,
  percentage,
  periodLabel,
  recentPeriodRange,
  settlementTypeLabel,
} from '../app/format.ts';

test('formatea dinero sin perder precisión decimal', () => {
  assert.equal(money('123456789012345678.90'), 'ARS 123.456.789.012.345.678,90');
  assert.equal(money('-0.5', 'USD'), 'USD -0,50');
  assert.equal(percentage('12.34'), '12,34%');
  assert.equal(percentage(null), '—');
});

test('formatea períodos válidos en español', () => {
  assert.equal(periodLabel('2026-02'), 'Febrero 2026');
  assert.equal(periodLabel('2026-02-28'), 'Febrero 2026');
  assert.equal(periodLabel('2026-02-30'), '—');
  assert.equal(periodLabel(null), '—');
});

test('los rangos temporales usan meses calendario aunque falten recibos', () => {
  const points = [{ period: '2025-01' }, { period: '2025-12' }, { period: '2026-01' }];
  assert.deepEqual(recentPeriodRange(points, 6), points.slice(1));
  assert.equal(recentPeriodRange(points), points);
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
});
