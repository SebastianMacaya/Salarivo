import {
  ECONOMIC_SERIES_CODES,
  validateEconomicDateRange,
  validateEconomicObservation,
  validateEconomicSeries,
  type EconomicDateRange,
  type EconomicObservation,
  type EconomicSeries,
  type ExchangeRateProvider,
  type PriceIndexProvider,
} from '@salarivo/economic-data';
import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://apis.datos.gob.ar';
const API_PATH = '/series/api/series/';
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export const DATOS_ARGENTINA_PROVIDER = {
  code: 'DATOS_ARGENTINA',
  name: 'Datos Argentina - API de Series de Tiempo',
  sourceUrl: 'https://www.datos.gob.ar/',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
} as const;

export const DATOS_ARGENTINA_SERIES = {
  FX_USD_ARS_A3500: {
    code: '175.1_DR_REFE500_0_0_25',
    internalCode: ECONOMIC_SERIES_CODES.AR_REFERENCE_USD_ARS,
    frequency: 'DAILY',
    responseFrequency: 'day',
    metadataFrequency: 'R/P1D',
    source: 'Banco Central de la República Argentina (BCRA)',
  },
  CPI_AR_NATIONAL: {
    code: '145.3_INGNACNAL_DICI_M_15',
    internalCode: ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX,
    frequency: 'MONTHLY',
    responseFrequency: 'month',
    metadataFrequency: 'R/P1M',
    source: 'Instituto Nacional de Estadística y Censos (INDEC)',
  },
} as const;

export type DatosArgentinaSeriesCode = typeof DATOS_ARGENTINA_SERIES[keyof typeof DATOS_ARGENTINA_SERIES]['code'];

type SeriesDefinition = typeof DATOS_ARGENTINA_SERIES[keyof typeof DATOS_ARGENTINA_SERIES];

export type ProviderObservation = {
  date: string;
  value: string;
};

export type ProviderBatch = {
  observations: ProviderObservation[];
  provenance: {
    attribution: string;
    license: typeof DATOS_ARGENTINA_PROVIDER.license;
    licenseUrl: typeof DATOS_ARGENTINA_PROVIDER.licenseUrl;
    providerCode: typeof DATOS_ARGENTINA_PROVIDER.code;
    providerName: typeof DATOS_ARGENTINA_PROVIDER.name;
    providerPayloadSha256: string;
    retrievedAt: string;
    seriesCode: DatosArgentinaSeriesCode;
    source: string;
    sourceUrl: typeof DATOS_ARGENTINA_PROVIDER.sourceUrl;
  };
};

export class EconomicProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.name = 'EconomicProviderError';
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ProviderOptions = {
  fetchImpl?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
};

function definitionFor(seriesCode: DatosArgentinaSeriesCode): SeriesDefinition {
  const definition = Object.values(DATOS_ARGENTINA_SERIES).find(({ code }) => code === seriesCode);
  if (!definition) throw new EconomicProviderError('ECONOMIC_SERIES_UNSUPPORTED', false);
  return definition;
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function inclusiveDays(from: Date, to: Date): number {
  return Math.floor((to.valueOf() - from.valueOf()) / 86_400_000) + 1;
}

function inclusiveMonths(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + to.getUTCMonth() - from.getUTCMonth() + 1;
}

export function validateProviderRange(
  seriesCode: DatosArgentinaSeriesCode,
  from: string,
  to: string,
): void {
  const definition = definitionFor(seriesCode);
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end || start > end) throw new EconomicProviderError('ECONOMIC_RANGE_INVALID', false);
  if (definition.frequency === 'DAILY' && inclusiveDays(start, end) > 366) {
    throw new EconomicProviderError('ECONOMIC_RANGE_TOO_LARGE', false);
  }
  if (definition.frequency === 'MONTHLY') {
    if (start.getUTCDate() !== 1 || end.getUTCDate() !== 1) {
      throw new EconomicProviderError('ECONOMIC_RANGE_INVALID', false);
    }
    if (inclusiveMonths(start, end) > 120) {
      throw new EconomicProviderError('ECONOMIC_RANGE_TOO_LARGE', false);
    }
  }
}

