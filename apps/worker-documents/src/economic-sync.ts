import {
  ECONOMIC_SERIES_CODES,
  MAX_DAILY_OBSERVATION_LOOKBACK_DAYS,
  validateEconomicObservation,
  validateEconomicSeries,
  type EconomicObservation,
  type EconomicSeries,
  type ExchangeRateSeries,
  type PriceIndexSeries,
} from '@salarivo/economic-data';
import { pool, withTransaction } from '@salarivo/database';
import { randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  DATOS_ARGENTINA_PROVIDER,
  DATOS_ARGENTINA_SERIES,
  DatosArgentinaProvider,
  EconomicProviderError,
} from './datos-argentina.ts';

const FX_BACKFILL_DAYS = 366;
const CPI_BACKFILL_MONTHS = 120;
const FX_REFRESH_DAYS = 35;
const CPI_REFRESH_MONTHS = 3;
const FX_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const CPI_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

const SERIES_METADATA = Object.freeze({
  license: DATOS_ARGENTINA_PROVIDER.license,
  licenseUrl: DATOS_ARGENTINA_PROVIDER.licenseUrl,
  providerName: DATOS_ARGENTINA_PROVIDER.name,
  providerSourceUrl: DATOS_ARGENTINA_PROVIDER.sourceUrl,
});

export const ECONOMIC_SERIES_DEFINITIONS = Object.freeze([
  Object.freeze({
    code: ECONOMIC_SERIES_CODES.AR_REFERENCE_USD_ARS,
    type: 'EXCHANGE_RATE',
    frequency: 'DAILY',
    countryCode: 'AR',
    baseCurrencyCode: 'USD',
    quoteCurrencyCode: 'ARS',
    variantCode: 'A3500_REFERENCE',
    providerCode: DATOS_ARGENTINA_PROVIDER.code,
    externalSeriesId: DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
    name: 'Tipo de cambio de referencia USD/ARS Comunicación A 3500',
    sourceUrl: 'https://www.datos.gob.ar/dataset/sspm-tipos-cambio-historicos',
    methodology: 'Unidades ARS por 1 USD. Espejo diario normalizado de Datos Argentina de la referencia Comunicación A 3500 del BCRA; puede repetir el último valor en días no hábiles.',
    validFrom: '2002-03-04',
    metadataNoSensitive: Object.freeze({
      ...SERIES_METADATA,
      attribution: 'Datos Argentina; fuente primaria Banco Central de la República Argentina (BCRA).',
      normalizedMirror: true,
    }),
  } satisfies ExchangeRateSeries & {
    readonly validFrom: string;
    readonly metadataNoSensitive: Readonly<Record<string, unknown>>;
  }),
  Object.freeze({
    code: ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX,
    type: 'PRICE_INDEX',
    frequency: 'MONTHLY',
    countryCode: 'AR',
    variantCode: 'GENERAL_NATIONAL_DEC_2016',
    providerCode: DATOS_ARGENTINA_PROVIDER.code,
    externalSeriesId: DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
    name: 'IPC Nivel General Nacional, base diciembre 2016',
    sourceUrl: 'https://www.datos.gob.ar/es/dataset/sspm-indice-precios-al-consumidor-nacional-ipc-base-diciembre-2016/archivo/sspm_145.3',
    methodology: 'Índice de Precios al Consumidor Nivel General Nacional, base diciembre 2016, frecuencia mensual; espejo de Datos Argentina con fuente primaria INDEC.',
    validFrom: '2016-12-01',
    metadataNoSensitive: Object.freeze({
      ...SERIES_METADATA,
      attribution: 'Datos Argentina; fuente primaria Instituto Nacional de Estadística y Censos (INDEC).',
      basePeriod: '2016-12',
    }),
  } satisfies PriceIndexSeries & {
    readonly validFrom: string;
    readonly metadataNoSensitive: Readonly<Record<string, unknown>>;
  }),
] as const);

type SeriesDefinition = typeof ECONOMIC_SERIES_DEFINITIONS[number];
type Frequency = SeriesDefinition['frequency'];

export type EconomicRange = {
  from: string;
  to: string;
};

