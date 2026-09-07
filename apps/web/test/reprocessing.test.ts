import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisPresentation,
  batchIsActive,
  batchResolved,
  batchWasDismissed,
  compatiblePromotionLabel,
  processingRunDecisionPayload,
  issueLabel,
  processingHealthPage,
  processingHealthPagination,
  runNeedsDecision,
  runOutcomeLabel,
  shouldHydrateActiveBatch,
  triggerLabel,
  type DocumentAnalysis,
  type ReprocessingBatch,
} from '../app/reprocessing.ts';

function analysis(overrides: Partial<DocumentAnalysis> = {}): DocumentAnalysis {
  return {
    status: 'COMPLETED',
    activeRunId: '11111111-1111-4111-8111-111111111111',
    currentRun: null,
    issues: [],
    reprocess: { available: false, inProgress: false, latestOutcome: null },
    ...overrides,
  };
}

test('prioriza una mejora disponible sobre el PROMOTED histórico del backfill', () => {
  const copy = analysisPresentation(analysis({
    reprocess: { available: true, inProgress: false, latestOutcome: 'PROMOTED' },
  }));
  assert.equal(copy.title, 'Hay una mejora disponible');
});

test('distingue procesamiento, revisión, fallo, sin cambios y análisis parcial', () => {
  assert.equal(analysisPresentation(analysis({ reprocess: { available: false, inProgress: true, latestOutcome: null } })).title, 'Buscando una mejora');
  assert.equal(analysisPresentation(analysis({ status: 'REVIEW_REQUIRED' })).title, 'Nueva lectura para confirmar');
  assert.equal(analysisPresentation(analysis({ status: 'FAILED' })).title, 'La mejora no pudo completarse');
  assert.equal(analysisPresentation(analysis({ reprocess: { available: false, inProgress: false, latestOutcome: 'UNCHANGED' } })).title, 'Análisis actualizado');
  assert.equal(analysisPresentation(analysis({ status: 'REVIEW_REQUIRED', reprocess: { available: false, inProgress: false, latestOutcome: 'REJECTED_REGRESSION' } })).title, 'Se conservó el mejor resultado');
  assert.equal(analysisPresentation(analysis({ status: 'REVIEW_REQUIRED', reprocess: { available: false, inProgress: false, latestOutcome: 'PROMOTED' } })).title, 'Mejora aplicada, revisión pendiente');
  assert.equal(analysisPresentation(analysis({ status: 'COMPLETED_WITH_WARNINGS' })).title, 'Análisis con observaciones');
});

test('resume el lote incluyendo resultados conservados', () => {
  const batch: ReprocessingBatch = {
    id: '22222222-2222-4222-8222-222222222222', status: 'PARTIAL', triggerKind: 'USER_REPROCESS',
    createdAt: null, updatedAt: null, completedAt: null,
    progress: { total: 8, queued: 0, processing: 0, improved: 2, unchanged: 1, reviewRequired: 1, failed: 1, skipped: 3 },
  };
  assert.equal(batchIsActive(batch), false);
  assert.equal(batchResolved(batch), 8);
  assert.equal(batchIsActive({ ...batch, status: 'RUNNING' }), true);
  assert.equal(batchWasDismissed(batch, batch.id), true);
  assert.equal(batchWasDismissed({ ...batch, status: 'RUNNING' }, batch.id), false);
  assert.equal(batchWasDismissed(batch, null), false);
});

test('recupera el lote activo sólo ante el conflicto esperado', () => {
  assert.equal(shouldHydrateActiveBatch('REPROCESSING_BATCH_ALREADY_ACTIVE'), true);
  assert.equal(shouldHydrateActiveBatch('NO_REPROCESSING_CANDIDATES'), false);
});

test('ofrece alcance compatible sólo cuando hay más de un recibo', () => {
  assert.equal(compatiblePromotionLabel(1), null);
  assert.equal(compatiblePromotionLabel(4), 'Aplicar el mismo cambio en 4 recibos');
  assert.deepEqual(processingRunDecisionPayload('PROMOTE', 'COMPATIBLE', 'active-run', 4), {
    decision: 'PROMOTE', scope: 'COMPATIBLE', expectedActiveRunId: 'active-run', expectedCompatiblePromotionCount: 4,
  });
  assert.deepEqual(processingRunDecisionPayload('PROMOTE', 'DOCUMENT', 'active-run', 4), {
    decision: 'PROMOTE', expectedActiveRunId: 'active-run',
  });
});

test('pagina juntas las versiones e issues de health hasta cubrir la lista más larga', () => {
  assert.equal(processingHealthPage('2'), 2);
  assert.equal(processingHealthPage('0'), 1);
  assert.equal(processingHealthPage('not-a-page'), 1);
  assert.deepEqual(
    processingHealthPagination(
      { page: 2, pageSize: 25, total: 26 },
      { page: 2, pageSize: 25, total: 51 },
    ),
    { page: 2, pages: 3, hasPrevious: true, hasNext: true },
  );
  assert.deepEqual(
    processingHealthPagination(
      { page: 3, pageSize: 25, total: 26 },
      { page: 3, pageSize: 25, total: 51 },
    ),
    { page: 3, pages: 3, hasPrevious: true, hasNext: false },
  );
});

test('traduce issues y outcomes sin mostrar códigos internos al owner', () => {
  assert.equal(issueLabel({ affectedFieldPath: 'settlement.basicAmount' }), 'No pudimos identificar el sueldo básico de este recibo.');
  assert.equal(issueLabel({ code: 'COUNTRY_UNCONFIRMED', affectedFieldPath: null }), 'Confirmá el país del empleo y asociá este documento.');
  assert.equal(analysisPresentation(analysis({ issues: [{ code: 'COUNTRY_EMPLOYMENT_CONFLICT', affectedFieldPath: null, severity: 'ERROR' }] })).title, 'Jurisdicción para revisar');
  assert.notEqual(analysisPresentation(analysis({ issues: [{ code: 'COUNTRY_DETECTION_OVERRIDDEN', affectedFieldPath: null, severity: 'INFO' }] })).title, 'Jurisdicción para revisar');
  assert.equal(runOutcomeLabel('REJECTED_REGRESSION'), 'Se conservó la versión anterior');
  assert.equal(runNeedsDecision({ decisionRequired: true }), true);
  assert.equal(runNeedsDecision({ decisionRequired: false }), false);
  assert.equal(triggerLabel('LEGACY_UNKNOWN'), 'Análisis anterior');
  assert.equal(triggerLabel('USER_TYPE_CONFIRMATION'), 'Confirmación del tipo de documento');
});
