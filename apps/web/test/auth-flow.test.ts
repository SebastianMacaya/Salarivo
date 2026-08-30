import assert from 'node:assert/strict';
import test from 'node:test';
import { isMfaEnrollmentFailure, shouldResumeMfaEnrollment } from '../app/auth-flow.ts';

test('conserva la sesión primaria si falla el step-up iniciado para activar MFA', () => {
  assert.equal(isMfaEnrollmentFailure('google-cancelled', true), true);
  assert.equal(isMfaEnrollmentFailure('google-failed', true), true);
  assert.equal(isMfaEnrollmentFailure('invalid-callback', true), true);
  assert.equal(isMfaEnrollmentFailure('google-failed', false), false);
  assert.equal(isMfaEnrollmentFailure('google-success', true), false);
  assert.equal(isMfaEnrollmentFailure('google-step-up', true), false);
});

test('reanuda el alta MFA después del step-up de Google sólo cuando sigue siendo obligatoria', () => {
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'MFA_SETUP_REQUIRED', true), true);
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'MFA_SETUP_REQUIRED', false), false);
  assert.equal(shouldResumeMfaEnrollment('google-step-up', 'AUTHENTICATED', true), false);
  assert.equal(shouldResumeMfaEnrollment('google-success', 'MFA_SETUP_REQUIRED', true), false);
});