type SeriesRow = {
  base_currency_code: string | null;
  code: string;
  country_code: string;
  external_series_id: string;
  frequency: Frequency;
  id: string;
  metadata_no_sensitive: Record<string, unknown>;
  methodology: string;
  name: string;
  provider_code: string;
  quote_currency_code: string | null;
  series_type: EconomicSeries['type'];
  source_url: string;
  status: string;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  variant_code: string;
};

export type EconomicSyncJob = {
  attempt: number;
  id: string;
  leaseOwner: string;
  maxAttempts: number;
  range: EconomicRange;
  series: EconomicSeries & { id: string };
};

export type EconomicMaintenanceResult = {
  completed: number;
  failed: number;
  insertedObservations: number;
  planned: number;
  recovered: number;
  retried: number;
};

export type EconomicQuery = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;

export type LatestEconomicObservation = {
  observationDate: string;
  revision: number;
  value: string;
};

class EconomicSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.name = 'EconomicSyncError';
  }
}

function isoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new EconomicSyncError('ECONOMIC_RANGE_INVALID', false);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new EconomicSyncError('ECONOMIC_RANGE_INVALID', false);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextDate(date: Date, frequency: Frequency): Date {
  const next = new Date(date.valueOf());
  if (frequency === 'DAILY') next.setUTCDate(next.getUTCDate() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return next;
}

function previousDate(date: Date, frequency: Frequency): Date {
  const previous = new Date(date.valueOf());
  if (frequency === 'DAILY') previous.setUTCDate(previous.getUTCDate() - 1);
  else previous.setUTCMonth(previous.getUTCMonth() - 1, 1);
  return previous;
}

function rangeLimit(frequency: Frequency): number {
  return frequency === 'DAILY' ? FX_BACKFILL_DAYS : CPI_BACKFILL_MONTHS;
}

export function planMissingEconomicRanges(
  frequency: Frequency,
  required: EconomicRange,
  existingObservationDates: readonly string[],
): EconomicRange[] {
  const from = parseDate(required.from);
  const to = parseDate(required.to);
  if (from > to || (frequency === 'MONTHLY'
    && (from.getUTCDate() !== 1 || to.getUTCDate() !== 1))) {
    throw new EconomicSyncError('ECONOMIC_RANGE_INVALID', false);
  }
  const existing = new Set(existingObservationDates.map((value) => {
    const parsed = parseDate(value);
    if (frequency === 'MONTHLY' && parsed.getUTCDate() !== 1) {
      throw new EconomicSyncError('ECONOMIC_OBSERVATION_DATE_INVALID', false);
    }
    return value;
  }));
  const ranges: EconomicRange[] = [];
  let chunkStart: Date | null = null;
  let chunkEnd: Date | null = null;
  let chunkSize = 0;
  const limit = rangeLimit(frequency);
  for (let cursor = from; cursor <= to; cursor = nextDate(cursor, frequency)) {
    if (existing.has(formatDate(cursor))) {
      if (chunkStart && chunkEnd) ranges.push({ from: formatDate(chunkStart), to: formatDate(chunkEnd) });
      chunkStart = null;
      chunkEnd = null;
      chunkSize = 0;
      continue;
    }
    if (chunkStart === null) chunkStart = new Date(cursor.valueOf());
    chunkEnd = new Date(cursor.valueOf());
    chunkSize += 1;
    if (chunkSize === limit) {
      ranges.push({ from: formatDate(chunkStart), to: formatDate(chunkEnd) });
      chunkStart = null;
      chunkEnd = null;
      chunkSize = 0;
    }
  }
  if (chunkStart && chunkEnd) ranges.push({ from: formatDate(chunkStart), to: formatDate(chunkEnd) });
  return ranges;
}

export function economicRefreshRange(frequency: Frequency, required: EconomicRange): EconomicRange {
  const from = parseDate(required.from);
  const to = parseDate(required.to);
  const overlap = frequency === 'DAILY' ? FX_REFRESH_DAYS : CPI_REFRESH_MONTHS;
  let refreshFrom = new Date(to.valueOf());
  for (let index = 1; index < overlap; index += 1) refreshFrom = previousDate(refreshFrom, frequency);
  if (refreshFrom < from) refreshFrom = from;
  return { from: formatDate(refreshFrom), to: formatDate(to) };
}

export function cpiReferenceRange(required: EconomicRange, today: string): EconomicRange {
  parseDate(required.from);
  parseDate(required.to);
  parseDate(today);
  const currentMonth = `${today.slice(0, 7)}-01`;
  return {
    from: `${required.from.slice(0, 7)}-01`,
    to: required.to > currentMonth ? `${required.to.slice(0, 7)}-01` : currentMonth,
  };
}

export function dailyObservationCoverageStart(targetDate: string, validFrom: string): string {
  const target = parseDate(targetDate);
  const floor = parseDate(validFrom);
  target.setUTCDate(target.getUTCDate() - MAX_DAILY_OBSERVATION_LOOKBACK_DAYS);
  return formatDate(target < floor ? floor : target);
}

function seriesFromRow(row: SeriesRow): EconomicSeries & { id: string } {
  const common = {
    id: row.id,
    code: row.code,
    type: row.series_type,
    frequency: row.frequency,
    countryCode: row.country_code,
    variantCode: row.variant_code,
    providerCode: row.provider_code,
    externalSeriesId: row.external_series_id,
    name: row.name,
    methodology: row.methodology,
    sourceUrl: row.source_url,
  } as const;
  return validateEconomicSeries(row.series_type === 'EXCHANGE_RATE'
    ? {
        ...common,
        type: 'EXCHANGE_RATE',
        baseCurrencyCode: row.base_currency_code ?? '',
        quoteCurrencyCode: row.quote_currency_code ?? '',
      }
    : { ...common, type: 'PRICE_INDEX' });
}

function definitionForCode(code: string): SeriesDefinition {
  const definition = ECONOMIC_SERIES_DEFINITIONS.find((candidate) => candidate.code === code);
  if (!definition) throw new EconomicSyncError('ECONOMIC_SERIES_UNSUPPORTED', false);
  return definition;
}

function assertSeriesConfiguration(row: SeriesRow): void {
  const definition = definitionForCode(row.code);
  const matches = row.status === 'ACTIVE'
    && row.series_type === definition.type
    && row.frequency === definition.frequency
    && row.country_code === definition.countryCode
    && row.base_currency_code === ('baseCurrencyCode' in definition ? definition.baseCurrencyCode : null)
    && row.quote_currency_code === ('quoteCurrencyCode' in definition ? definition.quoteCurrencyCode : null)
    && row.variant_code === definition.variantCode
    && row.provider_code === definition.providerCode
    && row.external_series_id === definition.externalSeriesId
    && row.name === definition.name
    && row.source_url === definition.sourceUrl
    && row.methodology === definition.methodology
    && isoDate(row.valid_from) === definition.validFrom
    && isoDate(row.valid_to) === null
    && row.metadata_no_sensitive.license === DATOS_ARGENTINA_PROVIDER.license
    && row.metadata_no_sensitive.licenseUrl === DATOS_ARGENTINA_PROVIDER.licenseUrl;
  if (!matches) throw new EconomicSyncError('ECONOMIC_SERIES_CONFIG_MISMATCH', false);
  seriesFromRow(row);
}

async function ensureEconomicSeries(client: PoolClient): Promise<SeriesRow[]> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('salarivo:economic-series-config', 0))`);
  for (const definition of ECONOMIC_SERIES_DEFINITIONS) {
    await client.query(
      `INSERT INTO economic_series (
         id, code, series_type, frequency, country_code, base_currency_code,
         quote_currency_code, variant_code, provider_code, external_series_id,
         name, source_url, methodology, status, valid_from, metadata_no_sensitive
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 'ACTIVE', $14, $15::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        definition.code,
        definition.type,
        definition.frequency,
        definition.countryCode,
        'baseCurrencyCode' in definition ? definition.baseCurrencyCode : null,
        'quoteCurrencyCode' in definition ? definition.quoteCurrencyCode : null,
        definition.variantCode,
        definition.providerCode,
        definition.externalSeriesId,
        definition.name,
        definition.sourceUrl,
        definition.methodology,
        definition.validFrom,
        JSON.stringify(definition.metadataNoSensitive),
      ],
    );
  }
  const result = await client.query<SeriesRow>(
    `SELECT id, code, series_type, frequency, country_code, base_currency_code,
            quote_currency_code, variant_code, provider_code, external_series_id,
            name, source_url, methodology, status, valid_from, valid_to,
            metadata_no_sensitive
       FROM economic_series
      WHERE code = ANY($1::text[])`,
    [ECONOMIC_SERIES_DEFINITIONS.map(({ code }) => code)],
  );
  if (result.rows.length !== ECONOMIC_SERIES_DEFINITIONS.length) {
    throw new EconomicSyncError('ECONOMIC_SERIES_CONFIG_MISMATCH', false);
  }
  for (const row of result.rows) assertSeriesConfiguration(row);
  return result.rows;
}

