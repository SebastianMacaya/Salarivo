export const MFA_ENROLLMENT_RESUME_KEY = 'salarivo:mfa-enrollment-resume';

export function shouldResumeMfaEnrollment(authResult: string | null, authState: string, requested: boolean): boolean {
  return requested && authResult === 'google-step-up' && authState === 'MFA_SETUP_REQUIRED';
}
