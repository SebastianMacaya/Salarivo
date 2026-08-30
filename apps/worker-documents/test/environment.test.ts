import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEnvironment } from '../src/environment.ts';

test('production Node runtime cannot fall back to development defaults', () => {
  assert.equal(runtimeEnvironment({ NODE_ENV: 'production' }), 'production');
  assert.equal(runtimeEnvironment({ NODE_ENV: 'production', APP_ENV: ' production ' }), 'production');
  assert.throws(() => runtimeEnvironment({ NODE_ENV: 'production', APP_ENV: 'test' }), /cannot override/);
  assert.throws(() => runtimeEnvironment({ APP_ENV: 'production', NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /forbidden/);
  assert.throws(() => runtimeEnvironment({ APP_ENV: 'preview' }), /APP_ENV/);
});