type RequiredRangesRow = {
  cpi_end: string | null;
  cpi_start: string | null;
  fx_end: string | null;
  fx_start: string | null;
};

async function requiredRanges(): Promise<RequiredRangesRow> {
  const result = await pool.query<RequiredRangesRow>(
    `SELECT
       min(COALESCE(settlement.payment_date, settlement.issue_date,
           (settlement.payroll_period + interval '1 month - 1 day')::date))::text AS fx_start,
       max(COALESCE(settlement.payment_date, settlement.issue_date,
           (settlement.payroll_period + interval '1 month - 1 day')::date))::text AS fx_end,
       min(settlement.payroll_period)::text AS cpi_start,
       max(settlement.payroll_period)::text AS cpi_end
     FROM payroll_settlements AS settlement
     JOIN documents AS document
       ON document.id = settlement.document_id AND document.user_id = settlement.user_id
     JOIN extraction_runs AS run
       ON run.id = document.active_extraction_run_id
      AND run.id = settlement.extraction_run_id
      AND run.user_id = settlement.user_id
      AND run.status = 'COMPLETED'
     LEFT JOIN employments AS employment
       ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
     LEFT JOIN employers AS detected_employer
       ON detected_employer.id = document.detected_employer_id
    WHERE document.deleted_at IS NULL
      AND document.security_status = 'CLEAN'
      AND document.document_type = 'PAYROLL'
      AND document.processing_status = 'COMPLETED'
      AND settlement.currency_code = 'ARS'
      AND COALESCE(employment.country_code, detected_employer.country_code) = 'AR'`,
  );
  return result.rows[0] ?? { cpi_end: null, cpi_start: null, fx_end: null, fx_start: null };
}

