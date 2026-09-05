import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOcrConfig } from '../src/environment.ts';
import { DisabledOCRProvider, OCRProviderError, estimateOcrCostUsd, isOCRResult, type OCRDocument } from '../src/ocr-provider.ts';
import { normalizeZaiOcrResponse, zaiDocumentInput, ZaiGlmOcrProvider } from '../src/zai-ocr-provider.ts';

const requestId = 'sal_00000000-0000-4000-8000-000000000001';
const config = () => loadOcrConfig({ APP_ENV: 'test', OCR_PROVIDER: 'zai', ZAI_API_KEY: 'synthetic-test-key' });
const document: OCRDocument = { bytes: Buffer.from('%PDF-1.7\nSynthetic test only'), mimeType: 'application/pdf', pageCount: 1 };
const response = () => ({
  id: 'task_synthetic_1', model: 'GLM-OCR', request_id: requestId,
  md_results: 'Recibo sintetico',
  layout_details: [[
    { index: 0, label: 'text', content: 'Empresa: Empresa Sintetica', bbox_2d: [0.1, 0.1, 0.8, 0.2] },
    { index: 1, label: 'table', content: '<table><tr><td>Neto</td><td>850.000,00</td></tr></table>', bbox_2d: [0.1, 0.3, 0.8, 0.6] },
    { index: 2, label: 'image', content: 'https://provider.invalid/private-image', bbox_2d: [0.1, 0.7, 0.2, 0.8] },
  ]],
  data_info: { num_pages: 1, pages: [{ width: 600, height: 800 }] },
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 10 } },
});
const successFor = (init: RequestInit | undefined): Response => {
  const payload = JSON.parse(String(init?.body)) as { request_id: string };
  return Response.json({ ...response(), request_id: payload.request_id });
};

test('adapter normalizes layout, table text, bounding boxes and usage without provider URLs', () => {
  const result = normalizeZaiOcrResponse(response(), 1, requestId);
  assert.equal(result.provider, 'zai');
  assert.equal(result.text, 'Empresa: Empresa Sintetica\nNeto    850.000,00');
  assert.equal(result.pages[0]?.width, 600);
  assert.deepEqual(result.pages[0]?.blocks[0]?.sourceRegion,
    { version: 1, space: 'PAGE_NORMALIZED', origin: 'TOP_LEFT', x: 0.1, y: 0.1, width: 0.7, height: 0.1 });
  assert.equal(result.pages[0]?.blocks[2]?.content, undefined);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedTokens: 10 });
  assert.equal(isOCRResult(result), true);
  assert.equal(isOCRResult({ ...result, pages: [{ ...result.pages[0], pageNumber: 0 }] }), false);
  assert.equal(isOCRResult(result, 10), false);
  assert.equal(estimateOcrCostUsd(result.usage, config()), '0.00000450');
  assert.equal(estimateOcrCostUsd({ inputTokens: 1, outputTokens: 0 }, config()), '0.00000003');
  assert.equal(estimateOcrCostUsd({ totalTokens: 100 }, config()), null);
  assert.equal(estimateOcrCostUsd({ inputTokens: -1, outputTokens: 2 }, config()), null);
});

test('adapter rejects malformed output, mismatched pages, unsafe boxes, invalid tokens and empty OCR', () => {
  for (const value of [
    null, [], { id: 'task', model: 'other', md_results: 'text' },
    { ...response(), request_id: 'different_request' },
    { ...response(), layout_details: [[{ index: 0, label: 'text', bbox_2d: [10, 10, 2000, 2000] }]] },
    { ...response(), layout_details: [[{ index: 0, label: 'text', bbox_2d: [0.8, 0.1, 0.2, 0.3] }]] },
    { ...response(), data_info: { num_pages: 2 } },
    { ...response(), usage: { prompt_tokens: -1 } },
    { ...response(), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 99 } },
    { ...response(), usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } },
    { id: 'task', model: 'glm-ocr', md_results: '', layout_details: [[]] },
  ]) assert.throws(() => normalizeZaiOcrResponse(value, 1, requestId), /OCR_INVALID_RESPONSE/);
  assert.equal(normalizeZaiOcrResponse({ id: 'task', model: 'glm-ocr', md_results: 'Synthetic plain text' }, 1, requestId).text,
    'Synthetic plain text');
});

test('live API pixel boxes normalize only using verified page dimensions', () => {
  const payload = { ...response(), layout_details: [[{ index: 0, label: 'text', content: 'SYNTHETIC', bbox_2d: [60, 80, 480, 160] }]] };
  assert.deepEqual(normalizeZaiOcrResponse(payload, 1, requestId).pages[0]?.blocks[0]?.sourceRegion,
    { version: 1, space: 'PAGE_NORMALIZED', origin: 'TOP_LEFT', x: 0.1, y: 0.1, width: 0.7, height: 0.1 });
  assert.throws(() => normalizeZaiOcrResponse({ ...payload, data_info: undefined }, 1, requestId), /OCR_INVALID_RESPONSE/);
});

