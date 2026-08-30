import assert from 'node:assert/strict';
import test from 'node:test';
import { money, percentage } from '../app/format.ts';

test('formatea dinero sin perder precisión decimal', () => {
  assert.equal(money('123456789012345678.90'), 'ARS 123.456.789.012.345.678,90');
  assert.equal(money('-0.5', 'USD'), 'USD -0,50');
  assert.equal(percentage('12.34'), '12,34%');
  assert.equal(percentage(null), '—');
});
