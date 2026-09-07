'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { countryName } from '@salarivo/jurisdictions';
import { CountrySelect } from './country-select';
import { evidenceIdForPage, extractionRunChanged, reviewValueChanged } from './document-evidence';
import { DocumentViewer } from './document-viewer';
import { documentStatusLabel, earningLabels, periodLabel, settlementTypeLabel, timestampLabel } from './format';
import { MoneyValue, PercentageValue, PrivacyToggle, SensitiveValue, usePrivacyMode } from './privacy-mode';
import { MONEY_MASK, PERCENTAGE_MASK, isMonetaryField, isSalaryPercentageField } from './privacy-mode-state';
import {
  analysisPresentation,
  compatiblePromotionLabel,
  issueLabel,
  runNeedsDecision,
  runOutcomeLabel,
  triggerLabel,
  type DocumentAnalysis,
  type ProcessingComparisonLineItem,
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
  countryCode?: string | null;
  countrySource?: string | null;
  countryConfidence?: string | null;
  countrySnapshotAt?: string | null;
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
  terminationReview?: Array<{
    code: string;
    explanation: string;
    fieldPaths: string[];
    lineItemIds: string[];
    comparison?: { totalField: string; actual: string; expected: string; difference: string };
  }>;
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
  unsupportedFeedback: string | null;
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
  if (field.source === 'MANUAL_OPTIONAL') return 'Dato no detectado; podés completarlo';
  return field.source;
}
function comparisonValue(preview: ProcessingComparisonPreview, fieldPath: string, value: string | null, side: 'before' | 'after') {
  if (value === null) return 'No disponible';
  if (fieldPath === 'settlement.payrollPeriod') return periodLabel(value);
  if (fieldPath === 'settlement.type') return settlementTypeLabel(value);
  if (isMonetaryField(fieldPath)) {
    const currency = preview.fields.find((field) => field.fieldPath === 'settlement.currencyCode')?.[side] ?? 'ARS';
    return <MoneyValue value={value} currency={currency} />;
  }
  if (isSalaryPercentageField(fieldPath)) return <PercentageValue value={value} />;
  return value;
}

