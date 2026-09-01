import assert from 'node:assert/strict';
import test from 'node:test';
import { amountFromCents, percentageFromBasisPoints } from '../app/format.ts';
import {
  PRIVACY_MODE_STORAGE_KEY,
  privateMoney,
  privatePercentage,
  privateText,
  privacyChartHeights,
  readPrivacyMode,
  writePrivacyMode,
} from '../app/privacy-mode-state.ts';

test('privacy helpers mask values without retaining the raw amount', () => {
  const amount = '5327075.42';
  const maskedMoney = privateMoney(amount, 'ARS', true);
  const maskedPercentage = privatePercentage('18.75', true);

  assert.equal(maskedMoney, 'ARS ••••••••');
  assert.doesNotMatch(maskedMoney, /5327075|42/);
  assert.equal(maskedPercentage, '••,••%');
  assert.doesNotMatch(maskedPercentage, /18|75/);
  assert.equal(privateMoney('-120.00', 'ARS', true, 'salary', true), 'Crédito ARS ••••••••');
  assert.equal(privateMoney(null, 'ARS', true, 'salary'), 'N/D');
  assert.equal(privateText('recibo-$5327075.42.pdf', true, 'Nombre de archivo oculto'), 'Nombre de archivo oculto');
  const economicAmount = amountFromCents('12345678');
  const economicChange = percentageFromBasisPoints('1875');
  assert.equal(privateMoney(economicAmount, 'USD', true, 'salary'), 'USD ••••••••');
  assert.equal(privatePercentage(economicChange, true), '••,••%');
  assert.equal(privatePercentage(economicChange, false), '18,75%');
  assert.equal(privateText('Mejoró', true, 'Resultado oculto'), 'Resultado oculto');
  assert.doesNotMatch(`${privateMoney(economicAmount, 'USD', true, 'salary')} ${privatePercentage(economicChange, true)}`, /123456|1875|18,75/);
});

test('privacy preference is local, explicit and tolerant of blocked storage', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  writePrivacyMode(storage, true);
  assert.equal(values.get(PRIVACY_MODE_STORAGE_KEY), 'enabled');
  assert.equal(readPrivacyMode(storage), true);
  writePrivacyMode(storage, false);
  assert.equal(readPrivacyMode(storage), false);
  assert.equal(readPrivacyMode({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} }), false);
});

test('privacy chart geometry exposes only coarse rank buckets', () => {
  assert.deepEqual(
    privacyChartHeights(['100.00', '1000.00', null, '500.00', '750.00']),
    ['30%', '96%', '0%', '52%', '74%'],
  );
});
