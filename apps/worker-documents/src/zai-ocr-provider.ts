import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { hasPdfMagic } from './engine.ts';
import {
  MAX_OCR_RETRY_DELAY_MS, OCRProviderError,
  type OCRConfig, type OCRContext, type OCRDocument, type OCRPage,
  type OCRProvider, type OCRResult, type OCRUsage,
} from './ocr-provider.ts';

// Official application API, verified 2026-09-05. Limits are ceilings, never upload permissions.
export const ZAI_OCR_CAPABILITIES = {
  supportedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxPdfBytes: 50_000_000,
  maxImageBytes: 10_000_000,
  maxPdfPages: 30,
  supportsBase64: true,
  supportsUrl: true,
  supportsBoundingBoxes: true,
} as const;

type ProviderOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(): never { throw new OCRProviderError('OCR_INVALID_RESPONSE'); }
const blockTypes: Record<string, OCRPage['blocks'][number]['type']> = { text: 'TEXT', table: 'TABLE', image: 'IMAGE', formula: 'FORMULA' };

export function zaiDocumentInput(document: OCRDocument, config: Pick<OCRConfig, 'maxFileBytes' | 'maxPdfPages'>): string {
  const bytes = Buffer.from(document.bytes.buffer, document.bytes.byteOffset, document.bytes.byteLength);
  const pdf = document.mimeType === 'application/pdf';
  if (!ZAI_OCR_CAPABILITIES.supportedMimeTypes.some((mime) => mime === document.mimeType)) {
    throw new OCRProviderError('OCR_UNSUPPORTED_FORMAT');
  }
  const limit = Math.min(config.maxFileBytes, pdf ? ZAI_OCR_CAPABILITIES.maxPdfBytes : ZAI_OCR_CAPABILITIES.maxImageBytes);
  if (!bytes.length || bytes.length > limit) throw new OCRProviderError('OCR_FILE_TOO_LARGE');
  if (!Number.isSafeInteger(document.pageCount) || document.pageCount < 1
    || (pdf && document.pageCount > Math.min(config.maxPdfPages, ZAI_OCR_CAPABILITIES.maxPdfPages))
    || (!pdf && document.pageCount !== 1)) throw new OCRProviderError('OCR_PAGE_LIMIT');
  const validMagic = pdf ? hasPdfMagic(bytes)
    : document.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!validMagic) throw new OCRProviderError('OCR_INVALID_DOCUMENT');
  return `data:${document.mimeType};base64,${bytes.toString('base64')}`;
}

function plainText(content: string): string {
  return content.replace(/<\/(?:td|th)\s*>/gi, '    ').replace(/<\/(?:tr|p|div)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!)
    .replaceAll('\0', '').trim();
}

function usageFrom(value: unknown): OCRUsage | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) invalid();
  const usage: OCRUsage = {};
  for (const [external, internal] of [
    ['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens'],
  ] as const) {
    if (value[external] !== undefined) {
      if (!integer(value[external])) invalid();
      usage[internal] = value[external];
    }
  }
  if (value.prompt_tokens_details !== undefined) {
    if (!object(value.prompt_tokens_details)) invalid();
    if (value.prompt_tokens_details.cached_tokens !== undefined) {
      if (!integer(value.prompt_tokens_details.cached_tokens)) invalid();
      usage.cachedTokens = value.prompt_tokens_details.cached_tokens;
    }
  }
  if (usage.inputTokens !== undefined && usage.cachedTokens !== undefined && usage.cachedTokens > usage.inputTokens) invalid();
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined
    && usage.totalTokens !== usage.inputTokens + usage.outputTokens) invalid();
  return usage;
}

