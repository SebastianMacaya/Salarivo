export type ProcessingIssue = {
  id?: string;
  code: string;
  severity: string;
  recoverable?: boolean;
  affectedFieldPath: string | null;
  message?: string;
  createdAt?: string | null;
};

export type ProcessingRun = {
  id: string;
  processingVersion: number;
  status: string;
  triggerKind: string;
  parserVersion: string;
  resultSchemaVersion: string | null;
  pipelineFingerprint: string | null;
  promotionOutcome: string;
  comparisonSummary?: Record<string, unknown>;
  promotedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  active: boolean;
  decisionRequired: boolean;
};

export type ProcessingComparisonPreview = {
  baseRunId: string;
  candidateRunId: string;
  fields: Array<{
    fieldPath: string;
    before: string | null;
    after: string | null;
    change: 'UNCHANGED' | 'ADDED' | 'REMOVED' | 'CHANGED';
  }>;
  lineItems: { beforeCount: number; afterCount: number; changed: boolean };
};

export type ProcessingRunDetail = ProcessingRun & {
  issues: ProcessingIssue[];
  comparisonPreview: ProcessingComparisonPreview | null;
};

export type DocumentAnalysis = {
  status: string;
  activeRunId: string | null;
  currentRun: ProcessingRun | null;
  issues: ProcessingIssue[];
  reprocess: { available: boolean; retryAvailable?: boolean; inProgress: boolean; latestOutcome: string | null };
};

export type ReprocessingCandidate = {
  documentId: string;
  activeRunId: string;
  activeProcessingVersion: number;
  parserVersion: string;
  pipelineFingerprint: string | null;
  inProgress: boolean;
  available: boolean;
  message: string;
  issues: ProcessingIssue[];
};

export type ReprocessingBatch = {
  id: string;
  status: string;
  triggerKind: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  progress: {
    total: number;
    queued: number;
    processing: number;
    improved: number;
    unchanged: number;
    reviewRequired: number;
    failed: number;
    skipped: number;
  };
};

export function analysisPresentation(analysis: DocumentAnalysis) {
  if (analysis.reprocess.inProgress || ['RUNNING', 'PROCESSING'].includes(analysis.status)) {
    return { tone: 'pending', title: 'Buscando una mejora', body: 'La versión activa sigue disponible mientras analizamos y comparamos el nuevo resultado.' };
  }
  if (analysis.status === 'FAILED' || analysis.reprocess.latestOutcome === 'FAILED') {
    return { tone: 'danger', title: 'La mejora no pudo completarse', body: analysis.activeRunId ? 'Conservamos intacta la versión que ya estaba activa.' : 'El intento falló sin reemplazar ningún resultado anterior.' };
  }
  if (analysis.status === 'CANCELLED' || analysis.reprocess.latestOutcome === 'CANCELLED') {
    return { tone: 'warning', title: 'Análisis cancelado', body: analysis.activeRunId ? 'La versión activa se conservó sin cambios.' : 'El intento quedó cancelado y se puede reintentar cuando esté disponible.' };
  }
  if (analysis.reprocess.latestOutcome === 'REJECTED_REGRESSION') {
    return { tone: 'warning', title: 'Se conservó el mejor resultado', body: 'La versión nueva era menos completa o fue descartada y no reemplazó al análisis activo.' };
  }
  if (analysis.reprocess.available) {
    return { tone: 'improvement', title: 'Hay una mejora disponible', body: 'Una versión nueva puede volver a buscar los datos que faltan.' };
  }
  if (analysis.reprocess.latestOutcome === 'PROMOTED') {
    return analysis.status === 'REVIEW_REQUIRED'
      ? { tone: 'warning', title: 'Mejora aplicada, revisión pendiente', body: 'El resultado nuevo quedó activo, pero necesita revisión antes de volver a incluirlo en las estadísticas.' }
      : { tone: 'ready', title: 'Mejora aplicada', body: 'La comparación confirmó un resultado mejor y quedó activo.' };
  }
  if (analysis.status === 'REVIEW_REQUIRED' || analysis.reprocess.latestOutcome === 'REVIEW_REQUIRED') {
    return { tone: 'warning', title: 'Hay una mejora para revisar', body: 'El resultado nuevo no reemplazó al activo y necesita una decisión.' };
  }
  if (analysis.reprocess.latestOutcome === 'UNCHANGED') {
    return { tone: 'ready', title: 'Análisis actualizado', body: 'La versión nueva no cambió los datos útiles; conservamos el resultado activo.' };
  }
  if (analysis.status === 'COMPLETED_WITH_WARNINGS' || analysis.issues.length) {
    return { tone: 'warning', title: 'Análisis con observaciones', body: 'El recibo se puede usar, pero algunos datos no pudieron identificarse.' };
  }
  if (analysis.status === 'UNAVAILABLE') {
    return { tone: 'danger', title: 'Análisis no disponible', body: 'Todavía no hay un resultado estructurado para este documento.' };
  }
  return { tone: 'ready', title: 'Análisis completo', body: 'Este es el resultado activo del documento.' };
}

