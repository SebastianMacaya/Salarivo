import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEconomicSeries, type EconomicObservation } from '@salarivo/economic-data';

process.env.APP_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:5432/salarivo_test?sslmode=disable';

const {
  ECONOMIC_SERIES_DEFINITIONS,
  cpiReferenceRange,
  dailyObservationCoverageStart,
  economicRefreshRange,
  economicRetryDelay,
  persistEconomicObservationsWithQuery,
  planMissingEconomicRanges,
  selectEconomicObservationRevisions,
} = await import('../src/economic-sync.ts');

test('production series remain generic internally while fixing provider IDs and provenance', () => {
  assert.equal(ECONOMIC_SERIES_DEFINITIONS.length, 2);
  for (const definition of ECONOMIC_SERIES_DEFINITIONS) {
    assert.equal(validateEconomicSeries(definition), definition);
    assert.equal(definition.providerCode, 'DATOS_ARGENTINA');
    assert.equal(definition.metadataNoSensitive.license, 'CC BY 4.0');
    assert.equal(definition.sourceUrl.startsWith('https://www.datos.gob.ar/'), true);
  }
  assert.equal(ECONOMIC_SERIES_DEFINITIONS[0]?.externalSeriesId, '175.1_DR_REFE500_0_0_25');
  assert.equal(ECONOMIC_SERIES_DEFINITIONS[1]?.externalSeriesId, '145.3_INGNACNAL_DICI_M_15');
});

test('daily backfill is gap-aware and never exceeds 366 observations per chunk', () => {
  assert.deepEqual(planMissingEconomicRanges(
    'DAILY',
    { from: '2023-01-01', to: '2024-12-31' },
    [],
  ), [
    { from: '2023-01-01', to: '2024-01-01' },
    { from: '2024-01-02', to: '2024-12-31' },
  ]);
  assert.deepEqual(planMissingEconomicRanges(
    'DAILY',
    { from: '2024-11-28', to: '2024-12-02' },
    ['2024-11-29', '2024-11-30'],
  ), [
    { from: '2024-11-28', to: '2024-11-28' },
    { from: '2024-12-01', to: '2024-12-02' },
  ]);
});

test('daily coverage includes the full previous-observation fallback without crossing series validity', () => {
  assert.equal(dailyObservationCoverageStart('2024-12-01', '2002-03-04'), '2024-11-24');
  assert.equal(dailyObservationCoverageStart('2002-03-05', '2002-03-04'), '2002-03-04');
});

test('monthly backfill uses exact periods and chunks at 120 months', () => {
  assert.deepEqual(planMissingEconomicRanges(
    'MONTHLY',
    { from: '2016-01-01', to: '2026-01-01' },
    [],
  ), [
    { from: '2016-01-01', to: '2025-12-01' },
    { from: '2026-01-01', to: '2026-01-01' },
  ]);
  assert.throws(() => planMissingEconomicRanges(
    'MONTHLY',
    { from: '2025-01-15', to: '2025-02-01' },
    [],
  ), /ECONOMIC_RANGE_INVALID/);
});

test('refreshes only a small overlapping tail and retry backoff remains bounded', () => {
  assert.deepEqual(economicRefreshRange(
    'DAILY',
    { from: '2023-01-01', to: '2024-01-31' },
  ), { from: '2023-12-28', to: '2024-01-31' });
  assert.deepEqual(economicRefreshRange(
    'MONTHLY',
    { from: '2024-01-01', to: '2024-12-01' },
  ), { from: '2024-10-01', to: '2024-12-01' });
  assert.equal(economicRetryDelay(1, 0), 30_000);
  assert.equal(economicRetryDelay(2, 10_000), 70_000);
  assert.equal(economicRetryDelay(100, 10_000), 6 * 60 * 60_000);
  assert.throws(() => economicRetryDelay(0, 0), /ECONOMIC_RETRY_INVALID/);
});

test('extends CPI coverage to the current reference month without inventing an earlier start', () => {
  assert.deepEqual(cpiReferenceRange(
    { from: '2020-04-01', to: '2024-11-01' },
    '2026-09-17',
  ), { from: '2020-04-01', to: '2026-09-01' });
  assert.deepEqual(cpiReferenceRange(
    { from: '2020-04-01', to: '2027-01-01' },
    '2026-09-17',
  ), { from: '2020-04-01', to: '2027-01-01' });
});

const payloadSha256 = 'a'.repeat(64);

function syncedObservation(date: string, value: string): EconomicObservation {
  return {
    seriesCode: ECONOMIC_SERIES_DEFINITIONS[0].code,
    date,
    value,
    observedAt: '2026-09-01T12:00:00.000Z',
    metadataNoSensitive: { providerPayloadSha256: payloadSha256 },
  };
}

test('creates append-only revisions only when the numeric provider value changes', () => {
  const revisions = selectEconomicObservationRevisions([
    syncedObservation('2024-11-01', '100'),
    syncedObservation('2024-12-01', '201.5'),
    syncedObservation('2025-01-01', '220'),
  ], [
    { observationDate: '2024-11-01', value: '100.000000000000', revision: 1 },
    { observationDate: '2024-12-01', value: '200.000000000000', revision: 2 },
  ]);
  assert.deepEqual(revisions.map(({ observation_date, revision, value }) => ({
    observation_date,
    revision,
    value,
  })), [
    { observation_date: '2024-12-01', revision: 3, value: '201.5' },
    { observation_date: '2025-01-01', revision: 1, value: '220' },
  ]);
  assert.equal(revisions.every(({ provider_payload_sha256 }) => provider_payload_sha256 === payloadSha256), true);
});

test('refuses persistence after losing the lease and persists payload hash under an owned lease', async () => {
  const series = { ...ECONOMIC_SERIES_DEFINITIONS[0], id: '00000000-0000-4000-8000-000000000001' };
  const job = {
    attempt: 1,
    id: '00000000-0000-4000-8000-000000000002',
    leaseOwner: 'economic:test-worker',
    maxAttempts: 5,
    range: { from: '2024-11-01', to: '2024-11-01' },
    series,
  };
  await assert.rejects(
    () => persistEconomicObservationsWithQuery(
      async () => ({ rowCount: 0, rows: [] }),
      job,
      [syncedObservation('2024-11-01', '100')],
    ),
    /ECONOMIC_SYNC_LEASE_LOST/,
  );

  let insertPayload: string | null = null;
  const queries: string[] = [];
  const inserted = await persistEconomicObservationsWithQuery(async (sql, values = []) => {
    queries.push(sql);
    if (sql.includes('SELECT DISTINCT ON')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO economic_observations')) {
      insertPayload = String(values[1]);
      return { rowCount: 1, rows: [{ id: 'synthetic' }] };
    }
    return { rowCount: 1, rows: [{}] };
  }, job, [syncedObservation('2024-11-01', '100')]);
  assert.equal(inserted, 1);
  assert.equal(queries[0]?.includes('lease_expires_at > now()'), true);
  assert.equal(queries.at(-1)?.includes("state = 'COMPLETED'"), true);
  assert.match(insertPayload ?? '', new RegExp(payloadSha256));
});
