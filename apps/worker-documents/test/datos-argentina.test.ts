import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ECONOMIC_SERIES_CODES,
  type ExchangeRateSeries,
  type PriceIndexSeries,
} from '@salarivo/economic-data';
import {
  DATOS_ARGENTINA_PROVIDER,
  DATOS_ARGENTINA_SERIES,
  DatosArgentinaProvider,
  EconomicProviderError,
  validateProviderRange,
} from '../src/datos-argentina.ts';

const fxSeries: ExchangeRateSeries = {
  code: ECONOMIC_SERIES_CODES.AR_REFERENCE_USD_ARS,
  type: 'EXCHANGE_RATE',
  frequency: 'DAILY',
  countryCode: 'AR',
  baseCurrencyCode: 'USD',
  quoteCurrencyCode: 'ARS',
  variantCode: 'A3500_REFERENCE',
  providerCode: DATOS_ARGENTINA_PROVIDER.code,
  externalSeriesId: DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
  name: 'Synthetic configuration matching the production series',
  methodology: 'Synthetic configuration for deterministic provider tests.',
  sourceUrl: 'https://www.datos.gob.ar/',
};

const cpiSeries: PriceIndexSeries = {
  code: ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX,
  type: 'PRICE_INDEX',
  frequency: 'MONTHLY',
  countryCode: 'AR',
  variantCode: 'GENERAL_NATIONAL_DEC_2016',
  providerCode: DATOS_ARGENTINA_PROVIDER.code,
  externalSeriesId: DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
  name: 'Synthetic configuration matching the production series',
  methodology: 'Synthetic configuration for deterministic provider tests.',
  sourceUrl: 'https://www.datos.gob.ar/',
};

function responsePayload(input: {
  data: unknown[];
  end: string;
  frequency: 'day' | 'month';
  metadataFrequency: 'R/P1D' | 'R/P1M';
  seriesCode: string;
  source: string;
  start: string;
}): Record<string, unknown> {
  return {
    data: input.data,
    count: input.data.length,
    meta: [
      { frequency: input.frequency, start_date: input.start, end_date: input.end },
      {
        catalog: { license: 'Creative Commons Attribution 4.0' },
        dataset: { source: input.source },
        field: { id: input.seriesCode, frequency: input.metadataFrequency },
      },
    ],
    params: { ids: input.seriesCode },
  };
}

test('requests only the fixed Datos Argentina host and returns validated FX provenance', async () => {
  const requested: { init?: RequestInit; url?: URL } = {};
  const provider = new DatosArgentinaProvider({
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    fetchImpl: async (input, init) => {
      requested.url = new URL(String(input));
      requested.init = init ?? {};
      return new Response(JSON.stringify(responsePayload({
        data: [['2024-11-29', 1001.125], ['2024-11-30', 1001.125]],
        start: '2024-11-29',
        end: '2024-11-30',
        frequency: 'day',
        metadataFrequency: 'R/P1D',
        seriesCode: DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
        source: DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.source,
      })), { headers: { 'content-type': 'application/json' }, status: 200 });
    },
  });
  const observations = await provider.fetchRange(
    fxSeries,
    { from: '2024-11-29', to: '2024-11-30' },
    new AbortController().signal,
  );
  assert.equal(requested.url?.origin, 'https://apis.datos.gob.ar');
  assert.equal(requested.url?.pathname, '/series/api/series/');
  assert.equal(requested.url?.searchParams.get('ids'), DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code);
  assert.equal(requested.url?.searchParams.get('limit'), '1000');
  assert.equal(requested.init?.redirect, 'error');
  assert.equal(requested.init?.signal instanceof AbortSignal, true);
  assert.deepEqual(observations.map(({ date, value }) => ({ date, value })), [
    { date: '2024-11-29', value: '1001.125' },
    { date: '2024-11-30', value: '1001.125' },
  ]);
  assert.equal(observations[0]?.seriesCode, fxSeries.code);
  assert.equal(observations[0]?.observedAt, '2026-09-01T12:00:00.000Z');
  assert.equal(observations[0]?.metadataNoSensitive?.license, 'CC BY 4.0');
  assert.match(String(observations[0]?.metadataNoSensitive?.providerPayloadSha256), /^[0-9a-f]{64}$/);
  assert.equal(observations[0]?.metadataNoSensitive?.source, DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.source);
});

