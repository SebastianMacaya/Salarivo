import { renderSVG } from 'uqr';

export function mfaQrDataUrl(otpauthUri: string): string {
  return `data:image/svg+xml,${encodeURIComponent(renderSVG(otpauthUri, { border: 4, ecc: 'M' }))}`;
}
