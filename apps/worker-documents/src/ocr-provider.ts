import type { SourceRegion } from './engine.ts';

export const MAX_OCR_RETRY_DELAY_MS = 30_000;

export type OCRConfig = {
  enabled: boolean;
  provider: 'disabled' | 'tesseract' | 'zai';
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  maxPdfPages: number;
  maxFileBytes: number;
  maxResponseBytes: number;
  dailyBudgetUsd: string;
  monthlyBudgetUsd: string;
  reservationUsd: string;
  inputPricePerMillionUsd: string;
  outputPricePerMillionUsd: string;
};

export type OCRDocument = { bytes: Uint8Array; mimeType: string; pageCount: number };
export type OCRContext = { requestId?: string; signal?: AbortSignal };
export type OCRUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
};
export type OCRPage = {
  pageNumber: number;
  width?: number;
  height?: number;
  blocks: Array<{
    type: 'TEXT' | 'TABLE' | 'IMAGE' | 'FORMULA' | 'UNKNOWN';
    content?: string;
    sourceRegion?: SourceRegion;
  }>;
};
export type OCRResult = {
  provider: string;
  model: string;
  providerVersion: string;
  text: string;
  markdown?: string;
  pages: OCRPage[];
  usage?: OCRUsage;
  externalRequestId: string;
  retryCount: number;
  durationMs: number;
};

export interface OCRProvider {
  readonly providerName: string;
  readonly model: string;
  readonly providerVersion: string;
  isEnabled(): boolean;
  extract(document: OCRDocument, context?: OCRContext): Promise<OCRResult>;
}

export class OCRProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  externalRequestId: string | null = null;
  retryCount = 0;
  durationMs = 0;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = 'OCRProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class DisabledOCRProvider implements OCRProvider {
  readonly providerName = 'disabled';
  readonly model = 'none';
  readonly providerVersion = '1';
  isEnabled(): boolean { return false; }
  async extract(_document: OCRDocument, _context?: OCRContext): Promise<OCRResult> {
    throw new OCRProviderError('OCR_DISABLED');
  }
}

export function isOCRResult(value: unknown, maxTextBytes = 2_097_152): value is OCRResult {
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  const nonnegativeInteger = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
  if (!object(value) || !['provider', 'model', 'providerVersion'].every((key) =>
    typeof value[key] === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value[key]))
    || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > maxTextBytes
    || (value.markdown !== undefined && (typeof value.markdown !== 'string' || Buffer.byteLength(value.markdown) > maxTextBytes))
    || typeof value.externalRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.externalRequestId)
    || !nonnegativeInteger(value.retryCount) || !nonnegativeInteger(value.durationMs)
    || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 100) return false;
  if (value.usage !== undefined && (!object(value.usage)
    || !Object.values(value.usage).every(nonnegativeInteger))) return false;
  return value.pages.every((page, index) => {
    if (!object(page) || page.pageNumber !== index + 1 || !Array.isArray(page.blocks)
      || page.blocks.length > 10_000 || ['width', 'height'].some((key) =>
        page[key] !== undefined && (!nonnegativeInteger(page[key]) || page[key] < 1))) return false;
    return page.blocks.every((block) => {
      if (!object(block) || typeof block.type !== 'string' || !['TEXT', 'TABLE', 'IMAGE', 'FORMULA', 'UNKNOWN'].includes(block.type)
        || (block.content !== undefined && (typeof block.content !== 'string' || Buffer.byteLength(block.content) > maxTextBytes))) return false;
      if (block.sourceRegion === undefined) return true;
      const region = block.sourceRegion;
      if (!object(region) || region.version !== 1 || region.space !== 'PAGE_NORMALIZED' || region.origin !== 'TOP_LEFT'
        || !['x', 'y', 'width', 'height'].every((key) => typeof region[key] === 'number'
          && Number.isFinite(region[key]) && region[key] >= 0 && region[key] <= 1)) return false;
      const { x, y, width, height } = region as { x: number; y: number; width: number; height: number };
      return width > 0 && height > 0 && x + width <= 1.00000001 && y + height <= 1.00000001;
    });
  });
}

// USD is fixed-point throughout, including sub-cent provider prices. Round up to 8 decimals.
export function estimateOcrCostUsd(
  usage: OCRUsage | undefined,
  pricing: Pick<OCRConfig, 'inputPricePerMillionUsd' | 'outputPricePerMillionUsd'>,
): string | null {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return null;
  if (![usage.inputTokens, usage.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const scaled = (value: string): bigint | null => {
    if (!/^\d{1,8}(?:\.\d{1,8})?$/.test(value)) return null;
    const [integer, fraction = ''] = value.split('.');
    return BigInt(integer!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  };
  const input = scaled(pricing.inputPricePerMillionUsd);
  const output = scaled(pricing.outputPricePerMillionUsd);
  if (input === null || output === null) return null;
  const units = (BigInt(usage.inputTokens) * input + BigInt(usage.outputTokens) * output + 999_999n) / 1_000_000n;
  return `${units / 100_000_000n}.${String(units % 100_000_000n).padStart(8, '0')}`;
}