export function normalizeZaiOcrResponse(value: unknown, pageCount: number, requestId: string): OCRResult {
  if (!object(value) || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)
    || typeof value.model !== 'string' || value.model.toLowerCase() !== 'glm-ocr') invalid();
  if (value.request_id !== undefined && value.request_id !== requestId) invalid();
  if (value.md_results !== undefined && typeof value.md_results !== 'string') invalid();
  if (value.layout_details !== undefined && !Array.isArray(value.layout_details)) invalid();
  const layouts = value.layout_details as unknown[] | undefined;
  if (layouts && layouts.length > pageCount) invalid();
  let dimensions: unknown[] = [];
  if (value.data_info !== undefined) {
    if (!object(value.data_info) || !integer(value.data_info.num_pages)
      || value.data_info.num_pages !== pageCount) invalid();
    if (value.data_info.pages !== undefined) {
      if (!Array.isArray(value.data_info.pages) || value.data_info.pages.length > pageCount) invalid();
      dimensions = value.data_info.pages;
    }
  }
  const pages: OCRPage[] = Array.from({ length: pageCount }, (_, index) => {
    const page: OCRPage = { pageNumber: index + 1, blocks: [] };
    const size = dimensions[index];
    if (size !== undefined) {
      if (!object(size) || !integer(size.width) || !integer(size.height) || size.width < 1 || size.height < 1) invalid();
      page.width = size.width;
      page.height = size.height;
    }
    const blocks = layouts?.[index] ?? [];
    if (!Array.isArray(blocks) || blocks.length > 10_000) invalid();
    for (const block of blocks) {
      if (!object(block) || !integer(block.index) || typeof block.label !== 'string'
        || (block.content !== undefined && typeof block.content !== 'string')) invalid();
      const type = Object.hasOwn(blockTypes, block.label) ? blockTypes[block.label]! : 'UNKNOWN';
      const normalized: OCRPage['blocks'][number] = { type };
      // Images can contain provider URLs; preserve geometry only and never fetch them.
      if (typeof block.content === 'string' && type !== 'IMAGE') normalized.content = block.content.replaceAll('\0', '');
      if (block.bbox_2d !== undefined) {
        const box = block.bbox_2d;
        if (!Array.isArray(box) || box.length !== 4
          || !box.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0)) invalid();
        let [x, y, right, bottom] = box as [number, number, number, number];
        // The live API and official SDK return pixels; the API reference also documents 0..1.
        // Convert pixels only with explicit page dimensions; never guess a 0..1000 coordinate space.
        if (box.some((coordinate) => coordinate > 1)) {
          if (!page.width || !page.height || !box.every(Number.isSafeInteger) || right > page.width || bottom > page.height) invalid();
          x /= page.width;
          right /= page.width;
          y /= page.height;
          bottom /= page.height;
        }
        if (right <= x || bottom <= y) invalid();
        normalized.sourceRegion = {
          version: 1, space: 'PAGE_NORMALIZED', origin: 'TOP_LEFT', x, y,
          width: Number((right - x).toFixed(8)), height: Number((bottom - y).toFixed(8)),
        };
      }
      page.blocks.push(normalized);
    }
    return page;
  });
  const markdown = typeof value.md_results === 'string' ? value.md_results.replaceAll('\0', '').trim() : '';
  const blockText = pages.map((page) => page.blocks.filter((block) => block.type !== 'IMAGE')
    .map((block) => plainText(block.content ?? '')).filter(Boolean).join('\n')).filter(Boolean).join('\n');
  const text = blockText || plainText(markdown);
  if (!text) invalid();
  const usage = usageFrom(value.usage);
  return {
    provider: 'zai', model: 'glm-ocr', providerVersion: '1', text, pages,
    ...(markdown ? { markdown } : {}), ...(usage ? { usage } : {}),
    externalRequestId: requestId, retryCount: 0, durationMs: 0,
  };
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new OCRProviderError('OCR_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown; }
  catch { return invalid(); }
}