function clampRequiredRange(
  definition: SeriesDefinition,
  raw: EconomicRange | null,
  today: string,
): EconomicRange | null {
  if (!raw) return null;
  const candidateFrom = definition.frequency === 'DAILY'
    ? dailyObservationCoverageStart(raw.from, definition.validFrom)
    : raw.from;
  const from = candidateFrom < definition.validFrom ? definition.validFrom : candidateFrom;
  const to = raw.to > today ? today : raw.to;
  if (from > to) return null;
  if (definition.frequency === 'MONTHLY') {
    return { from: `${from.slice(0, 7)}-01`, to: `${to.slice(0, 7)}-01` };
  }
  return { from, to };
}

async function existingDates(seriesId: string, range: EconomicRange): Promise<string[]> {
  const result = await pool.query<{ observation_date: string }>(
    `SELECT DISTINCT observation_date::text
       FROM economic_observations
      WHERE series_id = $1 AND observation_date BETWEEN $2 AND $3
      ORDER BY observation_date`,
    [seriesId, range.from, range.to],
  );
  return result.rows.map(({ observation_date }) => observation_date);
}

async function enqueueRange(
  seriesId: string,
  range: EconomicRange,
  recentAfter: Date,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO economic_sync_jobs (
       id, series_id, range_start, range_end, state, available_at, max_attempts
     )
     SELECT $1, $2, $3, $4, 'PENDING', now(), 5
      WHERE NOT EXISTS (
        SELECT 1 FROM economic_sync_jobs
         WHERE series_id = $2 AND state IN ('PENDING', 'RUNNING', 'RETRYABLE')
      )
        AND NOT EXISTS (
          SELECT 1 FROM economic_sync_jobs
           WHERE series_id = $2 AND range_start = $3 AND range_end = $4
             AND state IN ('COMPLETED', 'FAILED', 'CANCELLED')
             AND completed_at >= $5
        )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [randomUUID(), seriesId, range.from, range.to, recentAfter],
  );
  return (result.rowCount ?? 0) > 0;
}

