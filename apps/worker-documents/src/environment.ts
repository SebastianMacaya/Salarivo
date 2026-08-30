export type RuntimeEnvironment = 'development' | 'test' | 'production';

export function runtimeEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeEnvironment {
  const configured = env.APP_ENV?.trim();
  if (env.NODE_ENV === 'production' && configured && configured !== 'production') {
    throw new Error('APP_ENV cannot override NODE_ENV=production');
  }
  const value = env.NODE_ENV === 'production' ? 'production' : (configured || 'development');
  if (!['development', 'test', 'production'].includes(value)) {
    throw new Error('APP_ENV must be development, test or production');
  }
  if (value === 'production' && env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0') {
    throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden in production');
  }
  return value as RuntimeEnvironment;
}