test('accepts the fixed monthly IPC series and rejects provider or series drift', async () => {
  const validPayload = responsePayload({
    data: [['2025-01-01', 7864.1257], ['2025-02-01', 8052.9927]],
    start: '2025-01-01',
    end: '2025-02-01',
    frequency: 'month',
    metadataFrequency: 'R/P1M',
    seriesCode: DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
    source: DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.source,
  });
  const provider = new DatosArgentinaProvider({
    fetchImpl: async () => new Response(JSON.stringify(validPayload), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }),
  });
  const observations = await provider.fetchRange(
    cpiSeries,
    { from: '2025-01-01', to: '2025-02-01' },
    new AbortController().signal,
  );
  assert.deepEqual(observations.map(({ value }) => value), ['7864.1257', '8052.9927']);
  await assert.rejects(
    () => provider.fetchRange(
      { ...cpiSeries, externalSeriesId: 'provider-controlled-id' },
      { from: '2025-01-01', to: '2025-02-01' },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof EconomicProviderError
      && error.code === 'ECONOMIC_SERIES_UNSUPPORTED' && error.retryable === false,
  );
});

test('enforces bounded daily/monthly chunks before any provider request', () => {
  assert.doesNotThrow(() => validateProviderRange(
    DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
    '2024-01-01',
    '2024-12-31',
  ));
  assert.throws(() => validateProviderRange(
    DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
    '2024-01-01',
    '2025-01-01',
  ), /ECONOMIC_RANGE_TOO_LARGE/);
  assert.doesNotThrow(() => validateProviderRange(
    DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
    '2016-01-01',
    '2025-12-01',
  ));
  assert.throws(() => validateProviderRange(
    DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
    '2016-01-01',
    '2026-01-01',
  ), /ECONOMIC_RANGE_TOO_LARGE/);
  assert.throws(() => validateProviderRange(
    DATOS_ARGENTINA_SERIES.CPI_AR_NATIONAL.code,
    '2025-01-15',
    '2025-02-01',
  ), /ECONOMIC_RANGE_INVALID/);
});

test('rejects oversized, redirected, malformed and semantically invalid responses', async () => {
  const oversized = new DatosArgentinaProvider({
    fetchImpl: async () => new Response('{}', {
      headers: { 'content-length': String(512 * 1024 + 1), 'content-type': 'application/json' },
      status: 200,
    }),
  });
  await assert.rejects(
    () => oversized.fetchRange(fxSeries, { from: '2024-11-29', to: '2024-11-29' }, new AbortController().signal),
    /ECONOMIC_PROVIDER_BODY_TOO_LARGE/,
  );

  const wrongSource = responsePayload({
    data: [['2024-11-29', -1]],
    start: '2024-11-29',
    end: '2024-11-29',
    frequency: 'day',
    metadataFrequency: 'R/P1D',
    seriesCode: DATOS_ARGENTINA_SERIES.FX_USD_ARS_A3500.code,
    source: 'Untrusted source',
  });
  const invalid = new DatosArgentinaProvider({
    fetchImpl: async () => new Response(JSON.stringify(wrongSource), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }),
  });
  await assert.rejects(
    () => invalid.fetchRange(fxSeries, { from: '2024-11-29', to: '2024-11-29' }, new AbortController().signal),
    /ECONOMIC_PROVIDER_METADATA_INVALID/,
  );

  const unavailable = new DatosArgentinaProvider({
    fetchImpl: async () => new Response('{}', {
      headers: { 'content-type': 'application/json' },
      status: 503,
    }),
  });
  await assert.rejects(
    () => unavailable.fetchRange(fxSeries, { from: '2024-11-29', to: '2024-11-29' }, new AbortController().signal),
    (error: unknown) => error instanceof EconomicProviderError
      && error.code === 'ECONOMIC_PROVIDER_HTTP_ERROR' && error.retryable,
  );
});