async function planNextJobs(seriesRows: readonly SeriesRow[], now: Date): Promise<number> {
  const needed = await requiredRanges();
  const today = formatDate(now);
  let planned = 0;
  for (const row of seriesRows) {
    const definition = definitionForCode(row.code);
    let raw = definition.frequency === 'DAILY'
      ? needed.fx_start && needed.fx_end ? { from: needed.fx_start, to: needed.fx_end } : null
      : needed.cpi_start && needed.cpi_end ? { from: needed.cpi_start, to: needed.cpi_end } : null;
    if (raw && definition.frequency === 'MONTHLY') raw = cpiReferenceRange(raw, today);
    const required = clampRequiredRange(definition, raw, today);
    if (!required) continue;
    const present = await existingDates(row.id, required);
    const missing = planMissingEconomicRanges(definition.frequency, required, present);
    const interval = definition.frequency === 'DAILY' ? FX_REFRESH_INTERVAL_MS : CPI_REFRESH_INTERVAL_MS;
    const recentAfter = new Date(now.valueOf() - interval);
    let inserted = false;
    for (const range of missing) {
      if (await enqueueRange(row.id, range, recentAfter)) {
        inserted = true;
        planned += 1;
        break;
      }
    }
    if (!inserted && await enqueueRange(
      row.id,
      economicRefreshRange(definition.frequency, required),
      recentAfter,
    )) planned += 1;
  }
  return planned;
}

