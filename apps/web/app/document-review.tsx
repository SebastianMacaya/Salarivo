'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { evidenceIdForPage, extractionRunChanged, reviewValueChanged } from './document-evidence';
import { DocumentViewer } from './document-viewer';
import { documentStatusLabel, money, periodLabel, settlementTypeLabel, timestampLabel } from './format';
import {
  analysisPresentation,
  issueLabel,
  runNeedsDecision,
  runOutcomeLabel,
  triggerLabel,
  type DocumentAnalysis,
  type ProcessingComparisonPreview,
  type ProcessingRun,
} from './reprocessing';
import styles from './document-review.module.css';

export type ExtractedFieldDetail = {
  confidence: string;
  correctedValue: string | null;
  correction: null | { correctedAt: string; id: string; version: number };
  effectiveValue: string | null;
  extractorVersion: string | null;
  fieldPath: string;
  id: string | null;
  interpretedValue: string | null;
  missingReason?: 'LABEL_OR_LAYOUT_NOT_RECOGNIZED' | 'VALUE_NOT_INTERPRETABLE';
  pageNumber: number | null;
  rawValue: string | null;
  source: string;
  sourceRegion: unknown;
};

export type DocumentDetail = {
  analysis?: DocumentAnalysis;
  classificationStatus: string | null;
  confidence: string | null;
  createdAt: string;
  declaredMimeType: string;
  detectedMimeType: string | null;
  displayFilename?: string;
  documentType: string | null;
  errorCode: string | null;
  extractedFields: ExtractedFieldDetail[];
  extractionRun: null | {
    confidence: string | null;
    extractorName: string;
    extractorVersion: string;
    finishedAt: string | null;
    id: string;
    normalizerVersion: string;
    ocrProvider: string | null;
    ocrVersion: string | null;
    parserVersion: string;
    processingVersion: number;
  };
  id: string;
  lineItems: Array<{
    amount: string;
    confidence: string | null;
    currencyCode: string;
    id: string;
    isRecurring: boolean | null;
    itemOrdinal: number;
    itemType: string;
    normalizedConceptCode: string | null;
    rawDescription: string;
    sourcePage: number | null;
  }>;
  needsReview: boolean;
  lastReprocessError: null | { code: string; failedAt: string; processingVersion: number };
  originalAvailable: boolean;
  originalFilename: string;
  pageCount: number | null;
  processedAt: string | null;
  processingStatus: string;
  reviewSettlement: ReviewSettlement | null;
  retentionPolicy: string;
  securityStatus: string;
  settlement: null | {
    basicAmount?: string | null;
    currencyCode: string;
    deductionsAmount?: string | null;
    deductionsChargedAmount?: string | null;
    grossAmount?: string | null;
    netAmount?: string | null;
    nonRemunerativeAmount?: string | null;
    payrollPeriod: string;
    reimbursementsAmount?: string | null;
    remunerativeAmount?: string | null;
    settlementType: string;
  };
  sizeBytes: number;
};

export type ReviewSettlement = {
  componentsBalance?: boolean;
  deductionsMatchTotal?: boolean;
  totalsBalance?: boolean;
};

const labels: Record<string, string> = {
  'employer.name': 'Empresa detectada',
  'settlement.type': 'Tipo de liquidación',
  'settlement.payrollPeriod': 'Período',
  'settlement.basicAmount': 'Sueldo básico',
  'settlement.grossAmount': 'Bruto',
  'settlement.remunerativeAmount': 'Remunerativo',
  'settlement.nonRemunerativeAmount': 'No remunerativo',
  'settlement.deductionsAmount': 'Descuentos',
  'settlement.netAmount': 'Neto',
};
const editable = new Set(Object.keys(labels));
const settlementTypes = [
  'NORMAL', 'SAC', 'VACACIONES', 'BONO', 'RETROACTIVO', 'COMISION', 'HORAS_EXTRA',
  'LIQUIDACION_FINAL', 'INDEMNIZACION', 'AJUSTE', 'REINTEGRO', 'OTRO_LABORAL',
];
const missingReasons = {
  LABEL_OR_LAYOUT_NOT_RECOGNIZED: 'No reconocimos la etiqueta o la ubicación del dato.',
  VALUE_NOT_INTERPRETABLE: 'Reconocimos el campo, pero no pudimos interpretar el valor.',
};
const comparisonLabels: Record<string, string> = { ...labels, 'settlement.currencyCode': 'Moneda' };

