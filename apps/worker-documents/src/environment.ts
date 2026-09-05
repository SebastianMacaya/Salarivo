import type { OCRConfig } from './ocr-provider.ts';
import { ZAI_OCR_CAPABILITIES } from './zai-ocr-provider.ts';

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

export function loadOcrConfig(env: NodeJS.ProcessEnv = process.env): OCRConfig {
  const configured = (name: string, fallback: string) => env[name]?.trim() || fallback;
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number(configured(name, String(fallback)));
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid environment variable: ${name}`);
    return value;
  };
  const usd = (name: string, fallback: string): string => {
    const value = configured(name, fallback);
    if (!/^\d{1,8}(?:\.\d{1,8})?$/.test(value) || !/[1-9]/.test(value)) {
      throw new Error(`Invalid environment variable: ${name}`);
    }
    const [integerPart, fraction = ''] = value.split('.');
    return `${integerPart}.${fraction.padEnd(8, '0')}`;
  };
  const enabledValue = configured('OCR_ENABLED', 'true');
  if (!['true', 'false'].includes(enabledValue)) throw new Error('Invalid environment variable: OCR_ENABLED');
  const provider = configured('OCR_PROVIDER', 'tesseract');
  if (!['disabled', 'tesseract', 'zai'].includes(provider)) throw new Error('Invalid environment variable: OCR_PROVIDER');
  const enabled = enabledValue === 'true' && provider !== 'disabled';
  const apiKey = env.ZAI_API_KEY?.trim() || null;
  if (apiKey && (apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey))) throw new Error('Invalid environment variable: ZAI_API_KEY');
  const baseUrl = configured('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4').replace(/\/$/, '');
  if (baseUrl !== 'https://api.z.ai/api/paas/v4') throw new Error('ZAI_BASE_URL must use the official general application API');
  const model = configured('ZAI_OCR_MODEL', 'glm-ocr');
  if (model !== 'glm-ocr') throw new Error('Invalid environment variable: ZAI_OCR_MODEL');
  if (enabled && provider === 'zai' && !apiKey) throw new Error('Missing required environment variable: ZAI_API_KEY');
  return {
    enabled, provider: provider as OCRConfig['provider'], apiKey, baseUrl, model,
    timeoutMs: integer('ZAI_OCR_TIMEOUT_MS', 60_000, 100, 180_000),
    maxRetries: integer('ZAI_OCR_MAX_RETRIES', 1, 0, 2),
    maxConcurrency: integer('ZAI_OCR_MAX_CONCURRENCY', 1, 1, 10),
    maxPdfPages: integer('ZAI_OCR_MAX_PDF_PAGES', 10, 1, ZAI_OCR_CAPABILITIES.maxPdfPages),
    maxFileBytes: integer('ZAI_OCR_MAX_FILE_BYTES', 20_971_520, 1, ZAI_OCR_CAPABILITIES.maxPdfBytes),
    maxResponseBytes: integer('ZAI_OCR_MAX_RESPONSE_BYTES', 2_097_152, 1024, 10_485_760),
    dailyBudgetUsd: usd('ZAI_OCR_DAILY_BUDGET_USD', '1'),
    monthlyBudgetUsd: usd('ZAI_OCR_MONTHLY_BUDGET_USD', '10'),
    reservationUsd: usd('ZAI_OCR_RESERVATION_USD', '0.01'),
    inputPricePerMillionUsd: usd('ZAI_OCR_INPUT_PRICE_PER_MILLION_USD', '0.03'),
    outputPricePerMillionUsd: usd('ZAI_OCR_OUTPUT_PRICE_PER_MILLION_USD', '0.03'),
  };
}
