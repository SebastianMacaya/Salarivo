import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOcrConfig, runtimeEnvironment } from '../src/environment.ts';

test('production Node runtime cannot fall back to development defaults', () => {
  assert.equal(runtimeEnvironment({ NODE_ENV: 'production' }), 'production');
  assert.equal(runtimeEnvironment({ NODE_ENV: 'production', APP_ENV: ' production ' }), 'production');
  assert.throws(() => runtimeEnvironment({ NODE_ENV: 'production', APP_ENV: 'test' }), /cannot override/);
  assert.throws(() => runtimeEnvironment({ APP_ENV: 'production', NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /forbidden/);
  assert.throws(() => runtimeEnvironment({ APP_ENV: 'preview' }), /APP_ENV/);
});

test('OCR configuration keeps local compatibility and validates enabled external credentials and limits', () => {
  assert.equal(loadOcrConfig({}).provider, 'tesseract');
  assert.equal(loadOcrConfig({}).enabled, true);
  assert.equal(loadOcrConfig({ OCR_ENABLED: 'false', OCR_PROVIDER: 'zai' }).enabled, false);
  assert.equal(loadOcrConfig({ OCR_PROVIDER: 'disabled' }).enabled, false);
  assert.throws(() => loadOcrConfig({ OCR_PROVIDER: 'zai' }), /ZAI_API_KEY/);
  assert.equal(loadOcrConfig({ APP_ENV: 'production', OCR_PROVIDER: 'zai', ZAI_API_KEY: 'synthetic' }).enabled, true);
  for (const [key, value] of [
    ['OCR_ENABLED', 'yes'], ['OCR_PROVIDER', 'imaginary'], ['ZAI_API_KEY', 'synthetic\ninvalid'],
    ['ZAI_BASE_URL', 'https://api.z.ai/api/coding/paas/v4'], ['ZAI_BASE_URL', 'https://untrusted.invalid'],
    ['ZAI_OCR_MODEL', 'semantic-llm'], ['ZAI_OCR_MAX_RETRIES', '3'], ['ZAI_OCR_MAX_CONCURRENCY', '0'],
    ['ZAI_OCR_MAX_PDF_PAGES', '31'], ['ZAI_OCR_MAX_FILE_BYTES', '50000001'], ['ZAI_OCR_TIMEOUT_MS', 'Infinity'],
    ['ZAI_OCR_DAILY_BUDGET_USD', '0'], ['ZAI_OCR_MONTHLY_BUDGET_USD', '-1'], ['ZAI_OCR_RESERVATION_USD', '1e-2'],
  ]) assert.throws(() => loadOcrConfig({ [key!]: value }), Error);
  assert.equal(loadOcrConfig({ ZAI_OCR_DAILY_BUDGET_USD: '1.5' }).dailyBudgetUsd, '1.50000000');
});