function filename(detail: DocumentDetail) { return detail.displayFilename || detail.originalFilename; }
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function savedValue(field: ExtractedFieldDetail) {
  return field.effectiveValue ?? field.correctedValue ?? field.interpretedValue ?? '';
}
function provenance(field: ExtractedFieldDetail) {
  if (field.correction || field.correctedValue !== null) return 'Corregido por vos';
  if (field.source === 'RULE') return 'Calculado';
  if (field.source === 'OCR') return 'Detectado por OCR';
  if (field.source === 'PDF_TEXT') return 'Detectado en el PDF';
  if (field.source === 'MANUAL_REQUIRED') return 'Requiere carga manual';
  return field.source;
}
function comparisonValue(preview: ProcessingComparisonPreview, fieldPath: string, value: string | null, side: 'before' | 'after') {
  if (value === null) return 'No disponible';
  if (fieldPath === 'settlement.payrollPeriod') return periodLabel(value);
  if (fieldPath === 'settlement.type') return settlementTypeLabel(value);
  if (fieldPath.includes('Amount')) {
    const currency = preview.fields.find((field) => field.fieldPath === 'settlement.currencyCode')?.[side] ?? 'ARS';
    return money(value, currency);
  }
  return value;
}

function handleReviewKey(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.key === 'Escape') {
    if (document.fullscreenElement) return;
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
  )).filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function DocumentReview({
  detail,
  initialEvidenceId,
  initialPage = 1,
  position,
  settlement,
  source,
  sourceBusy,
  sourceError,
  navigationBusy = false,
  navigationError,
  onAuthorizePreview,
  onClose,
  onCompleteReview,
  onConfirmType,
  onDeleteDocument,
  onDeleteOriginal,
  onDownload,
  onBusyChange,
  onDirtyChange,
  onLocationChange,
  onNavigate,
  onReprocess,
  onRunDecision,
  onSave,
  processingRuns = [],
  runPreviewErrors = {},
  runPreviews = {},
  runsError = '',
  runsLoading = false,
}: {
  detail: DocumentDetail;
  initialEvidenceId?: string;
  initialPage?: number;
  position: { canNext?: boolean; current: number | null; total: number };
  settlement?: ReviewSettlement;
  source: { expiresAt?: string; url: string } | null;
  sourceBusy: boolean;
  sourceError?: string;
  navigationBusy?: boolean;
  navigationError?: string;
  onAuthorizePreview: () => void;
  onClose: () => void;
  onCompleteReview: (acceptDeductionsMismatch: boolean, extractionRunId: string) => Promise<void>;
  onConfirmType: (type: 'PAYROLL' | 'UNSUPPORTED') => Promise<void>;
  onDeleteDocument: () => Promise<void>;
  onDeleteOriginal: () => Promise<void>;
  onDownload: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onLocationChange: (page: number, evidenceId?: string) => void;
  onNavigate: (direction: -1 | 1) => void;
  onReprocess: (retry?: boolean) => Promise<void>;
  onRunDecision: (run: ProcessingRun, decision: 'PROMOTE' | 'KEEP_ACTIVE') => Promise<void>;
  onSave: (changes: Array<{ field: ExtractedFieldDetail; value: string }>, extractionRunId: string) => Promise<void>;
  processingRuns?: ProcessingRun[];
  runPreviewErrors?: Record<string, string>;
  runPreviews?: Record<string, ProcessingComparisonPreview | null | undefined>;
  runsError?: string;
  runsLoading?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(
    evidenceIdForPage(initialEvidenceId, initialPage, detail.extractedFields),
  );
  const [mobileTab, setMobileTab] = useState<'data' | 'document'>('document');
  const [acceptedMismatchRunId, setAcceptedMismatchRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pendingMobileFocus = useRef<'data' | 'document' | null>(null);

  const changes = useMemo(() => detail.extractedFields.flatMap((field) => {
    const draft = drafts[field.fieldPath] ?? savedValue(field);
    return editable.has(field.fieldPath) && reviewValueChanged(field.fieldPath, draft, savedValue(field))
      ? [{ field, value: draft }]
      : [];
  }), [detail.extractedFields, drafts]);
  const dirty = changes.length > 0;
  const currentRunId = detail.extractionRun?.id ?? null;
  const acceptMismatch = acceptedMismatchRunId === currentRunId;
  const editingStale = editing && extractionRunChanged(editingRunId, currentRunId);
  const missing = detail.extractedFields.filter((field) => field.source === 'MANUAL_REQUIRED' && !savedValue(field));
  const analysis = detail.analysis;
  const analysisCopy = analysis ? analysisPresentation(analysis) : null;
  const runTimeline = processingRuns.length ? processingRuns : analysis?.currentRun ? [analysis.currentRun] : [];

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  useEffect(() => { onLocationChange(page, selectedEvidenceId); }, [onLocationChange, page, selectedEvidenceId]);
  useEffect(() => {
    if (mobileTab === 'data' && selectedEvidenceId) {
      document.getElementById(`field-${selectedEvidenceId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [mobileTab, selectedEvidenceId]);
  useEffect(() => {
    const target = pendingMobileFocus.current;
    if (target !== mobileTab || !window.matchMedia('(max-width: 760px), (max-height: 500px) and (orientation: landscape)').matches) return;
    pendingMobileFocus.current = null;
    const frame = window.requestAnimationFrame(() => {
      const element = target === 'data' && selectedEvidenceId
        ? document.getElementById(`field-${selectedEvidenceId}`)
        : document.getElementById('review-document-panel');
      element?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobileTab, selectedEvidenceId]);

  function confirmDiscard() { return !dirty || window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?'); }
  function close() { if (!busy && confirmDiscard()) onClose(); }
  function navigate(direction: -1 | 1) { if (confirmDiscard()) onNavigate(direction); }
  async function run(action: () => Promise<void>, onFailure?: () => void) {
    setBusy(true); setError('');
    try { await action(); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos completar la operación.');
      onFailure?.();
    }
    finally { setBusy(false); }
  }
  function selectEvidence(id: string) {
    pendingMobileFocus.current = 'data';
    setSelectedEvidenceId(id);
    setMobileTab('data');
  }
  function showSource(field: ExtractedFieldDetail) {
    if (!field.id || !field.pageNumber) return;
    pendingMobileFocus.current = 'document';
    setSelectedEvidenceId(field.id);
    setPage(field.pageNumber);
    setMobileTab('document');
  }
  function moveMobileTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % 2
      : event.key === 'ArrowLeft' ? (index + 1) % 2
        : event.key === 'Home' ? 0
          : event.key === 'End' ? 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = nextIndex === 0 ? 'document' : 'data';
    setMobileTab(next);
    document.getElementById(`review-tab-${next}`)?.focus();
  }
  function changePage(nextPage: number) {
    setPage(nextPage);
    setSelectedEvidenceId((current) => evidenceIdForPage(current, nextPage, detail.extractedFields));
  }

  const reviewBlocked = missing.length > 0 || settlement?.totalsBalance === false
    || settlement?.componentsBalance === false
    || (settlement?.deductionsMatchTotal === false && !acceptMismatch);
  const canDeleteOriginal = detail.originalAvailable
    && ['COMPLETED', 'NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION', 'REJECTED_UNSUPPORTED', 'QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED'].includes(detail.processingStatus);
  const canEdit = ['COMPLETED', 'NEEDS_REVIEW'].includes(detail.processingStatus) && currentRunId !== null;
  const originalViewable = detail.originalAvailable && detail.securityStatus === 'CLEAN';
  const unsupported = detail.documentType === 'UNSUPPORTED' || detail.processingStatus === 'REJECTED_UNSUPPORTED';
  const unsupportedReason = detail.errorCode === 'DOCUMENT_UNSUPPORTED'
    ? 'Salarivo detectó que este PDF no parece ser un recibo de sueldo, aguinaldo ni otro documento salarial compatible.'
    : 'Este PDF fue confirmado como un tipo de documento que Salarivo todavía no procesa.';

  return (
    <div className={styles.layer} role="presentation">
      <section className={styles.workspace} role="dialog" aria-modal="true" aria-labelledby="review-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleReviewKey(event, close)}>
        <header className={styles.header}>
          <div className={styles.heading}><span className={styles.fileIcon}>PDF</span><div><p>{position.current === null ? 'Documento fuera del listado actual' : `Documento ${position.current} de ${position.total}`}</p><h2 id="review-title" title={detail.originalFilename}>{filename(detail)}</h2></div></div>
          <nav aria-label="Navegar documentos"><button type="button" onClick={() => navigate(-1)} disabled={busy || navigationBusy || position.current === null || position.current <= 1} aria-label="Documento anterior">‹</button><button type="button" onClick={() => navigate(1)} disabled={busy || navigationBusy || position.current === null || position.canNext === false || (position.canNext === undefined && position.current >= position.total)} aria-label="Documento siguiente">›</button></nav>
          <button className={styles.close} type="button" onClick={close} disabled={busy} aria-label="Cerrar revisión">×</button>
        </header>

        {navigationError && <p className={styles.error} role="alert">{navigationError} <button type="button" className="text-button" disabled={busy || navigationBusy} onClick={() => navigate(1)}>Reintentar</button></p>}

        <nav className={styles.mobileTabs} aria-label="Vista del documento"><button type="button" id="review-tab-document" aria-controls="review-document-panel" aria-pressed={mobileTab === 'document'} onKeyDown={(event) => moveMobileTab(event, 0)} onClick={() => setMobileTab('document')}>Documento</button><button type="button" id="review-tab-data" aria-controls="review-data-panel" aria-pressed={mobileTab === 'data'} onKeyDown={(event) => moveMobileTab(event, 1)} onClick={() => setMobileTab('data')}>Datos</button></nav>

        <div className={styles.body}>
          <div id="review-document-panel" role="region" aria-label="Documento" tabIndex={-1} className={`${styles.documentPane}${mobileTab === 'data' ? ` ${styles.mobileHidden}` : ''}`}>
            <DocumentViewer
              evidence={detail.extractedFields.map((field) => ({ id: field.id, fieldPath: field.fieldPath, label: labels[field.fieldPath] ?? field.fieldPath, pageNumber: field.pageNumber, sourceRegion: field.sourceRegion }))}
              originalAvailable={detail.originalAvailable}
              originalViewable={originalViewable}
              page={page}
              selectedEvidenceId={selectedEvidenceId}
              source={originalViewable ? source : null}
              sourceBusy={sourceBusy}
              sourceError={sourceError}
              onAuthorize={onAuthorizePreview}
              onDownload={() => void run(onDownload, () => setMobileTab('data'))}
              onEvidenceSelect={selectEvidence}
              onPageChange={changePage}
            />
          </div>

          <aside id="review-data-panel" tabIndex={-1} className={`${styles.dataPane}${mobileTab === 'document' ? ` ${styles.mobileHidden}` : ''}`} aria-label="Datos extraídos">
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.summary}><span>{documentStatusLabel(detail.processingStatus)}</span><p>{unsupported ? 'El documento quedó separado del historial salarial.' : detail.errorCode ? 'El procesamiento terminó con un error controlado.' : detail.lastReprocessError ? 'El último reprocesamiento no pudo completarse; conservamos la versión anterior.' : missing.length ? `Falta completar: ${missing.map((field) => labels[field.fieldPath] ?? field.fieldPath).join(', ')}.` : settlement?.totalsBalance === false ? 'Bruto menos descuentos no coincide con neto.' : settlement?.componentsBalance === false ? 'Remunerativo más no remunerativo no coincide con el bruto.' : settlement?.deductionsMatchTotal === false ? 'El desglose no coincide con el total.' : 'Los cambios humanos quedan versionados y no se reemplazan en silencio.'}</p></div>

            {analysis && analysisCopy && <section className={`${styles.analysis} ${styles[analysisCopy.tone]}`} aria-live="polite" aria-busy={analysis.reprocess.inProgress}>
              <div className={styles.analysisHead}><div><span aria-hidden="true">{analysisCopy.tone === 'ready' ? '✓' : analysisCopy.tone === 'danger' ? '!' : '↻'}</span><h3>{analysisCopy.title}</h3></div>{analysis.reprocess.inProgress && <span className={styles.pulse}>Procesando</span>}</div>
              <p>{analysisCopy.body}</p>
              {analysis.issues.length > 0 && <ul>{analysis.issues.map((issue) => <li key={issue.id ?? `${issue.code}-${issue.affectedFieldPath}`}>{issueLabel(issue)}{issue.recoverable && <small> Se puede volver a analizar.</small>}</li>)}</ul>}
              {(analysis.reprocess.available || analysis.reprocess.retryAvailable || analysis.reprocess.inProgress) && <p className={styles.preserved}>{analysis.activeRunId ? 'Tu análisis activo no se pierde durante el reprocesamiento.' : 'El reintento crea una versión nueva sin borrar el historial técnico.'}</p>}
              {(analysis.reprocess.available || analysis.reprocess.retryAvailable) && <button type="button" disabled={busy || dirty || analysis.reprocess.inProgress} onClick={() => void run(() => onReprocess(analysis.reprocess.retryAvailable === true))}>{busy ? 'Iniciando…' : analysis.reprocess.retryAvailable ? 'Reintentar análisis' : 'Buscar mejora'}</button>}
            </section>}

            {detail.processingStatus === 'NEEDS_TYPE_CONFIRMATION' && <section className={styles.callout}><h3>¿Es un recibo de sueldo?</h3><p>La clasificación automática no fue concluyente.</p><div><button type="button" disabled={busy} onClick={() => void run(() => onConfirmType('PAYROLL'))}>Sí, continuar</button><button type="button" disabled={busy} onClick={() => void run(() => onConfirmType('UNSUPPORTED'))}>No corresponde</button></div></section>}
            {unsupported && <section className={styles.callout}><h3>Tipo de documento no soportado</h3><p>{unsupportedReason} No volveremos a procesarlo automáticamente.</p></section>}

            {detail.settlement && <section className={styles.section}><p>Liquidación extraída</p><h3>{periodLabel(detail.settlement.payrollPeriod)} · {settlementTypeLabel(detail.settlement.settlementType)}</h3><dl className={styles.settlementOverview}><div><dt>Sueldo básico</dt><dd>{money(detail.settlement.basicAmount, detail.settlement.currencyCode)}</dd></div><div><dt>Bruto</dt><dd>{money(detail.settlement.grossAmount, detail.settlement.currencyCode)}</dd></div><div><dt>Remunerativo</dt><dd>{money(detail.settlement.remunerativeAmount, detail.settlement.currencyCode)}</dd></div><div><dt>No remunerativo</dt><dd>{money(detail.settlement.nonRemunerativeAmount, detail.settlement.currencyCode)}</dd></div><div><dt>Neto</dt><dd>{money(detail.settlement.netAmount, detail.settlement.currencyCode)}</dd></div><div><dt>Descuentos / créditos</dt><dd>{money(detail.settlement.deductionsAmount, detail.settlement.currencyCode)}</dd></div>{detail.settlement.deductionsChargedAmount && <div><dt>Descuentos cobrados</dt><dd>{money(detail.settlement.deductionsChargedAmount, detail.settlement.currencyCode)}</dd></div>}{detail.settlement.reimbursementsAmount && <div><dt>Reintegros</dt><dd>{money(detail.settlement.reimbursementsAmount, detail.settlement.currencyCode)}</dd></div>}</dl></section>}

            <section className={styles.section}>
              <div className={styles.sectionHead}><div><p>Extracción</p><h3>Campos detectados</h3></div>{!editing ? <button type="button" disabled={busy || !canEdit} onClick={() => { setEditingRunId(currentRunId); setEditing(true); }}>Editar</button> : <span>Modo edición</span>}</div>
              <div className={styles.fields}>{detail.extractedFields.map((field) => {
                const value = drafts[field.fieldPath] ?? savedValue(field);
                const confidence = Number(field.confidence);
                const percent = Math.round(confidence * 100);
                const isEditable = editable.has(field.fieldPath);
                const editor = field.fieldPath === 'settlement.type'
                  ? <select disabled={!editing || !isEditable} value={value} onChange={(event) => setDrafts((current) => ({ ...current, [field.fieldPath]: event.target.value }))}>{settlementTypes.map((type) => <option key={type}>{type}</option>)}</select>
                  : <input disabled={!editing || !isEditable} type={field.fieldPath === 'settlement.payrollPeriod' ? 'month' : 'text'} inputMode={field.fieldPath.includes('Amount') ? 'decimal' : undefined} value={value} onChange={(event) => setDrafts((current) => ({ ...current, [field.fieldPath]: event.target.value }))} />;
                return <article id={field.id ? `field-${field.id}` : undefined} tabIndex={-1} key={field.fieldPath} className={`${styles.field}${selectedEvidenceId === field.id ? ` ${styles.selectedField}` : ''}`} onMouseEnter={() => { if (field.id && field.pageNumber === page) setSelectedEvidenceId(field.id); }}>
                  <label><span>{labels[field.fieldPath] ?? field.fieldPath}</span>{editor}</label>
                  <div className={styles.provenance}><span>{provenance(field)}</span>{field.source !== 'MANUAL_REQUIRED' && Number.isFinite(percent) && confidence < .9 && <strong className={confidence < .7 ? styles.low : ''}>{confidence < .7 ? 'Confianza baja' : 'Confianza media'} · {percent}%</strong>}{field.pageNumber && <button type="button" onClick={() => showSource(field)}>Ver fuente · pág. {field.pageNumber}</button>}</div>
                  {field.missingReason && <small>{missingReasons[field.missingReason]}</small>}
                  {(field.rawValue || field.correction) && (editing || field.correction) && <details><summary>Comparar con dato detectado</summary>{field.rawValue && <p>Texto fuente: {field.rawValue}</p>}{field.correction && <><small>Interpretado: {field.interpretedValue ?? 'No disponible'}</small><small>Corrección v{field.correction.version} · {timestampLabel(field.correction.correctedAt)}</small></>}</details>}
                </article>;
              })}</div>
              {editingStale && <p className={styles.error} role="alert">El documento fue reprocesado durante la edición. Cancelá y revisá la nueva extracción antes de volver a guardar.</p>}
              {editing && <div className={styles.editActions}><button type="button" disabled={busy || editingStale || !editingRunId || !dirty || changes.some(({ value }) => !value.trim())} onClick={() => { if (!editingRunId || editingStale) return; void run(async () => { await onSave(changes, editingRunId); setDrafts({}); setEditingRunId(null); setEditing(false); }); }}>{busy ? 'Guardando…' : `Guardar ${changes.length || ''} cambio${changes.length === 1 ? '' : 's'}`}</button><button type="button" disabled={busy} onClick={() => { setDrafts({}); setEditingRunId(null); setEditing(false); }}>Cancelar</button></div>}
            </section>

            {detail.lineItems.length > 0 && <section className={styles.section}><p>Detalle</p><h3>Conceptos detectados</h3><ul className={styles.lineItems}>{detail.lineItems.map((item) => <li key={item.id}><span>{item.rawDescription}</span><strong>{item.amount} {item.currencyCode}</strong>{item.sourcePage && <small>Pág. {item.sourcePage}</small>}</li>)}</ul></section>}

            {analysis && <details className={styles.timeline} open={runTimeline.some(runNeedsDecision) || undefined}>
              <summary>Historial técnico del análisis ({runTimeline.length})</summary>
              {runsError ? <p className={styles.error} role="alert">{runsError}</p> : runsLoading ? <p role="status">Cargando versiones y comparación…</p> : runTimeline.length ? <ol>{runTimeline.map((version) => {
                const reviewCandidate = runNeedsDecision(version);
                const preview = runPreviews[version.id];
                const changedFields = preview?.fields.filter((field) => field.change !== 'UNCHANGED') ?? [];
                const previewMatchesActive = preview?.baseRunId === analysis.activeRunId && preview.candidateRunId === version.id;
                return <li key={version.id}>
                  <div><strong>Versión {version.processingVersion}</strong>{version.active && <span>Activa</span>}</div>
                  <p>{triggerLabel(version.triggerKind)} · parser {version.parserVersion} · {runOutcomeLabel(version.promotionOutcome)}</p>
                  <small>{timestampLabel(version.finishedAt ?? version.startedAt)}{version.pipelineFingerprint ? ` · pipeline ${version.pipelineFingerprint.slice(0, 12)}` : ''}</small>
                  {reviewCandidate && <div className={styles.comparison}>
                    <h4>Comparación con la versión activa</h4>
                    {runPreviewErrors[version.id] && <p className={styles.error} role="alert">{runPreviewErrors[version.id]}</p>}
                    {preview === null && !runPreviewErrors[version.id] && <p>No hay una base comparable; esta versión no se puede activar desde acá.</p>}
                    {preview && <>
                      {changedFields.length ? <div className={styles.comparisonTable} role="region" aria-label={`Comparación de la versión ${version.processingVersion}`} tabIndex={0}><table><thead><tr><th>Dato</th><th>Activo</th><th>Nuevo</th></tr></thead><tbody>{changedFields.map((field) => <tr key={field.fieldPath}><th scope="row">{comparisonLabels[field.fieldPath] ?? field.fieldPath}</th><td>{comparisonValue(preview, field.fieldPath, field.before, 'before')}</td><td>{comparisonValue(preview, field.fieldPath, field.after, 'after')}</td></tr>)}</tbody></table></div> : <p>Los campos principales no cambian.</p>}
                      {preview.lineItems.changed && <p>Conceptos detectados: {preview.lineItems.beforeCount} activos → {preview.lineItems.afterCount} nuevos.</p>}
                    </>}
                    <div className={styles.runActions}>{previewMatchesActive && <button type="button" disabled={busy || analysis.reprocess.inProgress} onClick={() => void run(() => onRunDecision(version, 'PROMOTE'))}>Usar esta mejora</button>}<button type="button" disabled={busy || analysis.reprocess.inProgress} onClick={() => void run(() => onRunDecision(version, 'KEEP_ACTIVE'))}>Conservar versión activa</button></div>
                  </div>}
                </li>;
              })}</ol> : <p>No hay versiones registradas.</p>}
            </details>}

            <details className={styles.metadata}><summary>Metadatos y trazabilidad</summary><dl><div><dt>Archivo original</dt><dd>{detail.originalFilename}</dd></div><div><dt>Tipo</dt><dd>{detail.documentType ?? 'Sin confirmar'}</dd></div><div><dt>Importado</dt><dd>{timestampLabel(detail.createdAt)}</dd></div><div><dt>Páginas</dt><dd>{detail.pageCount ?? '—'}</dd></div><div><dt>Tamaño</dt><dd>{bytes(detail.sizeBytes)}</dd></div><div><dt>Seguridad</dt><dd>{detail.securityStatus}</dd></div><div><dt>Clasificación</dt><dd>{detail.classificationStatus ?? '—'}</dd></div><div><dt>Extracción</dt><dd>{detail.extractionRun?.processingVersion ?? '—'}</dd></div><div><dt>Método</dt><dd>{detail.extractionRun?.ocrProvider ? `OCR · ${detail.extractionRun.ocrProvider}` : detail.extractionRun?.extractorName ?? '—'}</dd></div><div><dt>Procesado</dt><dd>{timestampLabel(detail.processedAt)}</dd></div><div><dt>Retención</dt><dd>{detail.retentionPolicy}</dd></div></dl></details>

            {detail.processingStatus === 'NEEDS_REVIEW' && settlement?.deductionsMatchTotal === false && <label className={styles.acceptance}><input type="checkbox" checked={acceptMismatch} onChange={(event) => setAcceptedMismatchRunId(event.target.checked ? currentRunId : null)} />Revisé los conceptos y acepto esta diferencia.</label>}

            <footer className={styles.actions}>
              {detail.processingStatus === 'NEEDS_REVIEW' && <button type="button" disabled={busy || reviewBlocked || dirty || !currentRunId} onClick={() => { if (currentRunId) void run(() => onCompleteReview(acceptMismatch, currentRunId)); }}>Finalizar revisión</button>}
              <button type="button" disabled={busy || !originalViewable} onClick={() => void run(onDownload)}>Descargar PDF</button>
              <button type="button" disabled={busy || !canDeleteOriginal} onClick={() => void run(onDeleteOriginal)}>{detail.originalAvailable ? 'Eliminar sólo el PDF' : 'Original eliminado'}</button>
              <button type="button" disabled={busy} onClick={() => void run(onDeleteDocument)}>Eliminar PDF y datos</button>
            </footer>
          </aside>
        </div>
      </section>
    </div>
  );
}