async function recoverExpiredEconomicJobs(): Promise<number> {
  const result = await pool.query(
    `UPDATE economic_sync_jobs
        SET state = CASE WHEN attempt < max_attempts THEN 'RETRYABLE' ELSE 'FAILED' END,
            available_at = CASE WHEN attempt < max_attempts THEN now() ELSE available_at END,
            completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE now() END,
            lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'ECONOMIC_SYNC_LEASE_EXPIRED', updated_at = now()
      WHERE state = 'RUNNING' AND lease_expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

async function claimEconomicJob(workerId: string, leaseMs: number): Promise<EconomicSyncJob | null> {
  return withTransaction(async (client) => {
    const claimed = await client.query<{
      attempt: number;
      id: string;
      max_attempts: number;
      range_end: string;
      range_start: string;
      series_id: string;
    }>(
      `WITH candidate AS (
         SELECT job.id
           FROM economic_sync_jobs AS job
           JOIN economic_series AS series ON series.id = job.series_id AND series.status = 'ACTIVE'
          WHERE job.state IN ('PENDING', 'RETRYABLE')
            AND job.available_at <= now() AND job.attempt < job.max_attempts
          ORDER BY job.available_at, job.created_at
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
       )
       UPDATE economic_sync_jobs AS job
          SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $1,
              lease_expires_at = now() + ($2 * interval '1 millisecond'),
              started_at = COALESCE(started_at, now()), completed_at = NULL,
              error_code = NULL, updated_at = now()
         FROM candidate
        WHERE job.id = candidate.id
       RETURNING job.id, job.series_id, job.range_start::text, job.range_end::text,
                 job.attempt, job.max_attempts`,
      [workerId, leaseMs],
    );
    const job = claimed.rows[0];
    if (!job) return null;
    const seriesResult = await client.query<SeriesRow>(
      `SELECT id, code, series_type, frequency, country_code, base_currency_code,
              quote_currency_code, variant_code, provider_code, external_series_id,
              name, source_url, methodology, status, valid_from, valid_to,
              metadata_no_sensitive
         FROM economic_series WHERE id = $1`,
      [job.series_id],
    );
    const row = seriesResult.rows[0];
    if (!row) throw new EconomicSyncError('ECONOMIC_SERIES_MISSING', false);
    assertSeriesConfiguration(row);
    return {
      attempt: job.attempt,
      id: job.id,
      leaseOwner: workerId,
      maxAttempts: job.max_attempts,
      range: { from: job.range_start, to: job.range_end },
      series: seriesFromRow(row),
    };
  });
}

function economicError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof EconomicProviderError || error instanceof EconomicSyncError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: 'ECONOMIC_SYNC_FAILED', retryable: true };
}

export function economicRetryDelay(attempt: number, jitter = randomInt(0, 10_001)): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(jitter)
    || jitter < 0 || jitter > 10_000) {
    throw new EconomicSyncError('ECONOMIC_RETRY_INVALID', false);
  }
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 10) + jitter, RETRY_MAX_MS);
}

function canonicalPositiveDecimal(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match?.[1]) throw new EconomicSyncError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
  const whole = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function selectEconomicObservationRevisions(
  observations: readonly EconomicObservation[],
  latestObservations: readonly LatestEconomicObservation[],
): Array<{
  fetched_at: string;
  id: string;
  metadata_no_sensitive: Readonly<Record<string, unknown>>;
  observation_date: string;
  provider_observation_id: string;
  provider_payload_sha256: string;
  revision: number;
  value: string;
}> {
  for (const observation of latestObservations) {
    parseDate(observation.observationDate);
    canonicalPositiveDecimal(observation.value);
    if (!Number.isSafeInteger(observation.revision) || observation.revision < 1) {
      throw new EconomicSyncError('ECONOMIC_OBSERVATION_REVISION_INVALID', false);
    }
  }
  const latest = new Map(latestObservations.map((observation) => [
    observation.observationDate,
    observation,
  ]));
  const seen = new Set<string>();
  const selected = [];
  for (const raw of observations) {
    const observation = validateEconomicObservation(raw);
    if (seen.has(observation.date)) {
      throw new EconomicSyncError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
    }
    seen.add(observation.date);
    const current = latest.get(observation.date);
    if (current && canonicalPositiveDecimal(current.value) === canonicalPositiveDecimal(observation.value)) {
      continue;
    }
    const providerPayloadSha256 = observation.metadataNoSensitive?.providerPayloadSha256;
    if (typeof providerPayloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(providerPayloadSha256)
      || !observation.observedAt) {
      throw new EconomicSyncError('ECONOMIC_PROVIDER_PROVENANCE_INVALID', false);
    }
    selected.push({
      fetched_at: observation.observedAt,
      id: randomUUID(),
      metadata_no_sensitive: observation.metadataNoSensitive ?? {},
      observation_date: observation.date,
      provider_observation_id: '',
      provider_payload_sha256: providerPayloadSha256,
      revision: (current?.revision ?? 0) + 1,
      value: observation.value,
    });
  }
  return selected;
}

async function failEconomicJob(job: EconomicSyncJob, error: unknown): Promise<'failed' | 'retried'> {
  const failure = economicError(error);
  const retry = failure.retryable && job.attempt < job.maxAttempts;
  const delay = retry ? economicRetryDelay(job.attempt) : 0;
  const updated = await pool.query(
    `UPDATE economic_sync_jobs
        SET state = $3,
            available_at = CASE WHEN $3 = 'RETRYABLE'
              THEN now() + ($4 * interval '1 millisecond') ELSE available_at END,
            completed_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE NULL END,
            lease_owner = NULL, lease_expires_at = NULL,
            error_code = $5, updated_at = now()
      WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
    [job.id, job.leaseOwner, retry ? 'RETRYABLE' : 'FAILED', delay, failure.code],
  );
  if (!updated.rowCount) throw new EconomicSyncError('ECONOMIC_SYNC_LEASE_LOST', true);
  return retry ? 'retried' : 'failed';
}