async function readBoundedBody(response: Response): Promise<{ sha256: string; text: string }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_BODY_TOO_LARGE', false);
    }
  }
  if (!response.body) throw new EconomicProviderError('ECONOMIC_PROVIDER_BODY_INVALID', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EconomicProviderError('ECONOMIC_PROVIDER_BODY_TOO_LARGE', false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    throw new EconomicProviderError('ECONOMIC_PROVIDER_BODY_INVALID', false);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseResponse(
  rawBody: string,
  definition: SeriesDefinition,
  from: string,
  to: string,
): ProviderObservation[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new EconomicProviderError('ECONOMIC_PROVIDER_SCHEMA_INVALID', false);
  }
  const root = object(payload);
  const data = root?.data;
  const count = root?.count;
  const meta = root?.meta;
  const params = object(root?.params);
  if (!Array.isArray(data) || !Number.isSafeInteger(count) || count !== data.length
    || !Array.isArray(meta) || meta.length < 2 || params?.ids !== definition.code) {
    throw new EconomicProviderError('ECONOMIC_PROVIDER_SCHEMA_INVALID', false);
  }
  const rangeMetadata = object(meta[0]);
  const fullMetadata = object(meta[1]);
  const catalog = object(fullMetadata?.catalog);
  const dataset = object(fullMetadata?.dataset);
  const field = object(fullMetadata?.field);
  if (rangeMetadata?.frequency !== definition.responseFrequency
    || field?.id !== definition.code
    || field?.frequency !== definition.metadataFrequency
    || dataset?.source !== definition.source
    || catalog?.license !== 'Creative Commons Attribution 4.0') {
    throw new EconomicProviderError('ECONOMIC_PROVIDER_METADATA_INVALID', false);
  }

  const observations: ProviderObservation[] = [];
  let previousDate: string | null = null;
  for (const row of data) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
      || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
    }
    const date = row[0];
    const parsedDate = parseDate(date);
    if (!parsedDate || (definition.frequency === 'MONTHLY' && parsedDate.getUTCDate() !== 1)
      || date < from || date > to || (previousDate !== null && date <= previousDate)) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
    }
    const value = String(row[1]);
    if (!/^\d+(?:\.\d{1,12})?$/.test(value)) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
    }
    observations.push({ date, value });
    previousDate = date;
  }
  if (observations.length > 0) {
    if (rangeMetadata?.start_date !== observations[0]!.date
      || rangeMetadata?.end_date !== observations.at(-1)!.date) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_METADATA_INVALID', false);
    }
  }
  return observations;
}

export class DatosArgentinaProvider implements ExchangeRateProvider, PriceIndexProvider {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(options: ProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 60_000) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_CONFIG_INVALID', false);
    }
  }

  async fetchObservations(
    seriesCode: DatosArgentinaSeriesCode,
    from: string,
    to: string,
    callerSignal?: AbortSignal,
  ): Promise<ProviderBatch> {
    const definition = definitionFor(seriesCode);
    validateProviderRange(seriesCode, from, to);
    const url = new URL(API_PATH, API_ORIGIN);
    url.searchParams.set('ids', seriesCode);
    url.searchParams.set('start_date', from);
    url.searchParams.set('end_date', to);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('metadata', 'full');
    if (url.protocol !== 'https:' || url.hostname !== 'apis.datos.gob.ar' || url.pathname !== API_PATH) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_CONFIG_INVALID', false);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: callerSignal
          ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_REQUEST_FAILED', true);
    }
    if (response.status !== 200) {
      const retryable = response.status === 408 || response.status === 425
        || response.status === 429 || response.status >= 500;
      throw new EconomicProviderError('ECONOMIC_PROVIDER_HTTP_ERROR', retryable);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new EconomicProviderError('ECONOMIC_PROVIDER_CONTENT_TYPE_INVALID', false);
    }
    const body = await readBoundedBody(response);
    const observations = parseResponse(body.text, definition, from, to);
    return {
      observations,
      provenance: {
        attribution: `${DATOS_ARGENTINA_PROVIDER.name}; fuente primaria: ${definition.source}`,
        license: DATOS_ARGENTINA_PROVIDER.license,
        licenseUrl: DATOS_ARGENTINA_PROVIDER.licenseUrl,
        providerCode: DATOS_ARGENTINA_PROVIDER.code,
        providerName: DATOS_ARGENTINA_PROVIDER.name,
        providerPayloadSha256: body.sha256,
        retrievedAt: this.#now().toISOString(),
        seriesCode,
        source: definition.source,
        sourceUrl: DATOS_ARGENTINA_PROVIDER.sourceUrl,
      },
    };
  }

  async fetchRange(
    series: EconomicSeries,
    range: EconomicDateRange,
    signal: AbortSignal,
  ): Promise<readonly EconomicObservation[]> {
    validateEconomicSeries(series);
    validateEconomicDateRange(range);
    const definition = definitionFor(series.externalSeriesId as DatosArgentinaSeriesCode);
    if (series.code !== definition.internalCode
      || series.providerCode !== DATOS_ARGENTINA_PROVIDER.code
      || series.countryCode !== 'AR'
      || series.frequency !== definition.frequency
      || series.type !== (definition.frequency === 'DAILY' ? 'EXCHANGE_RATE' : 'PRICE_INDEX')
      || (series.type === 'EXCHANGE_RATE'
        && (series.baseCurrencyCode !== 'USD' || series.quoteCurrencyCode !== 'ARS'))
      || (series.type === 'PRICE_INDEX' && definition.frequency !== 'MONTHLY')) {
      throw new EconomicProviderError('ECONOMIC_SERIES_CONFIG_MISMATCH', false);
    }
    const batch = await this.fetchObservations(definition.code, range.from, range.to, signal);
    return batch.observations.map(({ date, value }) => validateEconomicObservation({
      seriesCode: series.code,
      date,
      value,
      observedAt: batch.provenance.retrievedAt,
      metadataNoSensitive: {
        attribution: batch.provenance.attribution,
        license: batch.provenance.license,
        licenseUrl: batch.provenance.licenseUrl,
        providerCode: batch.provenance.providerCode,
        providerName: batch.provenance.providerName,
        providerPayloadSha256: batch.provenance.providerPayloadSha256,
        source: batch.provenance.source,
        sourceUrl: batch.provenance.sourceUrl,
      },
    }));
  }
}
