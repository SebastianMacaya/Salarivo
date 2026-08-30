import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldResumeMfaEnrollment } from '../app/auth-flow.ts';

test('reanuda el alta MFA después del step-up de Google sólo cuando sigue siendo obligatoria', () => {
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'MFA_SETUP_REQUIRED', true), true);
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'MFA_SETUP_REQUIRED', false), false);
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'AUTHENTICATED', true), false);
  assert.equal(shouldResumeMfaEnrollment('google-success', 'MFA_SETUP_REQUIRED', true), false);
});