export async function persistEconomicObservationsWithQuery(
  query: EconomicQuery,
  job: EconomicSyncJob,
  observations: readonly EconomicObservation[],
): Promise<number> {
    const owned = await query(
      `SELECT 1 FROM economic_sync_jobs
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2
          AND lease_expires_at > now()
        FOR UPDATE`,
      [job.id, job.leaseOwner],
    );
    if (!owned.rowCount) throw new EconomicSyncError('ECONOMIC_SYNC_LEASE_LOST', true);
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `salarivo:economic-observations:${job.series.id}`,
    ]);
    for (const raw of observations) {
      const observation = validateEconomicObservation(raw);
      if (observation.seriesCode !== job.series.code
        || observation.date < job.range.from || observation.date > job.range.to) {
        throw new EconomicSyncError('ECONOMIC_PROVIDER_OBSERVATION_INVALID', false);
      }
    }
    const latestResult = await query(
      `SELECT DISTINCT ON (observation_date) observation_date::text, value::text, revision
         FROM economic_observations
        WHERE series_id = $1 AND observation_date BETWEEN $2 AND $3
        ORDER BY observation_date, revision DESC`,
      [job.series.id, job.range.from, job.range.to],
    );
    const incoming = selectEconomicObservationRevisions(observations, latestResult.rows.map((row) => ({
      observationDate: String(row.observation_date),
      revision: Number(row.revision),
      value: String(row.value),
    }))).map((observation) => ({
      ...observation,
      provider_observation_id: `${job.series.externalSeriesId}:${observation.observation_date}`,
    }));
    let inserted = 0;
    if (incoming.length > 0) {
      const result = await query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS value(
             id uuid, observation_date date, value numeric, revision integer,
             provider_observation_id text, provider_payload_sha256 text, fetched_at timestamptz,
             metadata_no_sensitive jsonb
           )
         )
         INSERT INTO economic_observations (
           id, series_id, observation_date, value, revision,
           provider_observation_id, provider_payload_sha256,
           source_updated_at, fetched_at, metadata_no_sensitive
         )
         SELECT incoming.id, $1, incoming.observation_date, incoming.value,
                incoming.revision, incoming.provider_observation_id,
                incoming.provider_payload_sha256, NULL, incoming.fetched_at,
                incoming.metadata_no_sensitive
           FROM incoming
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [job.series.id, JSON.stringify(incoming)],
      );
      inserted = result.rowCount ?? 0;
    }
    const completed = await query(
      `UPDATE economic_sync_jobs
          SET state = 'COMPLETED', completed_at = now(), lease_owner = NULL,
              lease_expires_at = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
      [job.id, job.leaseOwner],
    );
    if (!completed.rowCount) throw new EconomicSyncError('ECONOMIC_SYNC_LEASE_LOST', true);
    return inserted;
}

async function persistEconomicObservations(
  job: EconomicSyncJob,
  observations: readonly EconomicObservation[],
): Promise<number> {
  return withTransaction(async (client) => {
    const query: EconomicQuery = async (sql, values = []) => {
      const result = await client.query(sql, [...values]);
      return { rowCount: result.rowCount, rows: result.rows as Record<string, unknown>[] };
    };
    return persistEconomicObservationsWithQuery(query, job, observations);
  });
}

async function processEconomicJob(
  job: EconomicSyncJob,
  signal: AbortSignal,
  provider: DatosArgentinaProvider,
): Promise<{ inserted: number; outcome: 'completed' | 'failed' | 'retried' }> {
  try {
    const observations = await provider.fetchRange(job.series, job.range, signal);
    const inserted = await persistEconomicObservations(job, observations);
    return { inserted, outcome: 'completed' };
  } catch (error) {
    return { inserted: 0, outcome: await failEconomicJob(job, error) };
  }
}

export async function maintainEconomicData(
  workerId: string,
  leaseMs: number,
  signal: AbortSignal,
  provider = new DatosArgentinaProvider(),
): Promise<EconomicMaintenanceResult> {
  const result: EconomicMaintenanceResult = {
    completed: 0,
    failed: 0,
    insertedObservations: 0,
    planned: 0,
    recovered: 0,
    retried: 0,
  };
  const seriesRows = await withTransaction(ensureEconomicSeries);
  result.recovered = await recoverExpiredEconomicJobs();
  result.planned = await planNextJobs(seriesRows, new Date());
  if (signal.aborted) return result;
  const job = await claimEconomicJob(workerId, leaseMs);
  if (!job) return result;
  const processed = await processEconomicJob(job, signal, provider);
  result.insertedObservations = processed.inserted;
  result[processed.outcome] += 1;
  return result;
}
