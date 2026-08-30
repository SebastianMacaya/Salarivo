import assert from 'node:assert/strict';
import test from 'node:test';
import { mfaQrDataUrl } from '../app/mfa-qr.ts';

test('genera el QR TOTP localmente como una imagen SVG embebida', () => {
  const uri = 'otpauth://totp/Salarivo:test%40example.test?secret=ABCDEFGHIJKLMNOP&issuer=Salarivo';
  const dataUrl = mfaQrDataUrl(uri);
  const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));

  assert.match(dataUrl, /^data:image\/svg\+xml,/);
  assert.match(svg, /^<svg/);
  assert.equal(svg.includes(uri), false);
  assert.notEqual(dataUrl, mfaQrDataUrl(`${uri}2`));
});
