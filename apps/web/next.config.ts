import type { NextConfig } from 'next';

const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL
  ? ` ${new URL(process.env.NEXT_PUBLIC_API_BASE_URL).origin}`
  : process.env.NODE_ENV === 'production' ? '' : ' http://localhost:3001';
const storageOrigin = process.env.NEXT_PUBLIC_STORAGE_ORIGIN
  ? ` ${new URL(process.env.NEXT_PUBLIC_STORAGE_ORIGIN).origin}`
  : process.env.NODE_ENV === 'production' ? '' : ' http://127.0.0.1:9000';
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self'${apiOrigin}${storageOrigin}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' blob: data:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
    ].join('; '),
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default nextConfig;