function httpError(status: number): OCRProviderError {
  if (status === 401 || status === 403) return new OCRProviderError('OCR_AUTH_FAILED');
  if (status === 429) return new OCRProviderError('OCR_RATE_LIMITED', true);
  if (status === 408 || status === 504) return new OCRProviderError('OCR_TIMEOUT', true);
  if (status >= 500) return new OCRProviderError('OCR_PROVIDER_UNAVAILABLE', true);
  return new OCRProviderError(status >= 300 && status < 400 ? 'OCR_REDIRECT_REJECTED' : 'OCR_INVALID_DOCUMENT');
}

export class ZaiGlmOcrProvider implements OCRProvider {
  readonly providerName = 'zai';
  readonly model = 'glm-ocr';
  readonly providerVersion = '1';
  readonly capabilities = ZAI_OCR_CAPABILITIES;
  private readonly config: OCRConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: NonNullable<ProviderOptions['sleepImpl']>;
  private active = 0;

  constructor(config: OCRConfig, options: ProviderOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((milliseconds, signal) => sleep(milliseconds, undefined, signal ? { signal } : {}));
  }

  isEnabled(): boolean { return this.config.enabled && this.config.provider === 'zai'; }

  async extract(document: OCRDocument, context: OCRContext = {}): Promise<OCRResult> {
    if (!this.isEnabled()) throw new OCRProviderError('OCR_DISABLED');
    if (!this.config.apiKey) throw new OCRProviderError('OCR_AUTH_FAILED');
    if (this.active >= this.config.maxConcurrency) throw new OCRProviderError('OCR_CONCURRENCY_LIMIT', true);
    if (context.requestId !== undefined && !/^sal_[0-9a-f-]{36}$/i.test(context.requestId)) throw new OCRProviderError('OCR_INVALID_REQUEST_ID');
    const file = zaiDocumentInput(document, this.config);
    this.active++;
    const started = Date.now();
    try {
      for (let attempt = 0; ; attempt++) {
        const requestId = attempt === 0 ? context.requestId ?? `sal_${randomUUID()}` : `sal_${randomUUID()}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
        let retryAfterMs = 0;
        try {
          signal.throwIfAborted();
          const response = await this.fetchImpl(`${this.config.baseUrl}/layout_parsing`, {
            method: 'POST', redirect: 'manual', signal,
            headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, file, request_id: requestId, return_crop_images: false, need_layout_visualization: false }),
          });
          if (!response.ok) {
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter && /^\d{1,5}$/.test(retryAfter)) retryAfterMs = Number(retryAfter) * 1000;
            await response.body?.cancel().catch(() => undefined);
            throw httpError(response.status);
          }
          const result = normalizeZaiOcrResponse(await boundedJson(response, this.config.maxResponseBytes), document.pageCount, requestId);
          return { ...result, retryCount: attempt, durationMs: Date.now() - started };
        } catch (cause) {
          const error = context.signal?.aborted ? new OCRProviderError('OCR_CANCELLED')
            : controller.signal.aborted ? new OCRProviderError('OCR_TIMEOUT', true)
              : cause instanceof OCRProviderError ? cause : new OCRProviderError('OCR_PROVIDER_UNAVAILABLE', true);
          error.externalRequestId = requestId;
          error.retryCount = attempt;
          error.durationMs = Date.now() - started;
          if (!error.retryable || attempt >= this.config.maxRetries || retryAfterMs > MAX_OCR_RETRY_DELAY_MS) throw error;
          clearTimeout(timer);
          try {
            await this.sleepImpl(Math.max(retryAfterMs, Math.floor(250 * 2 ** attempt * (0.5 + Math.random()))), context.signal);
          } catch {
            const cancelled = new OCRProviderError('OCR_CANCELLED');
            cancelled.externalRequestId = requestId;
            cancelled.retryCount = attempt;
            cancelled.durationMs = Date.now() - started;
            throw cancelled;
          }
        } finally { clearTimeout(timer); }
      }
    } finally { this.active--; }
  }
}
