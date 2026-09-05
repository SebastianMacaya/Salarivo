import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('automated tests erase inherited OCR secrets and reject external fetch before reaching the network', () => {
  const bootstrap = new URL('../../../scripts/test-no-external-ocr.mjs', import.meta.url).href;
  const result = execFileSync(process.execPath, ['--import', bootstrap, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.equal(process.env.ZAI_API_KEY, undefined);
    assert.equal(process.env.OCR_PROVIDER, 'tesseract');
    assert.equal(process.env.OCR_ENABLED, 'true');
    process.env.ZAI_API_KEY = 'synthetic-key-added-by-a-test';
    await assert.rejects(fetch('https://api.z.ai/api/paas/v4/layout_parsing'), /EXTERNAL_OCR_FORBIDDEN_IN_TESTS/);
    console.log('isolated');
  `], { env: { ...process.env, ZAI_API_KEY: 'synthetic-inherited-key', OCR_PROVIDER: 'zai' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.trim(), 'isolated');
});

test('manual paid smoke refuses CI and the automated test runner', () => {
  const smoke = new URL('../scripts/ocr-live-smoke.ts', import.meta.url).href;
  for (const environment of [{ CI: 'true', NODE_TEST_CONTEXT: '' }, { CI: '', NODE_TEST_CONTEXT: 'child-v8' }]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = async () => { throw new Error('UNEXPECTED_EXTERNAL_REQUEST'); };
      await import(${JSON.stringify(smoke)});
    `], { env: { ...process.env, ...environment, ZAI_API_KEY: 'synthetic-test-key' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OCR_LIVE_SMOKE_FORBIDDEN_IN_AUTOMATION/);
  }
});