export function issueLabel(issue: Pick<ProcessingIssue, 'affectedFieldPath' | 'message'>) {
  if (issue.message) return issue.message;
  if (issue.affectedFieldPath === 'settlement.basicAmount') return 'No pudimos identificar el sueldo básico de este recibo.';
  return 'Hay un dato del recibo que no pudimos identificar.';
}

export function batchIsActive(batch: ReprocessingBatch | null) {
  return batch !== null && ['PENDING', 'RUNNING'].includes(batch.status);
}

export function batchResolved(batch: ReprocessingBatch) {
  const { improved, unchanged, reviewRequired, failed, skipped } = batch.progress;
  return improved + unchanged + reviewRequired + failed + skipped;
}

export function batchWasDismissed(batch: ReprocessingBatch | null, dismissedBatchId: string | null) {
  return batch !== null && !batchIsActive(batch) && batch.id === dismissedBatchId;
}

export function shouldHydrateActiveBatch(errorCode: string) {
  return errorCode === 'REPROCESSING_BATCH_ALREADY_ACTIVE';
}

export function processingHealthPage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 1_000 ? page : 1;
}

export function processingHealthPagination(
  versions: { page: number; pageSize: number; total: number },
  issues: { page: number; pageSize: number; total: number },
) {
  const page = versions.page;
  const pages = Math.max(
    1,
    Math.ceil(versions.total / Math.max(1, versions.pageSize)),
    Math.ceil(issues.total / Math.max(1, issues.pageSize)),
  );
  return { page, pages, hasPrevious: page > 1, hasNext: page < pages };
}

export function runNeedsDecision(run: Pick<ProcessingRun, 'decisionRequired'>) {
  return run.decisionRequired;
}

export function runOutcomeLabel(outcome: string) {
  return ({
    NOT_EVALUATED: 'Pendiente de comparación',
    PROMOTED: 'Mejora aplicada',
    UNCHANGED: 'Sin cambios útiles',
    REVIEW_REQUIRED: 'Requiere revisión',
    REJECTED_REGRESSION: 'Se conservó la versión anterior',
  } as Record<string, string>)[outcome] ?? outcome.replaceAll('_', ' ').toLowerCase();
}

export function triggerLabel(trigger: string) {
  return ({
    LEGACY_UNKNOWN: 'Análisis anterior',
    INITIAL_UPLOAD: 'Carga inicial',
    USER_TYPE_CONFIRMATION: 'Confirmación del tipo de documento',
    USER_REPROCESS: 'Solicitado por vos',
    ADMIN_REPROCESS: 'Recuperación operativa',
    PARSER_UPGRADE: 'Actualización del analizador',
    AUTOMATIC_RECOVERY: 'Recuperación automática',
  } as Record<string, string>)[trigger] ?? trigger.replaceAll('_', ' ').toLowerCase();
}