test('only documented PDF, JPEG and PNG inputs pass MIME, magic, byte and page gates', () => {
  assert.match(zaiDocumentInput(document, config()), /^data:application\/pdf;base64,/);
  const png = { ...document, mimeType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
  assert.match(zaiDocumentInput(png, config()), /^data:image\/png;base64,/);
  assert.match(zaiDocumentInput({ ...document, mimeType: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 1]) }, config()), /^data:image\/jpeg;base64,/);
  assert.throws(() => zaiDocumentInput({ ...document, mimeType: 'image/webp' }, config()), /OCR_UNSUPPORTED_FORMAT/);
  assert.throws(() => zaiDocumentInput({ ...document, mimeType: 'image/jpeg' }, config()), /OCR_INVALID_DOCUMENT/);
  assert.throws(() => zaiDocumentInput({ ...document, pageCount: 31 }, config()), /OCR_PAGE_LIMIT/);
  assert.throws(() => zaiDocumentInput({ ...png, pageCount: 2 }, config()), /OCR_PAGE_LIMIT/);
  assert.throws(() => zaiDocumentInput(document, { ...config(), maxFileBytes: 1 }), /OCR_FILE_TOO_LARGE/);
});

test('provider sends minimal base64 payload, rejects redirects, and never retries auth or malformed output', async () => {
  const provider = new ZaiGlmOcrProvider(config(), { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.z.ai/api/paas/v4/layout_parsing');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-test-key');
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['file', 'model', 'need_layout_visualization', 'request_id', 'return_crop_images']);
    assert.equal(payload.return_crop_images, false);
    assert.equal(payload.need_layout_visualization, false);
    return successFor(init);
  } });
  assert.equal((await provider.extract(document, { requestId })).retryCount, 0);
  for (const [status, code] of [[401, 'OCR_AUTH_FAILED'], [403, 'OCR_AUTH_FAILED'], [400, 'OCR_INVALID_DOCUMENT'], [302, 'OCR_REDIRECT_REJECTED'], [200, 'OCR_INVALID_RESPONSE']] as const) {
    let calls = 0;
    const broken = new ZaiGlmOcrProvider(config(), { fetchImpl: async () => {
      calls++;
      return new Response('sensitive external body must never escape', { status });
    } });
    await assert.rejects(broken.extract(document), (error: unknown) => error instanceof OCRProviderError && error.code === code && !error.message.includes('sensitive'));
    assert.equal(calls, 1);
  }
});

test('only transient failures retry with backoff, fresh pseudonymous IDs and bounded attempts', async () => {
  for (const status of [429, 500, 502]) {
    let calls = 0;
    const ids: string[] = [];
    const delays: number[] = [];
    const provider = new ZaiGlmOcrProvider(config(), {
      sleepImpl: async (delay) => { delays.push(delay); },
      fetchImpl: async (_url, init) => {
        ids.push((JSON.parse(String(init?.body)) as { request_id: string }).request_id);
        return ++calls === 1 ? new Response('', { status, headers: { 'retry-after': '1' } }) : successFor(init);
      },
    });
    const result = await provider.extract(document, { requestId });
    assert.equal(result.retryCount, 1);
    assert.equal(calls, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(delays, [1000]);
  }
  let attempts = 0;
  const failed = new ZaiGlmOcrProvider(config(), {
    sleepImpl: async () => undefined,
    fetchImpl: async () => { attempts++; throw new Error('network details and secret'); },
  });
  await assert.rejects(failed.extract(document), (error: unknown) =>
    error instanceof OCRProviderError && error.code === 'OCR_PROVIDER_UNAVAILABLE' && error.retryCount === 1);
  assert.equal(attempts, 2);
});

test('timeouts abort requests, cancellation never retries, response bytes and concurrency are bounded', async () => {
  const timed = new ZaiGlmOcrProvider({ ...config(), timeoutMs: 10, maxRetries: 0 }, {
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('provider timeout body')));
    }),
  });
  await assert.rejects(timed.extract(document), /OCR_TIMEOUT/);
  const oversized = new ZaiGlmOcrProvider({ ...config(), maxResponseBytes: 10 }, { fetchImpl: async () => Response.json(response()) });
  await assert.rejects(oversized.extract(document), /OCR_RESPONSE_TOO_LARGE/);
  const aborter = new AbortController();
  let release!: () => void;
  const pending = new ZaiGlmOcrProvider(config(), {
    fetchImpl: async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      });
      return successFor(init);
    },
  });
  const first = pending.extract(document, { signal: aborter.signal });
  await assert.rejects(pending.extract(document), /OCR_CONCURRENCY_LIMIT/);
  aborter.abort();
  await assert.rejects(first, /OCR_CANCELLED/);
  const second = pending.extract(document);
  release();
  assert.equal((await second).provider, 'zai');
  await assert.rejects(new DisabledOCRProvider().extract(document), /OCR_DISABLED/);
  await assert.rejects(new ZaiGlmOcrProvider({ ...config(), enabled: false }).extract(document), /OCR_DISABLED/);
});
