import assert from 'node:assert/strict';
import { loadOcrConfig } from '../src/environment.ts';
import { estimateOcrCostUsd, OCRProviderError } from '../src/ocr-provider.ts';
import { ZaiGlmOcrProvider } from '../src/zai-ocr-provider.ts';

// Fixed synthetic input only: this script never accepts a user document or filename.
const content = 'BT /F1 18 Tf 50 740 Td (SYNTHETIC OCR TEST) Tj 0 -32 Td (RECIBO DE SUELDO - EMPRESA SINTETICA) Tj 0 -32 Td (Periodo: 08/2026) Tj 0 -32 Td (Neto a cobrar: $ 100.000,00) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
// The live endpoint rejects the otherwise valid 718-byte minimal PDF; use a realistic-sized fixture.
let pdf = `%PDF-1.4\n% ${'SYNTHETIC '.repeat(128)}\n`;
const offsets: number[] = [];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const startXref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

try {
  if (process.env.CI || process.env.NODE_TEST_CONTEXT) throw new OCRProviderError('OCR_LIVE_SMOKE_FORBIDDEN_IN_AUTOMATION');
  const config = loadOcrConfig({ ...process.env, OCR_ENABLED: 'true', OCR_PROVIDER: 'zai', ZAI_OCR_MAX_RETRIES: '0' });
  const result = await new ZaiGlmOcrProvider(config).extract({ bytes: Buffer.from(pdf), mimeType: 'application/pdf', pageCount: 1 });
  assert.match(result.text, /SYNTHETIC|SINTETICA/i);
  process.stdout.write(`${JSON.stringify({
    event: 'synthetic_ocr_smoke_passed', provider: result.provider, model: result.model,
    pages: result.pages.length, usage: result.usage ?? null,
    estimatedCostUsd: estimateOcrCostUsd(result.usage, config), durationMs: result.durationMs,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: 'synthetic_ocr_smoke_failed', code: error instanceof OCRProviderError ? error.code : 'OCR_SMOKE_FAILED' })}\n`);
  process.exitCode = 1;
}