function comparisonLineItem(item: ProcessingComparisonLineItem | null) {
  if (!item) return 'No estaba';
  const classification = item.itemType === 'EARNING'
    ? earningLabels[item.normalizedConceptCode ?? 'UNKNOWN'] ?? 'Otro concepto'
    : item.itemType === 'DEDUCTION' ? 'Descuento' : 'Otro concepto';
  const recurrence = item.isRecurring === true ? 'Recurrente' : item.isRecurring === false ? 'No recurrente' : 'Periodicidad sin determinar';
  return <><SensitiveValue value={item.rawDescription} mask="Concepto salarial" /> · {classification} · {recurrence} · <MoneyValue value={item.amount} currency={item.currencyCode} creditAware /></>;
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
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
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
  initialReview,
  initialLineItemId,
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
  onConfirmCountry,
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
  onSaveUnsupportedFeedback,
  processingRuns = [],
  runCompatiblePromotionCounts = {},
  runPreviewErrors = {},
  runPreviews = {},
  runsError = '',
  runsLoading = false,
}: {
  detail: DocumentDetail;
  initialEvidenceId?: string;
  initialPage?: number;
  initialReview?: 'termination';
  initialLineItemId?: string;
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
  onConfirmCountry: (countryCode: string, extractionRunId: string, expectedCountryCode: string | null) => Promise<void>;
  onDeleteDocument: () => Promise<void>;
  onDeleteOriginal: () => Promise<void>;
  onDownload: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onLocationChange: (page: number, evidenceId?: string, lineItemId?: string) => void;
  onNavigate: (direction: -1 | 1) => void;
  onReprocess: (retry?: boolean) => Promise<void>;
  onRunDecision: (run: ProcessingRun, decision: 'PROMOTE' | 'KEEP_ACTIVE', scope: 'DOCUMENT' | 'COMPATIBLE') => Promise<void>;
  onSave: (changes: Array<{ field: ExtractedFieldDetail; value: string }>, extractionRunId: string) => Promise<void>;
  onSaveUnsupportedFeedback: (comment: string) => Promise<string | null>;
  processingRuns?: ProcessingRun[];
  runCompatiblePromotionCounts?: Record<string, number>;
  runPreviewErrors?: Record<string, string>;
  runPreviews?: Record<string, ProcessingComparisonPreview | null | undefined>;
  runsError?: string;
  runsLoading?: boolean;
}) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const workspaceRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const decisionReviewRef = useRef<HTMLElement>(null);
  const decisionFocusRunId = useRef<string | null>(null);
  const terminationReviewRef = useRef<HTMLElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(
    evidenceIdForPage(initialEvidenceId, initialPage, detail.extractedFields),
  );
  const [mobileTab, setMobileTab] = useState<'data' | 'document'>(initialReview || initialLineItemId ? 'data' : initialEvidenceId || initialPage > 1 ? 'document' : 'data');
  const [selectedLineItemId, setSelectedLineItemId] = useState(initialLineItemId);
  const [selectedReviewFieldPath, setSelectedReviewFieldPath] = useState<string>();
  const [acceptedMismatchRunId, setAcceptedMismatchRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decisionNotice, setDecisionNotice] = useState('');
  const [feedbackDraft, setFeedbackDraft] = useState(detail.unsupportedFeedback ?? '');
  const [countryDraft, setCountryDraft] = useState<{ code: string; runId: string | null; expected: string | null } | null>(null);
  const [countryReset, setCountryReset] = useState(0);
  const [countryNotice, setCountryNotice] = useState('');
  const pendingMobileFocus = useRef<'data' | 'document' | null>(null);

  const changes = useMemo(() => detail.extractedFields.flatMap((field) => {
    const draft = drafts[field.fieldPath] ?? savedValue(field);
    return editable.has(field.fieldPath) && reviewValueChanged(field.fieldPath, draft, savedValue(field))
      ? [{ field, value: draft }]
      : [];
  }), [detail.extractedFields, drafts]);
  const correctionsDirty = changes.length > 0;
  const privacyBlocksSave = privacyEnabled && changes.some(({ field }) => (
    isMonetaryField(field.fieldPath) || isSalaryPercentageField(field.fieldPath)
  ));
  const feedbackDirty = feedbackDraft.trim() !== (detail.unsupportedFeedback ?? '');
  const countryDirty = countryDraft !== null && countryDraft.code !== (detail.countryCode ?? '');
  const dirty = correctionsDirty || feedbackDirty || countryDirty;
  const currentRunId = detail.extractionRun?.id ?? null;
  const acceptMismatch = acceptedMismatchRunId === currentRunId;
  const editingStale = editing && extractionRunChanged(editingRunId, currentRunId);
  const countryStale = countryDraft !== null && (countryDraft.runId !== currentRunId || countryDraft.expected !== (detail.countryCode ?? null));
  const missing = detail.extractedFields.filter((field) => field.source === 'MANUAL_REQUIRED' && !savedValue(field));
  const analysis = detail.analysis;
  const analysisCopy = analysis ? analysisPresentation(analysis) : null;
  const runTimeline = processingRuns.length ? processingRuns : analysis?.currentRun ? [analysis.currentRun] : [];
  const decisionRun = runTimeline.find(runNeedsDecision);
  const decisionPreview = decisionRun ? runPreviews[decisionRun.id] : undefined;
  const decisionCompatibleCount = decisionRun ? runCompatiblePromotionCounts[decisionRun.id] ?? 1 : 1;
  const decisionChangedFields = decisionPreview?.fields.filter((field) => field.change !== 'UNCHANGED') ?? [];
  const decisionChangedLineItems = decisionPreview?.lineItems.changes ?? [];
  const decisionMatchesActive = Boolean(decisionRun && decisionPreview
    && decisionPreview.baseRunId === analysis?.activeRunId
    && decisionPreview.candidateRunId === decisionRun.id);
  const currencyCode = detail.settlement?.currencyCode ?? 'ARS';
  const terminationReview = detail.terminationReview ?? [];
  const selectedLineItem = detail.lineItems.find((item) => item.id === selectedLineItemId);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    workspaceRef.current?.focus();
    return () => { dialog?.close(); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, []);

  useEffect(() => {
    if (initialReview !== 'termination') return;
    terminationReviewRef.current?.focus();
  }, [initialReview]);

  useEffect(() => {
    if (initialReview === 'termination' || initialLineItemId || !decisionRun || decisionFocusRunId.current === decisionRun.id) return;
    decisionFocusRunId.current = decisionRun.id;
    const frame = window.requestAnimationFrame(() => decisionReviewRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [decisionRun, initialLineItemId, initialReview]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  useEffect(() => { onLocationChange(page, selectedEvidenceId, selectedLineItem?.id); }, [onLocationChange, page, selectedEvidenceId, selectedLineItem?.id]);
  useEffect(() => {
    if (mobileTab === 'data' && selectedEvidenceId) {
      document.getElementById(`field-${selectedEvidenceId}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [mobileTab, selectedEvidenceId]);
  useEffect(() => {
    const target = pendingMobileFocus.current;
    if (target !== mobileTab || window.matchMedia('(min-width: 1024px) and (min-height: 501px)').matches) return;
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
  async function decideReviewCandidate(decision: 'PROMOTE' | 'KEEP_ACTIVE', scope: 'DOCUMENT' | 'COMPATIBLE') {
    if (!decisionRun) return;
    await onRunDecision(decisionRun, decision, scope);
    setDecisionNotice(decision === 'PROMOTE'
      ? scope === 'COMPATIBLE' ? `Mejora aplicada en ${decisionCompatibleCount} recibos.` : 'Mejora aplicada en este recibo.'
      : 'Conservamos los datos actuales de este recibo.');
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
  function focusReviewTarget(id: string) {
    setMobileTab('data');
    window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      target?.scrollIntoView({ block: 'nearest' });
      target?.focus({ preventScroll: true });
    });
  }
  function reviewField(field: ExtractedFieldDetail) {
    setSelectedReviewFieldPath(field.fieldPath);
    if (canEdit && editable.has(field.fieldPath) && !editing) {
      setEditingRunId(currentRunId);
      setEditing(true);
    }
    focusReviewTarget(field.id ? `field-${field.id}` : `field-path-${field.fieldPath}`);
  }
  function reviewConcept(id: string) {
    setSelectedLineItemId(id);
    focusReviewTarget(`line-item-${id}`);
  }

  const reviewBlocked = missing.length > 0 || settlement?.totalsBalance === false
    || settlement?.componentsBalance === false
    || (settlement?.deductionsMatchTotal === false && !acceptMismatch);
  const canDeleteOriginal = detail.originalAvailable
    && ['COMPLETED', 'NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION', 'REJECTED_UNSUPPORTED', 'QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED'].includes(detail.processingStatus);
  const canEdit = ['COMPLETED', 'NEEDS_REVIEW'].includes(detail.processingStatus) && currentRunId !== null;
  const originalViewable = detail.originalAvailable && detail.securityStatus === 'CLEAN';
  const unsupported = detail.documentType === 'UNSUPPORTED' || detail.processingStatus === 'REJECTED_UNSUPPORTED';
  const visibleFilename = privacyEnabled ? 'Documento privado' : filename(detail);
  const unsupportedReason = detail.errorCode === 'DOCUMENT_UNSUPPORTED'
    ? 'Salarivo detectó que este PDF no parece ser un recibo de sueldo, aguinaldo ni otro documento salarial compatible.'
    : 'Este PDF fue confirmado como un tipo de documento que Salarivo todavía no procesa.';

  return (
    <dialog ref={dialogRef} className={styles.layer} aria-labelledby="review-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <section ref={workspaceRef} className={styles.workspace} tabIndex={-1} onKeyDown={(event) => handleReviewKey(event, close)}>
        <header className={styles.header}>
          <div className={styles.heading}><span className={styles.fileIcon}>PDF</span><div><p>{position.current === null ? 'Documento fuera del listado actual' : `Documento ${position.current} de ${position.total}`}</p><h2 id="review-title" title={visibleFilename}>{visibleFilename}</h2></div></div>
          <PrivacyToggle className={styles.privacyControl} />
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

            {decisionNotice && <p className={styles.success} role="status">{decisionNotice}</p>}
            {decisionRun && <section ref={decisionReviewRef} tabIndex={-1} className={`${styles.analysis} ${styles.decision}`} aria-labelledby="reading-improvement-title" aria-live="polite" aria-busy={runsLoading}>
              <div className={styles.analysisHead}><div><span aria-hidden="true">↻</span><h3 id="reading-improvement-title">Nueva lectura para confirmar</h3></div></div>
              <p>{decisionChangedLineItems.length > 0
                ? `Encontramos una lectura distinta de ${decisionChangedLineItems.length} concepto${decisionChangedLineItems.length === 1 ? '' : 's'}.`
                : 'Encontramos una lectura nueva de los datos del recibo.'} El recibo actual sigue activo hasta que elijas.</p>
              {runsError || runPreviewErrors[decisionRun.id] ? <p className={styles.error} role="alert">{runsError || runPreviewErrors[decisionRun.id]} Podés conservar los datos actuales y revisar otra vez más tarde.</p> : decisionPreview === undefined ? <p role="status">Cargando la comparación…</p> : decisionPreview === null ? <p>No hay una base comparable; esta versión no se puede activar desde acá.</p> : <>
                <div className={styles.comparison}>
                  <h4>Qué va a cambiar</h4>
                  {decisionChangedFields.length ? <div className={styles.comparisonTable} role="region" aria-label={`Comparación de la versión ${decisionRun.processingVersion}`} tabIndex={0}><table><thead><tr><th scope="col">Dato</th><th scope="col">Actual</th><th scope="col">Lectura nueva</th></tr></thead><tbody>{decisionChangedFields.map((field) => <tr key={field.fieldPath}><th scope="row">{comparisonLabels[field.fieldPath] ?? field.fieldPath}</th><td data-label="Actual">{comparisonValue(decisionPreview, field.fieldPath, field.before, 'before')}</td><td data-label="Lectura nueva">{comparisonValue(decisionPreview, field.fieldPath, field.after, 'after')}</td></tr>)}</tbody></table></div> : <p>El período, la empresa, la moneda y los totales principales se conservan.</p>}
                  {decisionPreview.lineItems.changed && <p>Conceptos detectados: {decisionPreview.lineItems.beforeCount} actuales → {decisionPreview.lineItems.afterCount} con la lectura nueva.</p>}
                  {decisionChangedLineItems.length > 0 && <ul className={styles.lineItems}>{decisionChangedLineItems.map((change) => <li key={change.itemOrdinal}><small>Actual: {comparisonLineItem(change.before)}</small><small>Lectura nueva: {comparisonLineItem(change.after)}</small></li>)}</ul>}
                </div>
                {decisionCompatibleCount > 1 && <p>Verificamos que {decisionCompatibleCount - 1} recibo{decisionCompatibleCount === 2 ? '' : 's'} más tiene{decisionCompatibleCount === 2 ? '' : 'n'} el mismo formato y la misma corrección.</p>}
                {!decisionMatchesActive && <p>El análisis activo cambió. Estamos actualizando la comparación antes de habilitar la decisión.</p>}
              </>}
              <div className={styles.runActions}>
                {decisionMatchesActive && decisionCompatibleCount > 1 && <button type="button" className={styles.primaryDecision} disabled={busy || analysis?.reprocess.inProgress} onClick={() => void run(() => decideReviewCandidate('PROMOTE', 'COMPATIBLE'))}>{compatiblePromotionLabel(decisionCompatibleCount)}</button>}
                {decisionMatchesActive && <button type="button" className={decisionCompatibleCount > 1 ? styles.secondaryDecision : styles.primaryDecision} disabled={busy || analysis?.reprocess.inProgress} onClick={() => void run(() => decideReviewCandidate('PROMOTE', 'DOCUMENT'))}>{decisionCompatibleCount > 1 ? 'Aplicar sólo en este recibo' : 'Aplicar esta mejora'}</button>}
                <button type="button" className={styles.secondaryDecision} disabled={busy || analysis?.reprocess.inProgress} onClick={() => void run(() => decideReviewCandidate('KEEP_ACTIVE', 'DOCUMENT'))}>Conservar datos actuales</button>
              </div>
            </section>}

            {(terminationReview.length > 0 || initialReview === 'termination') && <section ref={terminationReviewRef} tabIndex={-1} className={`${styles.callout} ${styles.terminationReview}`} aria-labelledby="termination-review-title">
              <h3 id="termination-review-title">Observaciones para la indemnización</h3>
              <p>Esta revisión es independiente de la mejora de lectura. Después de aplicarla, algunas observaciones pueden continuar.</p>
              {selectedLineItem && <p>Concepto que abriste: <SensitiveValue value={selectedLineItem.rawDescription} mask="Concepto salarial" />. <button type="button" onClick={() => reviewConcept(selectedLineItem.id)}>Ver concepto</button></p>}
              {initialLineItemId && !selectedLineItem && <p>El concepto enlazado ya no está en el análisis actual. Revisá estas observaciones y volvé a calcular.</p>}
              {terminationReview.length > 0 ? <ul>{terminationReview.map((issue, index) => <li key={`${issue.code}-${index}`}>
                <p>{issue.explanation}</p>
                {issue.comparison && <dl className={styles.settlementOverview}>
                  <div><dt>Suma de conceptos</dt><dd><MoneyValue value={issue.comparison.actual} currency={currencyCode} /></dd></div>
                  <div><dt>{labels[issue.comparison.totalField] ?? 'Total esperado'}</dt><dd><MoneyValue value={issue.comparison.expected} currency={currencyCode} /></dd></div>
                  <div><dt>Diferencia</dt><dd><MoneyValue value={issue.comparison.difference} currency={currencyCode} /></dd></div>
                </dl>}
                <div>{issue.fieldPaths.flatMap((path) => {
                  const field = detail.extractedFields.find((candidate) => candidate.fieldPath === path);
                  return field ? <button key={path} type="button" disabled={busy} onClick={() => reviewField(field)}>Revisar {labels[path] ?? 'campo'}</button> : [];
                })}{issue.lineItemIds.some((id) => detail.lineItems.some((item) => item.id === id)) && <button type="button" onClick={() => reviewConcept(issue.lineItemIds.find((id) => detail.lineItems.some((item) => item.id === id))!)}>Revisar conceptos afectados</button>}</div>
              </li>)}</ul> : <p>No hay observaciones de conceptos en el análisis actual. Volvé al simulador y calculá nuevamente para revisar las condiciones del empleo y los demás recibos.</p>}
              {terminationReview.some((issue) => issue.lineItemIds.length > 0) && <p>Los conceptos detectados se consultan aquí; todavía no se editan individualmente. Si la lectura del PDF es incorrecta, usá la opción de volver a analizar cuando esté disponible. También podés ingresar una remuneración bruta normal y habitual sólo para la simulación.</p>}
              <p>Después de guardar una corrección o activar otro análisis, volvé a calcular la estimación.</p>
            </section>}

            {analysis && analysisCopy && !decisionRun && <section className={`${styles.analysis} ${styles[analysisCopy.tone]}`} aria-live="polite" aria-busy={analysis.reprocess.inProgress}>
              <div className={styles.analysisHead}><div><span aria-hidden="true">{analysisCopy.tone === 'ready' ? '✓' : analysisCopy.tone === 'danger' ? '!' : '↻'}</span><h3>{analysisCopy.title}</h3></div>{analysis.reprocess.inProgress && <span className={styles.pulse}>Procesando</span>}</div>
              <p>{analysisCopy.body}</p>
              {analysis.issues.length > 0 && <ul>{analysis.issues.map((issue) => <li key={issue.id ?? `${issue.code}-${issue.affectedFieldPath}`}>{issueLabel(issue)}{issue.recoverable && <small> Se puede volver a analizar.</small>}</li>)}</ul>}
              {(analysis.reprocess.available || analysis.reprocess.retryAvailable || analysis.reprocess.inProgress) && <p className={styles.preserved}>{analysis.activeRunId ? 'Tu análisis activo no se pierde durante el reprocesamiento.' : 'El reintento crea una versión nueva sin borrar el historial técnico.'}</p>}
              {(analysis.reprocess.available || analysis.reprocess.retryAvailable) && <button type="button" disabled={busy || dirty || analysis.reprocess.inProgress} onClick={() => void run(() => onReprocess(analysis.reprocess.retryAvailable === true))}>{busy ? 'Iniciando…' : analysis.reprocess.retryAvailable ? 'Reintentar análisis' : 'Buscar mejora'}</button>}
            </section>}

            <details className={`${styles.section} ${styles.countrySection}`} open={Boolean(countryNotice) || !detail.countryCode || analysis?.issues.some((issue) => issue.code.startsWith('COUNTRY_'))}>
              <summary>País del documento · {detail.countryCode ? countryName(detail.countryCode) : 'Sin confirmar'}</summary>
              <p>{detail.countrySource === 'USER_CONFIRMED' ? 'Confirmado por vos' : detail.countrySource === 'EMPLOYMENT_CONFIRMED' ? 'Heredado del empleo confirmado' : 'País detectado o pendiente de revisión'}{detail.countrySnapshotAt ? ` · ${timestampLabel(detail.countrySnapshotAt)}` : ''}.</p>
              {detail.countryConfidence && <p>Confianza de la clasificación: {({ HIGH: 'alta', MEDIUM: 'media', LOW: 'baja' } as Record<string, string>)[detail.countryConfidence] ?? 'sin evaluar'}.</p>}
              <p>La confirmación cambia sólo el país de este documento y conserva su historial. No modifica el empleo, el PDF ni los datos de la extracción. Si está asociado a un empleo, el país debe coincidir con su jurisdicción confirmada.</p>
              <form className="stack-form" onSubmit={(event) => {
                event.preventDefault();
                const code = String(new FormData(event.currentTarget).get('documentCountryCode') ?? '');
                const runId = countryDraft?.runId ?? currentRunId;
                if (!runId || !code || countryStale || busy || !canEdit || correctionsDirty || feedbackDirty || analysis?.reprocess.inProgress) return;
                void run(async () => {
                  await onConfirmCountry(code, runId, countryDraft ? countryDraft.expected : detail.countryCode ?? null);
                  setCountryDraft(null); setCountryReset((value) => value + 1);
                  setCountryNotice('País del documento confirmado. Podés volver a analizarlo cuando la acción esté disponible.');
                });
              }}>
                <CountrySelect key={`${detail.countryCode}-${detail.countrySnapshotAt}-${countryReset}`} name="documentCountryCode" label="País del documento" initialValue={detail.countryCode ?? ''} required disabled={busy || !canEdit || analysis?.reprocess.inProgress} onChange={(code) => { setCountryNotice(''); setCountryDraft((previous) => ({ code, runId: previous?.runId ?? currentRunId, expected: previous ? previous.expected : detail.countryCode ?? null })); }} />
                {countryStale && <p className={styles.error} role="alert">El documento cambió durante la edición. Cancelá y revisá la jurisdicción actual antes de confirmar.</p>}
                {countryNotice && <p role="status">{countryNotice}</p>}
                {!canEdit && <small>La confirmación estará disponible cuando termine el análisis y exista una extracción activa.</small>}
                <div className={styles.editActions}><button type="submit" disabled={busy || !canEdit || countryStale || correctionsDirty || feedbackDirty || analysis?.reprocess.inProgress}>{busy ? 'Confirmando…' : 'Confirmar país'}</button>{countryDraft && <button type="button" disabled={busy} onClick={() => { setCountryDraft(null); setCountryReset((value) => value + 1); setCountryNotice(''); }}>Cancelar país</button>}</div>
              </form>
            </details>

            {detail.processingStatus === 'NEEDS_TYPE_CONFIRMATION' && <section className={styles.callout}><h3>¿Es un recibo de sueldo?</h3><p>La clasificación automática no fue concluyente.</p><div><button type="button" disabled={busy} onClick={() => void run(() => onConfirmType('PAYROLL'))}>Sí, continuar</button><button type="button" disabled={busy} onClick={() => void run(() => onConfirmType('UNSUPPORTED'))}>No corresponde</button></div></section>}
            {unsupported && <section className={styles.callout}><h3>Tipo de documento no soportado</h3><p>{unsupportedReason} El PDF original se elimina automáticamente; conservamos esta ficha mínima.</p><form className={styles.feedback} onSubmit={(event) => { event.preventDefault(); void run(async () => setFeedbackDraft(await onSaveUnsupportedFeedback(feedbackDraft) ?? '')); }}><label htmlFor="unsupported-feedback">¿Qué tipo de archivo es y por qué te serviría?</label><textarea id="unsupported-feedback" maxLength={500} value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder="Ej.: certificado laboral; me serviría para completar fechas del empleo." /><small>No incluyas salarios, DNI/CUIL ni otros datos personales.</small><button type="submit" disabled={busy || !feedbackDirty}>{busy ? 'Guardando…' : detail.unsupportedFeedback ? 'Actualizar feedback' : 'Enviar feedback'}</button></form></section>}

            {detail.settlement && <section className={styles.section}><p>Liquidación extraída</p><h3>{periodLabel(detail.settlement.payrollPeriod)} · {settlementTypeLabel(detail.settlement.settlementType)}</h3><dl className={styles.settlementOverview}><div><dt>Sueldo básico</dt><dd><MoneyValue value={detail.settlement.basicAmount} currency={detail.settlement.currencyCode} /></dd></div><div><dt>Bruto</dt><dd><MoneyValue value={detail.settlement.grossAmount} currency={detail.settlement.currencyCode} /></dd></div><div><dt>Remunerativo</dt><dd><MoneyValue value={detail.settlement.remunerativeAmount} currency={detail.settlement.currencyCode} /></dd></div><div><dt>No remunerativo</dt><dd><MoneyValue value={detail.settlement.nonRemunerativeAmount} currency={detail.settlement.currencyCode} /></dd></div><div><dt>Neto</dt><dd><MoneyValue value={detail.settlement.netAmount} currency={detail.settlement.currencyCode} /></dd></div><div><dt>Descuentos / créditos</dt><dd><MoneyValue value={detail.settlement.deductionsAmount} currency={detail.settlement.currencyCode} creditAware /></dd></div>{detail.settlement.deductionsChargedAmount && <div><dt>Descuentos cobrados</dt><dd><MoneyValue value={detail.settlement.deductionsChargedAmount} currency={detail.settlement.currencyCode} /></dd></div>}{detail.settlement.reimbursementsAmount && <div><dt>Reintegros</dt><dd><MoneyValue value={detail.settlement.reimbursementsAmount} currency={detail.settlement.currencyCode} /></dd></div>}</dl></section>}

            <section className={styles.section}>
              <div className={styles.sectionHead}><div><p>Extracción</p><h3>Campos detectados</h3></div>{!editing ? <button type="button" disabled={busy || !canEdit} onClick={() => { setEditingRunId(currentRunId); setEditing(true); }}>Editar</button> : <span>Modo edición</span>}</div>
              {privacyEnabled && <p className={styles.privacyNotice} role="status">Los importes y porcentajes salariales están ocultos y su edición permanece bloqueada. El PDF original también queda oculto hasta que decidas mostrarlo tras la advertencia.</p>}
              <div className={styles.fields}>{detail.extractedFields.map((field) => {
                const value = drafts[field.fieldPath] ?? savedValue(field);
                const confidence = Number(field.confidence);
                const percent = Math.round(confidence * 100);
                const isEditable = editable.has(field.fieldPath);
                const monetary = isMonetaryField(field.fieldPath);
                const salaryPercentage = isSalaryPercentageField(field.fieldPath);
                const editor = privacyEnabled && (monetary || salaryPercentage)
                  ? monetary
                    ? <MoneyValue className={styles.maskedEditor} value={value || null} currency={currencyCode} />
                    : <PercentageValue className={styles.maskedEditor} value={value || null} />
                  : !editing || !isEditable
                  ? <span className={styles.maskedEditor}>{monetary ? <MoneyValue value={value || null} currency={currencyCode} /> : field.fieldPath === 'settlement.type' ? settlementTypeLabel(value) : value || 'No disponible'}</span>
                  : field.fieldPath === 'settlement.type'
                  ? <select disabled={!editing || !isEditable} value={value} onChange={(event) => setDrafts((current) => ({ ...current, [field.fieldPath]: event.target.value }))}>{settlementTypes.map((type) => <option value={type} key={type}>{settlementTypeLabel(type)}</option>)}</select>
                  : <input disabled={!editing || !isEditable} type={field.fieldPath === 'settlement.payrollPeriod' ? 'month' : 'text'} inputMode={monetary ? 'decimal' : undefined} autoComplete="off" value={value} onChange={(event) => setDrafts((current) => ({ ...current, [field.fieldPath]: event.target.value }))} />;
                return <article id={field.id ? `field-${field.id}` : `field-path-${field.fieldPath}`} tabIndex={-1} key={field.fieldPath} className={`${styles.field}${selectedEvidenceId === field.id || selectedReviewFieldPath === field.fieldPath ? ` ${styles.selectedField}` : ''}`} onMouseEnter={() => { if (field.id && field.pageNumber === page) setSelectedEvidenceId(field.id); }}>
                  <label><span>{labels[field.fieldPath] ?? field.fieldPath}</span>{editor}</label>
                  <div className={styles.provenance}><span>{provenance(field)}</span>{!field.source.startsWith('MANUAL_') && Number.isFinite(percent) && confidence < .9 && <strong className={confidence < .7 ? styles.low : ''}>{confidence < .7 ? 'Confianza baja' : 'Confianza media'} · {percent}%</strong>}{field.pageNumber && <button type="button" onClick={() => showSource(field)}>Ver fuente · pág. {field.pageNumber}</button>}</div>
                  {field.missingReason && <small>{missingReasons[field.missingReason]}</small>}
                  {(field.rawValue || field.correction) && (editing || field.correction) && <details><summary>Comparar con dato detectado</summary>{field.rawValue && <p>Texto fuente: <SensitiveValue value={field.rawValue} mask={monetary ? `${currencyCode} ${MONEY_MASK}` : salaryPercentage ? PERCENTAGE_MASK : 'Dato oculto'} /></p>}{field.correction && <><small>Interpretado: {monetary || salaryPercentage ? <SensitiveValue value={field.interpretedValue} missing="No disponible" mask={monetary ? `${currencyCode} ${MONEY_MASK}` : PERCENTAGE_MASK} /> : field.interpretedValue ?? 'No disponible'}</small><small>Corrección v{field.correction.version} · {timestampLabel(field.correction.correctedAt)}</small></>}</details>}
                </article>;
              })}</div>
              {!detail.extractedFields.length && <p className={styles.privacyNotice}>{unsupported ? 'Este tipo de documento no genera datos salariales.' : ['COMPLETED', 'NEEDS_REVIEW'].includes(detail.processingStatus) ? 'No hay campos detectados. Revisá el estado del análisis para continuar.' : 'Todavía no hay campos disponibles. El estado del análisis indica el próximo paso.'}</p>}
              {editingStale && <p className={styles.error} role="alert">El documento fue reprocesado durante la edición. Cancelá y revisá la nueva extracción antes de volver a guardar.</p>}
              {editing && <div className={styles.editActions}><button type="button" disabled={busy || editingStale || !editingRunId || !correctionsDirty || privacyBlocksSave || changes.some(({ value }) => !value.trim())} onClick={() => { if (!editingRunId || editingStale || privacyBlocksSave) return; void run(async () => { await onSave(changes, editingRunId); setDrafts({}); setEditingRunId(null); setEditing(false); }); }}>{busy ? 'Guardando…' : `Guardar ${changes.length || ''} cambio${changes.length === 1 ? '' : 's'}`}</button><button type="button" disabled={busy} onClick={() => { setDrafts({}); setEditingRunId(null); setEditing(false); }}>Cancelar</button></div>}
            </section>

            {detail.lineItems.length > 0 && <section className={styles.section}><p>Detalle</p><h3>Conceptos detectados</h3><ul className={styles.lineItems}>{detail.lineItems.map((item) => <li id={`line-item-${item.id}`} tabIndex={-1} key={item.id} className={selectedLineItemId === item.id ? styles.selectedField : undefined}><SensitiveValue value={item.rawDescription} mask="Concepto salarial" /><strong><MoneyValue value={item.amount} currency={item.currencyCode} creditAware /></strong>{item.itemType === 'EARNING' && <small>Clasificación automática: {earningLabels[item.normalizedConceptCode ?? ''] ?? 'Concepto sin clasificar'}.</small>}{terminationReview.filter((issue) => issue.lineItemIds.includes(item.id)).map((issue, index) => <small key={`${issue.code}-${index}`}>{issue.explanation}</small>)}{item.sourcePage && <button type="button" onClick={() => { pendingMobileFocus.current = 'document'; setPage(item.sourcePage!); setSelectedEvidenceId(undefined); setMobileTab('document'); }}>Ver fuente · pág. {item.sourcePage}</button>}</li>)}</ul></section>}

            {analysis && <details className={styles.timeline}>
              <summary>Historial técnico del análisis ({runTimeline.length})</summary>
              {runsError ? <p className={styles.error} role="alert">{runsError}</p> : runsLoading ? <p role="status">Cargando versiones…</p> : runTimeline.length ? <ol>{runTimeline.map((version) => <li key={version.id}>
                  <div><strong>Versión {version.processingVersion}</strong>{version.active && <span>Activa</span>}</div>
                  <p>{triggerLabel(version.triggerKind)} · parser {version.parserVersion} · {runOutcomeLabel(version.promotionOutcome)}</p>
                  <small>{timestampLabel(version.finishedAt ?? version.startedAt)}{version.pipelineFingerprint ? ` · pipeline ${version.pipelineFingerprint.slice(0, 12)}` : ''}</small>
                </li>)}</ol> : <p>No hay versiones registradas.</p>}
            </details>}

            <details className={styles.metadata}><summary>Metadatos y trazabilidad</summary><dl><div><dt>Archivo original</dt><dd><SensitiveValue value={detail.originalFilename} mask="Nombre de archivo oculto" /></dd></div><div><dt>Tipo</dt><dd>{detail.documentType ?? 'Sin confirmar'}</dd></div><div><dt>Importado</dt><dd>{timestampLabel(detail.createdAt)}</dd></div><div><dt>Páginas</dt><dd>{detail.pageCount ?? '—'}</dd></div><div><dt>Tamaño</dt><dd>{bytes(detail.sizeBytes)}</dd></div><div><dt>Seguridad</dt><dd>{detail.securityStatus}</dd></div><div><dt>Clasificación</dt><dd>{detail.classificationStatus ?? '—'}</dd></div><div><dt>Extracción</dt><dd>{detail.extractionRun?.processingVersion ?? '—'}</dd></div><div><dt>Método</dt><dd>{detail.extractionRun?.ocrProvider ? `OCR · ${detail.extractionRun.ocrProvider}` : detail.extractionRun?.extractorName ?? '—'}</dd></div><div><dt>Procesado</dt><dd>{timestampLabel(detail.processedAt)}</dd></div><div><dt>Retención</dt><dd>{detail.retentionPolicy}</dd></div></dl></details>

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
    </dialog>
  );
}
