'use client';

import { FormEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DocumentReview, type DocumentDetail, type ExtractedFieldDetail } from './document-review';
import { fetchDocumentPrefix, readDocumentLocation, readOwnerLocation, writeDocumentLocation, writeOwnerLocation, type CursorDocumentPage, type OwnerLocation, type OwnerLocationPatch } from './document-evidence';
import {
  batchIsActive,
  batchResolved,
  batchWasDismissed,
  type ProcessingComparisonPreview,
  type ProcessingRun,
  type ProcessingRunDetail,
  type ReprocessingBatch,
  type ReprocessingCandidate,
} from './reprocessing';
import {
  amountFromCents,
  dateLabel,
  documentStatusLabel,
  economicStatusMessage,
  economicTrendLabel,
  employmentOptionLabel,
  percentageFromBasisPoints,
  periodLabel,
  recentPeriodRange,
  relevantEvolutionRanges,
  salaryContextForEmployment,
  salaryContextOptionLabel,
  salaryContextIdentityMatches,
  salaryContextMatches,
  salaryCategories,
  settlementTypeLabel,
  timestampLabel,
  type EconomicReason,
  type EconomicStatus,
  type SalaryCategory,
} from './format';
import { MoneyValue, PercentageValue, PrivacyModeProvider, PrivacyToggle, SensitiveValue, privacySnapshot, subscribePrivacyMode, usePrivacyMode } from './privacy-mode';
import { privacyChartHeights } from './privacy-mode-state';
import { mfaQrDataUrl } from './mfa-qr';
import { createStepUpGate, type StepUpGate } from './sensitive-action';
import { uploadFile, type AuthorizedUpload } from './storage-upload';

const API_ROOT = process.env.NEXT_PUBLIC_API_BASE_URL
  ?? (process.env.NODE_ENV === 'production' ? '/api/v1' : 'http://localhost:3001/api/v1');

type User = {
  id: string;
  email: string;
  displayName: string | null;
  role: 'USER' | 'ADMIN';
  adminRole: 'SUPER_ADMIN' | 'OPERATIONS' | 'SUPPORT' | 'SECURITY' | 'FINANCE' | 'READ_ONLY' | null;
  permissions: string[];
  authState: 'AUTHENTICATED' | 'MFA_REQUIRED' | 'MFA_SETUP_REQUIRED';
  mfaEnabled: boolean;
  onboardingCompleted: boolean;
  legalAcceptanceRequired: boolean;
  authMethods: 'GOOGLE'[];
};
type MfaStatus = {
  enabled: boolean;
  enabledAt: string | null;
  method: string | null;
  pendingEnrollment: boolean;
  recoveryCodesRemaining: number;
};
type MfaEnrollmentResult = { secret: string; otpauthUri: string; expiresAt: string };
type DeletionReceipt = { id: string; status: 'PENDING' | 'COMPLETED'; requestedAt: string; completedAt: string | null };
type DeletionReceiptEntry = { token: string; source: 'accepted' | 'ambiguous' | 'lookup' };
type RunSensitive = (action: () => Promise<void>) => Promise<void>;
type Employment = {
  id: string;
  employerId: string;
  employerName: string;
  role?: string | null;
  startDate: string;
  endDate?: string | null;
  status: 'ACTIVE' | 'ENDED';
  countryCode: string;
  currencyCode: string;
  isFavorite: boolean;
  employerStatus?: 'PENDING' | 'VERIFIED' | 'MERGED' | 'REJECTED' | null;
};
type EmploymentDetection = {
  employerId: string | null;
  employerName: string;
  currencyCode: string;
  firstPeriod: string;
  lastPeriod: string;
  documentCount: number;
  state: 'DETECTED';
};
type DocumentItem = {
  id: string;
  employmentId?: string | null;
  employerName?: string | null;
  payrollPeriod?: string | null;
  settlementType?: string | null;
  originalFilename: string;
  displayFilename?: string;
  createdAt: string;
  processingStatus: string;
  documentType?: string | null;
  confidence?: string | null;
  originalAvailable?: boolean;
  needsReview?: boolean;
  decisionRequired?: boolean;
  errorCode?: string | null;
};
type DocumentPage = CursorDocumentPage<DocumentItem>;
type AuthSession = {
  browser: string;
  createdAt: string;
  current: boolean;
  deviceType: string;
  expiresAt: string;
  id: string;
  lastSeenAt: string;
  operatingSystem: string;
};
type ExportJob = {
  completedAt: string | null;
  createdAt: string;
  downloadUrl?: string | null;
  expiresAt: string | null;
  id: string;
  startedAt: string | null;
  status: string;
};
type SalaryAmounts = {
  basicAmount: string | null;
  grossAmount: string | null;
  netAmount: string | null;
  deductionsAmount: string | null;
  remunerativeAmount: string | null;
  nonRemunerativeAmount: string | null;
};
type EconomicObservation = {
  seriesCode: string;
  externalSeriesId: string;
  observationDate: string;
  requestedDate: string;
  selectionMethod: 'PAYMENT_DATE' | 'ISSUE_DATE' | 'PAYROLL_PERIOD_END' | 'EXACT_PERIOD' | 'LATEST_AVAILABLE';
  revision: number;
  source: string;
  sourceUrl: string;
  provider: string;
  methodology: string;
  licenseUrl: string;
  fetchedAt: string;
};
type EconomicProjection = {
  status: EconomicStatus;
  reason: EconomicReason;
  currencyCode: string;
  referencePeriod: string | null;
  comparableSalary: string | null;
  amounts: SalaryAmounts | null;
  observations: EconomicObservation[];
};
type EconomicPerspective = 'nominal' | 'historical-usd' | 'purchasing-power';
type MoneyChange = { fromAmount: string; toAmount: string; deltaAmount: string; percentage: string | null };
type SalaryChange = MoneyChange & { fromPeriod: string; toPeriod: string };
type MonthlyEvolution = {
  period: string;
  totals: SalaryAmounts;
  regular: SalaryAmounts;
  comparableSalary: string | null;
  quality?: { incompleteDocuments: number; reprocessableDocuments: number };
  economic?: {
    historicalUsd: EconomicProjection;
    purchasingPower: EconomicProjection;
    comparisonToPrevious: {
      fromPeriod: string;
      historicalUsd: { status: EconomicStatus; reason: EconomicReason; changeBasisPoints: string | null };
      purchasingPower: { status: EconomicStatus; reason: EconomicReason; changeBasisPoints: string | null };
      inflation: { status: EconomicStatus; reason: EconomicReason; changeBasisPoints: string | null };
    } | null;
  };
};
type SalaryConcept = {
  period: string;
  settlementId: string;
  settlementType: string;
  earningIndex: number;
  category: SalaryCategory;
  code: string;
  isRecurring: boolean | null;
  amount: string;
};
type SalaryConceptPage = { items: SalaryConcept[]; nextCursor: string | null };
type AnnualCategorySummary = { settlementCount: number; documentCount: number; totals: SalaryAmounts };
type AnnualSalarySummary = {
  year: string;
  periodCount: number;
  settlementCount: number;
  documentCount: number;
  totals: SalaryAmounts;
  averages: SalaryAmounts;
  byCategory: Record<SalaryCategory, AnnualCategorySummary>;
  normalizedEarningsByCategory: Record<SalaryCategory, string> | null;
  comparableChange: SalaryChange | null;
};
type SalaryScopeAnalytics = {
  employmentContext: string | null;
  currencyCode: string;
  current: {
    period: string;
    amounts: SalaryAmounts;
    comparableSalary: string | null;
    settlementCount: number;
    documentCount: number;
    changes: { latest: SalaryChange | null; ytd: SalaryChange | null; rolling12: SalaryChange | null; yearOverYear: SalaryChange | null };
  } | null;
  evolution: MonthlyEvolution[];
  annual: AnnualSalarySummary[];
  increases: SalaryChange[];
  coverage: {
    basis: 'CONFIRMED_EMPLOYMENT' | 'OBSERVED' | 'INDETERMINATE_CONTEXT';
    boundaryContradiction: boolean;
    employmentStartPeriod: string | null;
    employmentEndPeriod: string | null;
    employmentStatus: string | null;
    rangeStartPeriod: string | null;
    rangeEndPeriod: string | null;
    expectedPeriods: string[];
    availablePeriods: string[];
    possibleMissingPeriods: string[];
    byYear: Array<{ year: string; expectedPeriods: string[]; availablePeriods: string[]; possibleMissingPeriods: string[] }>;
  };
  events: Array<
    | { type: 'COMPARABLE_INCREASE'; period: string; category: 'NORMAL'; change: SalaryChange }
    | { type: 'EXTRAORDINARY'; period: string; category: Exclude<SalaryCategory, 'NORMAL' | 'OTRO'>; amount: string | null; amountBasis: 'NORMALIZED_EARNING' | 'SETTLEMENT_GROSS' | 'UNAVAILABLE'; settlementId: string; documentId: string }
  >;
};
type SalaryContext = {
  employmentContext: string;
  employmentId: string | null;
  employerName: string | null;
  state: 'CONFIRMED' | 'DETECTED' | 'UNCONFIRMED';
  countryCode: string | null;
  currencyCode: string;
  isFavorite: boolean;
  employmentStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  firstPeriod: string | null;
  lastPeriod: string | null;
};
type SalaryHistory = {
  calculationVersion: string;
  economicCalculationVersion: string;
  contexts: SalaryContext[];
  coverage: { documents: number; activeEmployments: number; completedDocuments: number; needsReviewDocuments: number; pendingReviewDocuments: number; unassociatedDocuments: number; analyzedSettlements: number; reprocessing?: { candidateDocuments: number; processingDocuments: number; reviewRequiredDocuments: number } };
  analytics: {
    settlementCount: number;
    documentCount: number;
    employmentContextCount: number;
    periodCount: number;
    firstPeriod: string | null;
    lastPeriod: string | null;
    scopes: SalaryScopeAnalytics[];
    possibleDuplicates: Array<{ signature: string; employmentContext: string; currencyCode: string; payrollPeriod: string; settlementIds: string[]; documentIds: string[] }>;
  };
};
type PeriodComparison = {
  employmentContext: string;
  currencyCode: string;
  fromPeriod: string;
  toPeriod: string;
  changes: Record<'basicAmount' | 'comparableSalary' | 'grossAmount' | 'netAmount' | 'deductionsAmount' | 'remunerativeAmount' | 'nonRemunerativeAmount', MoneyChange | null>;
  earnings: Array<{ code: string; change: MoneyChange }> | null;
  drivers: Array<{ type: 'EXTRAORDINARY_EARNING' | 'DEDUCTIONS'; code: string; category: Exclude<SalaryCategory, 'NORMAL' | 'OTRO'> | 'DEDUCTIONS'; change: MoneyChange }>;
  driversComplete: boolean;
  conclusionCode: 'NET_UNAVAILABLE' | 'NET_UNCHANGED' | 'NET_VARIATION_RECONCILED_BY_EXTRAORDINARY' | 'NET_VARIATION_RECONCILED_BY_DEDUCTIONS' | 'NET_VARIATION_RECONCILED_BY_EXTRAORDINARY_AND_DEDUCTIONS' | 'NET_VARIATION_INSUFFICIENT_DATA' | 'NET_VARIATION_UNEXPLAINED';
  economic?: {
    historicalUsd: EconomicComparisonProjection;
    purchasingPower: EconomicComparisonProjection;
    inflation: EconomicInflationComparison;
  } | null;
};
type EconomicComparisonProjection = {
  status: EconomicStatus;
  reason: EconomicReason;
  currencyCode: string;
  earlierComparableNetCents: string | null;
  laterComparableNetCents: string | null;
  changeCents: string | null;
  changeBasisPoints: string | null;
  referencePeriod: string | null;
  observations: EconomicObservation[];
};
type EconomicInflationComparison = {
  status: EconomicStatus;
  reason: EconomicReason;
  changeBasisPoints: string | null;
  observations: EconomicObservation[];
};
type ImportProgress = {
  key: string;
  name: string;
  status: 'PENDIENTE' | 'SUBIENDO' | 'EN_COLA' | 'LISTO' | 'REVISAR' | 'ERROR';
  uploadPercentage: number;
  message?: string;
};
type ImportBatchItem = {
  id: string;
  clientItemKey: string;
  originalFilename: string;
  employmentId?: string | null;
  status: string;
  errorCode?: string | null;
};
type ImportBatch = {
  id: string;
  status: string;
  progress: { total: number; resolved: number; percentage: number };
  totals: Record<string, number>;
  items: ImportBatchItem[];
};
type LegalSummary = { version: string };

const googleAuthErrorMessages: Record<string, string> = {
  'google-cancelled': 'Cancelaste el acceso con Google. Podés intentarlo nuevamente.',
  'google-failed': 'No pudimos iniciar sesión con Google. Intentá nuevamente.',
  'invalid-callback': 'No pudimos validar la respuesta de Google. Intentá nuevamente.',
  'account-disabled': 'Esta cuenta se encuentra deshabilitada.',
  'account-link-required': 'Ese email ya pertenece a otra cuenta y no se puede vincular automáticamente.',
};

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

const LEGAL_ACCEPTANCE_REQUIRED_EVENT = 'salarivo:legal-acceptance-required';

function notifyLegalAcceptanceRequired(code: string) {
  if (code === 'LEGAL_ACCEPTANCE_REQUIRED') window.dispatchEvent(new Event(LEGAL_ACCEPTANCE_REQUIRED_EVENT));
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string } | string;
  };
  if (!response.ok) {
    const message = typeof body.error === 'string'
      ? body.error
      : body.error?.message ?? 'No pudimos completar la operación.';
    const code = typeof body.error === 'string' ? 'REQUEST_FAILED' : body.error?.code ?? 'REQUEST_FAILED';
    notifyLegalAcceptanceRequired(code);
    throw new ApiError(message, response.status, code);
  }
  return (Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body) as T;
}

async function loadLegalVersions() {
  const [terms, privacy] = await Promise.all([
    api<LegalSummary>('/legal/terms', { cache: 'no-store' }),
    api<LegalSummary>('/legal/privacy', { cache: 'no-store' }),
  ]);
  return { terms: terms.version, privacy: privacy.version };
}

async function redirectToGoogle(path: '/auth/google/start' | '/auth/google/step-up/start') {
  const { authorizationUrl } = await api<{ authorizationUrl: string }>(path, { method: 'POST', body: '{}' });
  window.location.assign(authorizationUrl);
}

function clearAuthQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete('auth');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

async function downloadApiFile(path: string, filename: string) {
  const response = await fetch(apiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? 'REQUEST_FAILED';
    notifyLegalAcceptanceRequired(code);
    throw new ApiError(body.error?.message ?? 'No pudimos descargar la exportación.', response.status, code);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function apiUrl(path: string) {
  return path.startsWith('/api/v1/') ? `${API_ROOT}${path.slice('/api/v1'.length)}` : path;
}

function browserOpaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function documentName(document: DocumentItem, privacyEnabled = false) {
  return privacyEnabled ? 'Documento privado' : document.displayFilename || document.originalFilename;
}

function resolveDocumentItem(documents: DocumentItem[], documentId: string): DocumentItem {
  return documents.find(({ id }) => id === documentId) ?? {
    id: documentId,
    originalFilename: 'Documento privado',
    createdAt: '',
    processingStatus: 'UNKNOWN',
  };
}

const categoryLabels: Record<SalaryCategory, string> = {
  NORMAL: 'Sueldo regular',
  SAC: 'Aguinaldo',
  BONO: 'Bonos y premios',
  RETROACTIVO: 'Retroactivos',
  VACACIONES: 'Vacaciones',
  HORAS_EXTRA: 'Horas extra',
  AJUSTE: 'Ajustes',
  REINTEGRO: 'Reintegros',
  COMISION: 'Comisiones',
  LIQUIDACION_FINAL: 'Liquidación final',
  INDEMNIZACION: 'Indemnizaciones',
  OTRO: 'Otros',
};
const earningLabels: Record<string, string> = {
  BASIC_SALARY: 'Sueldo básico',
  SENIORITY: 'Antigüedad',
  ATTENDANCE: 'Presentismo',
  SAC: 'Aguinaldo',
  RETROACTIVE: 'Retroactivo',
  VACATION: 'Vacaciones',
  BONUS: 'Bono o premio',
  COMMISSION: 'Comisión',
  OVERTIME: 'Horas extra',
  REIMBURSEMENT: 'Reintegro',
};
const comparisonConclusionLabels: Record<NonNullable<PeriodComparison['conclusionCode']>, string> = {
  NET_UNAVAILABLE: 'No hay neto suficiente para explicar la variación.',
  NET_UNCHANGED: 'El neto no cambió entre los períodos elegidos.',
  NET_VARIATION_RECONCILED_BY_EXTRAORDINARY: 'La variación del neto queda conciliada por cambios en ingresos extraordinarios.',
  NET_VARIATION_RECONCILED_BY_DEDUCTIONS: 'La variación del neto queda conciliada por cambios en descuentos o créditos.',
  NET_VARIATION_RECONCILED_BY_EXTRAORDINARY_AND_DEDUCTIONS: 'La variación del neto queda conciliada por cambios extraordinarios y en descuentos o créditos.',
  NET_VARIATION_INSUFFICIENT_DATA: 'Faltan conceptos normalizados para explicar la variación del neto.',
  NET_VARIATION_UNEXPLAINED: 'Los datos disponibles no alcanzan para explicar la variación del neto.',
};
const settlementTypeOptions = [
  'NORMAL', 'SAC', 'VACACIONES', 'BONO', 'RETROACTIVO', 'COMISION', 'HORAS_EXTRA',
  'LIQUIDACION_FINAL', 'INDEMNIZACION', 'AJUSTE', 'REINTEGRO', 'OTRO_LABORAL',
];
function handleDialogKey(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
  ));
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

const associationReadyStatuses = new Set([
  'COMPLETED', 'NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION', 'REJECTED_UNSUPPORTED',
  'QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED',
]);
const processingDocumentPattern = /UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION/;
const historyTabs = [
  ['summary', 'Resumen'],
  ['evolution', 'Evolución'],
  ['purchasing-power', 'Poder adquisitivo'],
  ['annual', 'Por año'],
  ['concepts', 'Conceptos'],
  ['documents', 'Documentos'],
] as const;
const economicPerspectives = [
  ['nominal', 'Nominal'],
  ['historical-usd', 'USD histórico'],
  ['purchasing-power', 'Poder adquisitivo'],
] as const;
const dismissedReprocessingBatchKey = 'salarivo.dismissed-reprocessing-batch';
type HistoryTab = (typeof historyTabs)[number][0];
const documentStatusGroups = [
  ['ALL', 'Todos'],
  ['READY', 'Listos'],
  ['REVIEW', 'Para revisar'],
  ['PROCESSING', 'Procesando'],
  ['ERROR', 'Con error'],
] as const;
const documentKinds = [
  ['ALL', 'Todos'],
  ['PAYROLL', 'Recibos'],
  ['UNSUPPORTED', 'No soportados'],
] as const;
const evolutionRanges = [
  ['6', '6 meses', 6],
  ['12', '1 año', 12],
  ['24', '2 años', 24],
  ['60', '5 años', 60],
  ['all', 'Todo', undefined],
] as const;
const importErrorLabels: Record<string, string> = {
  DOCUMENT_DUPLICATE: 'Ya estaba cargado; no se volvió a guardar.',
  DOCUMENT_UNSUPPORTED: 'No parece un recibo salarial soportado.',
  DOCUMENT_CORRUPTED: 'El PDF está dañado o no tiene una estructura válida.',
  DOCUMENT_INVALID_TYPE: 'El contenido real no es un PDF admitido.',
  DOCUMENT_TEXT_UNREADABLE: 'No se pudo leer texto suficiente del recibo.',
  DOCUMENT_ACTIVE_CONTENT: 'El PDF contiene acciones activas bloqueadas por seguridad.',
  DOCUMENT_EMBEDDED_FILE: 'El PDF contiene archivos adjuntos no permitidos.',
  DOCUMENT_SIZE_MISMATCH: 'El tamaño recibido no coincide con el declarado.',
  DOCUMENT_ENCRYPTED: 'El PDF está protegido con contraseña.',
  DOCUMENT_TOO_LARGE: 'El PDF supera el tamaño permitido.',
  DOCUMENT_TOO_MANY_PAGES: 'El PDF supera la cantidad de páginas permitida.',
  DOCUMENT_MALWARE_DETECTED: 'El archivo fue bloqueado por seguridad.',
  PROCESSING_TIMEOUT: 'El análisis superó el tiempo seguro permitido.',
  WORKER_LEASE_EXHAUSTED: 'El análisis agotó sus reintentos.',
  IMPORT_CANCELLED_BY_USER: 'Carga cancelada.',
};

function importProgressItem(server: ImportBatchItem, current?: ImportProgress): ImportProgress {
  const base = {
    key: server.clientItemKey,
    name: server.originalFilename,
    uploadPercentage: server.status === 'PENDING_UPLOAD' || server.status === 'CANCELLED'
      ? current?.uploadPercentage ?? 0
      : 100,
  };
  if (server.status === 'PENDING_UPLOAD' && (current?.status === 'SUBIENDO' || current?.status === 'ERROR')) return current;
  if (server.status === 'CANCELLED' && current?.status === 'ERROR') return current;
  if (server.status === 'PENDING_UPLOAD') return { ...base, status: 'PENDIENTE', message: 'Esperando carga' };
  if (server.status === 'COMPLETED') return { ...base, status: 'LISTO', message: 'Procesado correctamente' };
  if (server.status === 'NEEDS_REVIEW') return { ...base, status: 'REVISAR', message: 'Necesita tu revisión' };
  if (['REJECTED', 'FAILED', 'CANCELLED'].includes(server.status)) {
    return { ...base, status: 'ERROR', message: importErrorLabels[server.errorCode ?? ''] ?? server.errorCode ?? 'No se pudo procesar' };
  }
  return { ...base, status: 'EN_COLA', message: server.status === 'PROCESSING' ? 'Procesando' : 'En cola' };
}

function normalizedEmployerName(value: string) {
  return value.normalize('NFKC').trim().toLowerCase();
}

export function SalarivoApp() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [deletionReceiptEntry, setDeletionReceiptEntry] = useState<DeletionReceiptEntry | null>(null);
  const [accessMode, setAccessMode] = useState<'login' | 'google-register'>('login');
  const [accessError, setAccessError] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  useEffect(() => {
    const requireLegalAcceptance = () => setUser((current) => current
      ? { ...current, legalAcceptanceRequired: true }
      : current);
    window.addEventListener(LEGAL_ACCEPTANCE_REQUIRED_EVENT, requireLegalAcceptance);
    return () => window.removeEventListener(LEGAL_ACCEPTANCE_REQUIRED_EVENT, requireLegalAcceptance);
  }, []);

  useEffect(() => {
    let stopped = false;
    const auth = new URLSearchParams(window.location.search).get('auth');

    if (auth === 'google-registration') {
      void Promise.resolve().then(() => {
        if (!stopped) { setAccessMode('google-register'); setUser(null); }
      });
      return () => { stopped = true; };
    }
    if (auth && auth !== 'google-success' && auth !== 'google-step-up') {
      void Promise.resolve().then(() => {
        if (!stopped) {
          clearAuthQuery();
          setAccessError(googleAuthErrorMessages[auth] ?? googleAuthErrorMessages['invalid-callback']!);
          setUser(null);
        }
      });
      return () => { stopped = true; };
    }
    api<User>('/auth/me').then(
      (current) => {
        if (stopped) return;
        if (auth) clearAuthQuery();
        setUser(current);
        if (auth === 'google-step-up') setAuthNotice('Identidad confirmada. Repetí la acción sensible para completarla.');
      },
      (caught: unknown) => {
        if (stopped) return;
        if (auth) clearAuthQuery();
        setUser(null);
        if (auth || !(caught instanceof ApiError) || caught.status !== 401) {
          setAccessError(auth
            ? 'Tu sesión con Google no pudo validarse. Intentá nuevamente.'
            : 'No pudimos validar tu sesión. Intentá nuevamente.');
        }
      },
    );
    return () => { stopped = true; };
  }, []);

  if (user === undefined) {
    return (
      <main className="center-screen" aria-busy="true">
        <div className="loader" />
        <p>Abriendo tu espacio privado…</p>
      </main>
    );
  }
  if (deletionReceiptEntry) {
    return <DeletionReceiptScreen entry={deletionReceiptEntry} onDone={() => setDeletionReceiptEntry(null)} />;
  }
  if (!user) return <AccessScreen
    initialMode={accessMode}
    initialError={accessError}
    onAuthenticated={(current) => { clearAuthQuery(); setAccessError(''); setUser(current); }}
    onGoogleRegistrationCancelled={() => { clearAuthQuery(); setAccessMode('login'); }}
    onReceiptToken={(token) => setDeletionReceiptEntry({ token, source: 'lookup' })}
  />;
  if (user.authState === 'MFA_REQUIRED' || user.authState === 'MFA_SETUP_REQUIRED') {
    return <MfaAccessGate
      user={user}
      onAuthenticated={setUser}
      onLogout={() => setUser(null)}
    />;
  }
  if (user.legalAcceptanceRequired) {
    return <LegalAcceptanceScreen
      user={user}
      onAccepted={setUser}
      onLogout={() => setUser(null)}
      onDeletionRequested={(token, source) => { setDeletionReceiptEntry({ token, source }); setUser(null); }}
    />;
  }
  if (!user.onboardingCompleted) {
    return <OnboardingScreen user={user} onComplete={setUser} onLogout={() => setUser(null)} />;
  }
  return <PrivacyModeProvider><PrivateApp
      user={user}
      authNotice={authNotice}
      onAuthNoticeDismiss={() => setAuthNotice('')}
      onUserChanged={setUser}
      onLogout={() => setUser(null)}
      onDeletionRequested={(token, source) => { setDeletionReceiptEntry({ token, source }); setUser(null); }}
    /></PrivacyModeProvider>;
}

function Brand() {
  return (
    <div className="brand" aria-label="Salarivo">
      <span className="brand-mark" aria-hidden="true">S</span>
      <span>Salarivo</span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="google-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.703-1.568 2.684-3.877 2.684-6.615Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.91-2.258c-.805.54-1.835.859-3.046.859-2.344 0-4.328-1.585-5.037-3.714H.957v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.707A5.41 5.41 0 0 1 3.68 9c0-.592.102-1.168.283-1.707V4.961H.957A9 9 0 0 0 0 9c0 1.45.347 2.824.957 4.039l3.006-2.332Z" />
      <path fill="#EA4335" d="M9 3.579c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .957 4.961l3.006 2.332C4.672 5.164 6.656 3.579 9 3.579Z" />
    </svg>
  );
}

function DeletionReceiptScreen({ entry, onDone }: { entry: DeletionReceiptEntry; onDone: () => void }) {
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const { token } = entry;

  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try {
      setReceipt(await api<DeletionReceipt>('/privacy/account-deletion/status', {
        method: 'POST', body: JSON.stringify({ token }),
      }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos consultar el comprobante.'); }
    finally { setBusy(false); }
  }, [token]);

  useEffect(() => {
    let stopped = false;
    api<DeletionReceipt>('/privacy/account-deletion/status', {
      method: 'POST', body: JSON.stringify({ token }),
    }).then(
      (result) => { if (!stopped) setReceipt(result); },
      (caught: unknown) => { if (!stopped) setError(caught instanceof Error ? caught.message : 'No pudimos consultar el comprobante.'); },
    ).finally(() => { if (!stopped) setBusy(false); });
    return () => { stopped = true; };
  }, [token]);

  const confirmed = receipt !== null;
  const heading = confirmed
    ? receipt.status === 'COMPLETED' ? 'La eliminación fue completada.' : 'La solicitud fue recibida.'
    : entry.source === 'accepted' ? 'La solicitud fue recibida.' : 'Todavía no pudimos confirmar la solicitud.';
  const lead = confirmed
    ? 'El worker elimina los objetos privados y después purga los datos de la cuenta.'
    : entry.source === 'accepted'
      ? 'Tu cuenta quedó cerrada para nuevos accesos mientras se completa el borrado.'
      : 'La respuesta pudo interrumpirse antes o después de registrar el pedido. Conservá el token y verificá su estado.';

  return (
    <main className="access-layout">
      <section className="access-story"><Brand /><div><p className="eyebrow">{confirmed ? 'Comprobante verificado' : 'Comprobante sin confirmar'}</p><h1>{heading}</h1><p className="lead">{lead}</p></div></section>
      <section className="access-panel" aria-labelledby="deletion-receipt-title"><div className="access-card stack-form">
        <h2 id="deletion-receipt-title">Comprobante de eliminación</h2>
        <p>Guardá este token hasta que el estado figure como completado. Se muestra una sola vez.</p>
        <code>{token}</code>
        <p className={receipt?.status === 'COMPLETED' ? 'message success' : 'message'}>Estado: <strong>{receipt ? receipt.status === 'COMPLETED' ? 'Completado' : 'Pendiente' : 'Sin confirmar'}</strong>{receipt?.completedAt ? ` · ${timestampLabel(receipt.completedAt)}` : ''}</p>
        {error && <p className="message error" role="alert">{error}</p>}
        {!receipt && entry.source !== 'accepted' && <p>Si el token sigue sin aparecer, el pedido puede no haber llegado. Volvé al ingreso y solicitá la baja nuevamente.</p>}
        <button className="button primary" disabled={busy} onClick={refresh}>{busy ? 'Consultando…' : 'Actualizar estado'}</button>
        <button className="button secondary" onClick={onDone}>Ir al ingreso</button>
      </div></section>
    </main>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="stack-form" aria-live="polite">
      <p className="message success">Guardá estos códigos ahora. Cada uno sirve una sola vez y no volveremos a mostrarlos.</p>
      <ul aria-label="Códigos de recuperación">
        {codes.map((code) => <li key={code}><code>{code}</code></li>)}
      </ul>
      {error && <p className="message error" role="alert">{error}</p>}
      <button className="button primary" disabled={busy} onClick={async () => { setError(''); setBusy(true); try { await onDone(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos continuar.'); } finally { setBusy(false); } }}>
        {busy ? 'Continuando…' : 'Ya los guardé'}
      </button>
    </div>
  );
}

function MfaEnrollment({ pending = false, onComplete }: { pending?: boolean; onComplete: () => Promise<void> | void }) {
  const [enrollment, setEnrollment] = useState<MfaEnrollmentResult | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  const beginEnrollment = useCallback(async () => {
    setError(''); setBusy(true);
    try {
      setEnrollment(await api<MfaEnrollmentResult>('/auth/mfa/enrollment', {
        method: 'POST', body: '{}',
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la configuración.');
    }
    finally { setBusy(false); }
  }, []);

  async function confirmEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/enrollment/confirm', {
        method: 'POST', body: JSON.stringify({ code: form.get('code') }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos confirmar el código.'); }
    finally { setBusy(false); }
  }

  async function copySecret() {
    if (!enrollment) return;
    setError('');
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setSecretCopied(true);
    } catch {
      setError('No pudimos copiar la clave. Seleccionala y copiala manualmente.');
    }
  }

  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} onDone={onComplete} />;
  if (enrollment) {
    return (
      <div className="stack-form">
        <p>Escaneá este QR con tu aplicación autenticadora:</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- El QR ya es un SVG local embebido. */}
        <img className="mfa-qr" src={mfaQrDataUrl(enrollment.otpauthUri)} alt="Código QR para agregar Salarivo a una aplicación autenticadora" width={220} height={220} />
        <p>También podés ingresar la clave manualmente:</p>
        <div className="mfa-secret"><code>{enrollment.secret}</code><button type="button" className="button compact" onClick={() => void copySecret()} aria-live="polite">{secretCopied ? 'Copiada' : 'Copiar clave'}</button></div>
        <p><small>La configuración vence el {timestampLabel(enrollment.expiresAt)}.</small></p>
        <form className="stack-form" onSubmit={confirmEnrollment}>
          <label>Código de 6 dígitos<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>
          {error && <p className="message error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy}>{busy ? 'Verificando…' : 'Confirmar y activar'}</button>
        </form>
      </div>
    );
  }
  return (
    <div className="stack-form">
      {pending && <p className="message error">Hay una configuración incompleta. Iniciá una nueva para reemplazarla.</p>}
      <p>Usá una app autenticadora compatible con códigos TOTP.</p>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="button" className="button primary" disabled={busy} onClick={() => void beginEnrollment()}>{busy ? 'Preparando…' : 'Configurar segundo factor'}</button>
    </div>
  );
}

function MfaAccessGate({ user, onAuthenticated, onLogout }: { user: User; onAuthenticated: (user: User) => void; onLogout: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function logout() {
    setError(''); setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      onLogout();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cerrar la sesión.'); }
    finally { setBusy(false); }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      onAuthenticated(await api<User>('/auth/mfa/verify', {
        method: 'POST', body: JSON.stringify({ code: form.get('code') }),
      }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos verificar el código.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="access-layout">
      <section className="access-story"><Brand /><div><p className="eyebrow">Acceso protegido</p><h1>Confirmá que sos vos.</h1><p className="lead">Tu historial salarial queda bloqueado hasta completar este paso.</p></div></section>
      <section className="access-panel" aria-labelledby="mfa-access-title"><div className="access-card">
        <p className="eyebrow">{user.email}</p>
        <h2 id="mfa-access-title">{user.authState === 'MFA_SETUP_REQUIRED' ? 'Activá el segundo factor' : 'Ingresá tu segundo factor'}</h2>
        {user.authState === 'MFA_SETUP_REQUIRED'
          ? <MfaEnrollment onComplete={async () => onAuthenticated(await api<User>('/auth/me'))} />
          : <form className="stack-form" onSubmit={verify}>
              <label>Código de la app o de recuperación<input name="code" autoComplete="one-time-code" maxLength={39} required autoFocus /></label>
              {error && <p className="message error" role="alert">{error}</p>}
              <button className="button primary" disabled={busy}>{busy ? 'Verificando…' : 'Continuar'}</button>
            </form>}
        {user.authState === 'MFA_SETUP_REQUIRED' && error && <p className="message error" role="alert">{error}</p>}
        <div className="access-actions"><button className="text-button" disabled={busy} onClick={logout}>{busy ? 'Cerrando…' : 'Cerrar sesión'}</button></div>
      </div></section>
    </main>
  );
}

function OnboardingScreen({ user, onComplete, onLogout }: { user: User; onComplete: (user: User) => void; onLogout: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function complete() {
    setError(''); setBusy(true);
    try { onComplete(await api<User>('/auth/onboarding/complete', { method: 'POST', body: '{}' })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos completar la bienvenida.'); }
    finally { setBusy(false); }
  }

  async function logout() {
    setError(''); setBusy(true);
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); onLogout(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cerrar la sesión.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="access-layout">
      <section className="access-story"><Brand /><div><p className="eyebrow">Tu espacio privado</p><h1>Todo listo para empezar.</h1><p className="lead">Tu cuenta ya está protegida. Ahora podés construir tu historia laboral y salarial.</p></div></section>
      <section className="access-panel" aria-labelledby="onboarding-title"><div className="access-card stack-form">
        <p className="eyebrow">{user.email}</p>
        <h2 id="onboarding-title">Bienvenido{user.displayName ? `, ${user.displayName}` : ''}</h2>
        <p>Empezá agregando un empleo o importando tu primer recibo. Tus datos son privados por defecto.</p>
        {error && <p className="message error" role="alert">{error}</p>}
        <button className="button primary" disabled={busy} onClick={complete}>{busy ? 'Preparando…' : 'Entrar a mi espacio'}</button>
        <button className="text-button" disabled={busy} onClick={logout}>Cerrar sesión</button>
      </div></section>
    </main>
  );
}

function LegalAcceptanceScreen({ user, onAccepted, onLogout, onDeletionRequested }: {
  user: User;
  onAccepted: (user: User) => void;
  onLogout: () => void;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [versions, setVersions] = useState<{ terms: string; privacy: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manageData, setManageData] = useState(false);
  const sensitiveActions = useSensitiveActions();

  useEffect(() => {
    loadLegalVersions()
      .then(setVersions)
      .catch(() => setError('No pudimos cargar los documentos legales vigentes.'));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!versions) return;
    setError(''); setBusy(true);
    try {
      onAccepted(await api<User>('/auth/legal-acknowledgements', {
        method: 'POST',
        body: JSON.stringify({
          acceptedTerms: true,
          acknowledgedPrivacy: true,
          termsVersion: versions.terms,
          privacyVersion: versions.privacy,
        }),
      }));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'LEGAL_DOCUMENTS_CHANGED') {
        try {
          setVersions(await loadLegalVersions());
          formElement.reset();
        } catch {
          setVersions(null);
        }
      }
      setError(caught instanceof Error ? caught.message : 'No pudimos registrar tu decisión.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setError(''); setBusy(true);
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); onLogout(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cerrar la sesión.'); }
    finally { setBusy(false); }
  }

  if (manageData) {
    return <div>
      <main className="page narrow-page settings-page" inert={sensitiveActions.open ? true : undefined} aria-hidden={sensitiveActions.open || undefined}>
        <header className="legal-header"><Brand /><button type="button" className="text-button" onClick={() => setManageData(false)}>Volver a los documentos</button></header>
        <PageHeader eyebrow="Tus derechos" title="Gestionar mis datos" />
        <p className="page-intro">Podés exportar tus datos o eliminar tu cuenta sin aceptar los documentos nuevos.</p>
        <PrivacySettings runSensitive={sensitiveActions.runSensitive} />
        <AccountSettings user={user} runSensitive={sensitiveActions.runSensitive} onDeletionRequested={onDeletionRequested} />
        <button type="button" className="text-button" disabled={busy} onClick={logout}>Cerrar sesión</button>
      </main>
      {sensitiveActions.open && <StepUpDialog
        mfaEnabled={Boolean(user.mfaEnabled)}
        onClose={() => sensitiveActions.finish(false)}
        onComplete={() => sensitiveActions.finish(true)}
        returnFocus={sensitiveActions.returnFocus}
      />}
    </div>;
  }

  return (
    <main className="access-layout">
      <section className="access-story"><Brand /><div><p className="eyebrow">Tus datos, bajo tu control</p><h1>Actualizamos los documentos legales.</h1><p className="lead">Revisá las versiones vigentes antes de seguir usando Salarivo.</p></div></section>
      <section className="access-panel" aria-labelledby="legal-acceptance-title"><div className="access-card stack-form">
        <p className="eyebrow">{user.email}</p>
        <h2 id="legal-acceptance-title">Revisá y aceptá los cambios</h2>
        <form onSubmit={submit} className="stack-form">
          <div className="legal-checks">
            <div className="legal-check"><input id="accepted-current-terms" name="acceptedTerms" type="checkbox" required /><span><label htmlFor="accepted-current-terms">Acepto los Términos de uso{versions ? ` v${versions.terms}` : ''}.</label> <a href={versions ? `/terms?version=${encodeURIComponent(versions.terms)}` : '/terms'} target="_blank" rel="noreferrer">Leer documento</a></span></div>
            <div className="legal-check"><input id="acknowledged-current-privacy" name="acknowledgedPrivacy" type="checkbox" required /><span><label htmlFor="acknowledged-current-privacy">Confirmo que leí el Aviso de privacidad{versions ? ` v${versions.privacy}` : ''}.</label> <a href={versions ? `/privacy?version=${encodeURIComponent(versions.privacy)}` : '/privacy'} target="_blank" rel="noreferrer">Leer documento</a></span></div>
          </div>
          {error && <p className="message error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy || !versions}>{busy ? 'Guardando…' : 'Aceptar y continuar'}</button>
        </form>
        <button type="button" className="text-button" disabled={busy} onClick={() => setManageData(true)}>Gestionar mis datos sin aceptar</button>
        <button className="text-button" disabled={busy} onClick={logout}>Cerrar sesión</button>
      </div></section>
    </main>
  );
}

type AccessMode = 'login' | 'google-register' | 'deletion';

function AccessScreen({ initialError, initialMode, onAuthenticated, onGoogleRegistrationCancelled, onReceiptToken }: {
  initialError: string;
  initialMode: 'login' | 'google-register';
  onAuthenticated: (user: User) => void;
  onGoogleRegistrationCancelled: () => void;
  onReceiptToken: (token: string) => void;
}) {
  const [mode, setMode] = useState<AccessMode>(initialMode);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [legalVersions, setLegalVersions] = useState<{ terms: string; privacy: string } | null>(null);
  const [legalError, setLegalError] = useState('');
  const legalRegistration = mode === 'google-register';

  useEffect(() => {
    loadLegalVersions()
      .then(setLegalVersions)
      .catch(() => setLegalError('No pudimos cargar los documentos legales vigentes.'));
  }, []);

  function changeMode(next: AccessMode) {
    if (mode === 'google-register' && next !== 'google-register') onGoogleRegistrationCancelled();
    setError('');
    setMode(next);
  }

  async function startGoogle() {
    setError(''); setGoogleBusy(true);
    try { await redirectToGoogle('/auth/google/start'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar sesión con Google.'); }
    finally { setGoogleBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError('');
    setBusy(true);
    const form = new FormData(formElement);
    try {
      if (mode === 'deletion') {
        onReceiptToken(String(form.get('token')));
      } else if (mode === 'google-register') {
        if (!legalVersions) throw new Error('Esperá a que carguen los documentos legales.');
        onAuthenticated(await api<User>('/auth/google/register', {
          method: 'POST',
          body: JSON.stringify({
            acceptedTerms: form.get('acceptedTerms') === 'on',
            acknowledgedPrivacy: form.get('acknowledgedPrivacy') === 'on',
            termsVersion: legalVersions.terms,
            privacyVersion: legalVersions.privacy,
          }),
        }));
      }
    } catch (caught) {
      if (legalRegistration && caught instanceof ApiError && caught.status === 409) {
        try {
          setLegalVersions(await loadLegalVersions());
          formElement.reset();
        } catch {
          setLegalError('No pudimos actualizar los documentos legales vigentes.');
        }
      }
      setError(caught instanceof Error ? caught.message : 'No pudimos continuar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="access-layout">
      <section className="access-story">
        <Brand />
        <div>
          <p className="eyebrow">Tu carrera, bajo tu control</p>
          <h1>Convertí recibos dispersos en una historia salarial clara.</h1>
          <p className="lead">Salarivo organiza tus empleos y liquidaciones sin hacer pública tu información ni compartirla con otros usuarios.</p>
        </div>
        <ul className="trust-list">
          <li>Archivos privados y análisis asíncrono</li>
          <li>Importación masiva con progreso por recibo</li>
          <li>Vos corregís, exportás y eliminás tus datos</li>
        </ul>
      </section>
      <section className="access-panel" aria-labelledby="access-title">
        <div className="access-card">
          <p className="eyebrow">Espacio privado</p>
          <h2 id="access-title">{mode === 'google-register' ? 'Completá tu registro' : mode === 'deletion' ? 'Comprobante de eliminación' : 'Ingresá a Salarivo'}</h2>
          <form onSubmit={submit} className="stack-form">
            {mode === 'login' && <><button type="button" className="button secondary google-button" disabled={googleBusy || busy} onClick={startGoogle}><GoogleIcon />{googleBusy ? 'Abriendo Google…' : 'Continuar con Google'}</button><p className="auth-hint">Usá Google para ingresar o crear tu cuenta.</p></>}
            {mode === 'google-register' && <p>Google verificó tu identidad. Revisá los documentos vigentes para crear tu cuenta.</p>}
            {mode === 'deletion' && <label>Token del comprobante<input name="token" autoComplete="off" pattern="[A-Za-z0-9_-]{43}" minLength={43} maxLength={43} required autoFocus /></label>}
            {legalRegistration && <div className="legal-checks">
              <div className="legal-check"><input id="accepted-terms" name="acceptedTerms" type="checkbox" required /><span><label htmlFor="accepted-terms">Acepto los Términos de uso{legalVersions ? ` v${legalVersions.terms}` : ''} y autorizo expresamente el tratamiento de mis datos sólo para las funciones que solicite, según el Aviso de privacidad{legalVersions ? ` v${legalVersions.privacy}` : ''}.</label> <a href={legalVersions ? `/terms?version=${encodeURIComponent(legalVersions.terms)}` : '/terms'} target="_blank" rel="noreferrer">Leer documento</a></span></div>
              <div className="legal-check"><input id="acknowledged-privacy" name="acknowledgedPrivacy" type="checkbox" required /><span><label htmlFor="acknowledged-privacy">Confirmo que leí el Aviso de privacidad{legalVersions ? ` v${legalVersions.privacy}` : ''}.</label> <a href={legalVersions ? `/privacy?version=${encodeURIComponent(legalVersions.privacy)}` : '/privacy'} target="_blank" rel="noreferrer">Leer documento</a></span></div>
            </div>}
            {legalRegistration && legalError && <p className="message error" role="alert">{legalError}</p>}
            {error && <p className="message error" role="alert">{error}</p>}
            {mode !== 'login' && <button className="button primary" disabled={busy || googleBusy || (legalRegistration && !legalVersions)}>{busy ? 'Procesando…' : mode === 'google-register' ? 'Aceptar y crear cuenta' : 'Consultar estado'}</button>}
          </form>
          <footer className="access-footer">
            {mode === 'login' ? <button type="button" className="text-button" onClick={() => changeMode('deletion')}>Consultar comprobante de eliminación</button> : <button type="button" className="text-button" onClick={() => changeMode('login')}>Volver al ingreso</button>}
            <nav aria-label="Documentos legales"><a className="inline-link" href="/terms" target="_blank" rel="noreferrer">Términos de uso</a><a className="inline-link" href="/privacy" target="_blank" rel="noreferrer">Aviso de privacidad</a></nav>
          </footer>
        </div>
      </section>
    </main>
  );
}

type Section = 'summary' | 'jobs' | 'import' | 'history' | 'settings';
type AppNavigationOptions = { currencyCode?: string | null; employmentContext?: string | null; employmentId?: string | null; tab?: HistoryTab; period?: string | null; perspective?: EconomicPerspective | null; range?: (typeof evolutionRanges)[number][0] };
type NavigateApp = (section: Section, options?: AppNavigationOptions) => void;
const sections: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'summary', label: 'Resumen', icon: '⌂' },
  { id: 'jobs', label: 'Empleos', icon: '▣' },
  { id: 'import', label: 'Importar', icon: '↑' },
  { id: 'history', label: 'Historial', icon: '≋' },
  { id: 'settings', label: 'Configuración', icon: '⚙' },
];

function useSensitiveActions() {
  const gate = useRef<StepUpGate | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const runSensitive = useCallback<RunSensitive>(async (action) => {
    const callerFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (;;) {
      try { await action(); return; }
      catch (caught) {
        if (!(caught instanceof ApiError) || caught.code !== 'STEP_UP_REQUIRED') throw caught;
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        if (!gate.current) {
          returnFocus.current = callerFocus;
          gate.current = createStepUpGate();
          setOpen(true);
        }
        if (!await gate.current.promise) return;
      }
    }
  }, []);
  const finish = useCallback((approved: boolean) => {
    const current = gate.current;
    gate.current = null;
    setOpen(false);
    current?.complete(approved);
  }, []);
  return { finish, open, returnFocus: returnFocus.current, runSensitive };
}

function PrivateApp({ user, authNotice, onAuthNoticeDismiss, onUserChanged, onLogout, onDeletionRequested }: {
  user: User;
  authNotice: string;
  onAuthNoticeDismiss: () => void;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [ownerLocation, setOwnerLocation] = useState<OwnerLocation>(() => {
    const next = readOwnerLocation(window.location.search);
    return readDocumentLocation(window.location.search) ? { ...next, section: 'history', tab: 'documents' } : next;
  });
  const [section, setSection] = useState<Section>(() => readDocumentLocation(window.location.search) ? 'history' : readOwnerLocation(window.location.search).section ?? 'summary');
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const sensitiveActions = useSensitiveActions();
  const [importBusy, setImportBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const visibleSections = sections;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 780px)');
    const update = () => setMobileNavigation(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let timer = 0;
    const sync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
      const documentLocation = readDocumentLocation(window.location.search);
      const next = readOwnerLocation(window.location.search);
      setOwnerLocation(documentLocation ? { ...next, section: 'history', tab: 'documents' } : next);
      setSection(documentLocation ? 'history' : next.section ?? 'summary');
      });
    };
    window.addEventListener('popstate', sync);
    return () => { window.clearTimeout(timer); window.removeEventListener('popstate', sync); };
  }, []);

  useEffect(() => {
    if (!readDocumentLocation(window.location.search)) return;
    const nextSearch = writeOwnerLocation(window.location.search, { section: 'history', tab: 'documents' });
    if (nextSearch !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${nextSearch}${window.location.hash}`);
    }
  }, []);

  useEffect(() => {
    if (!importBusy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [importBusy]);

  const navigate = useCallback<NavigateApp>((nextSection, options = {}) => {
    const withoutDocument = writeDocumentLocation(window.location.search, null);
    const nextSearch = writeOwnerLocation(withoutDocument, {
      currencyCode: options.currencyCode ?? null,
      section: nextSection,
      employmentContext: options.employmentContext ?? null,
      employmentId: options.employmentId ?? null,
      tab: nextSection === 'history' ? options.tab ?? 'summary' : null,
      period: nextSection === 'history' ? options.period ?? null : null,
      perspective: nextSection === 'history' ? options.perspective ?? null : null,
      range: nextSection === 'history' ? options.range ?? null : null,
      year: null,
      documentType: null,
      settlementType: null,
      status: null,
    });
    window.history.pushState(window.history.state, '', `${window.location.pathname}${nextSearch}${window.location.hash}`);
    setOwnerLocation(readOwnerLocation(nextSearch));
    setSection(nextSection);
  }, []);

  const updateHistoryLocation = useCallback((patch: OwnerLocationPatch, replace = false, preserveDocument = false) => {
    const baseSearch = preserveDocument ? window.location.search : writeDocumentLocation(window.location.search, null);
    const nextSearch = writeOwnerLocation(baseSearch, { section: 'history', ...patch });
    if (replace) window.history.replaceState(window.history.state, '', `${window.location.pathname}${nextSearch}${window.location.hash}`);
    else window.history.pushState(window.history.state, '', `${window.location.pathname}${nextSearch}${window.location.hash}`);
    setOwnerLocation(readOwnerLocation(nextSearch));
    setSection('history');
  }, []);

  async function logout() {
    setLogoutError(''); setLogoutBusy(true);
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      onLogout();
    } catch (caught) { setLogoutError(caught instanceof Error ? caught.message : 'No pudimos cerrar la sesión.'); }
    finally { setLogoutBusy(false); }
  }

  return (
    <div className="app-shell">
      <aside id="private-navigation" className={menuOpen ? 'sidebar open' : 'sidebar'} inert={sensitiveActions.open || (mobileNavigation && !menuOpen) ? true : undefined} aria-hidden={sensitiveActions.open || (mobileNavigation && !menuOpen) || undefined}>
        <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú">×</button></div>
        <nav aria-label="Navegación principal">
          {visibleSections.map((item) => <button key={item.id} className={section === item.id ? 'nav-item active' : 'nav-item'} aria-current={section === item.id ? 'page' : undefined} disabled={importBusy} onClick={() => { navigate(item.id); setMenuOpen(false); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
          {user.role === 'ADMIN' && <Link className="nav-item" href="/admin" aria-disabled={importBusy} tabIndex={importBusy ? -1 : undefined} onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (importBusy) event.preventDefault(); }}><span aria-hidden="true">⚙</span>Administración</Link>}
        </nav>
        <div className="privacy-slot"><PrivacyToggle /></div>
        {logoutError && <p className="message error" role="alert">{logoutError}</p>}
        <div className="sidebar-user">
          <span className="avatar">{(user.displayName || user.email).slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.displayName || 'Mi cuenta'}</strong><small>{user.email}</small></span>
          <button className="icon-button" disabled={logoutBusy || importBusy} onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">{logoutBusy ? '…' : '↪'}</button>
        </div>
      </aside>
      {menuOpen && <button className="backdrop" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} />}
      <main className="content" inert={sensitiveActions.open ? true : undefined} aria-hidden={sensitiveActions.open || undefined}>
        <header className="mobile-header"><button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menú" aria-expanded={menuOpen} aria-controls="private-navigation">☰</button><Brand /><PrivacyToggle /></header>
        {authNotice && <p className="message success" aria-live="polite">{authNotice} <button type="button" className="text-button" onClick={onAuthNoticeDismiss}>Cerrar</button></p>}
        {section === 'summary' && <Summary key={refreshKey} user={user} onNavigate={navigate} />}
        {section === 'jobs' && <Employments key={refreshKey} selectedLocation={ownerLocation} onNavigate={navigate} runSensitive={sensitiveActions.runSensitive} />}
        {section === 'import' && <Importer onBusyChange={setImportBusy} onDone={() => setRefreshKey((n) => n + 1)} />}
        {section === 'history' && <History key={refreshKey} initialLocation={ownerLocation} onLocationChange={updateHistoryLocation} runSensitive={sensitiveActions.runSensitive} />}
        {section === 'settings' && <Settings user={user} onUserChanged={onUserChanged} runSensitive={sensitiveActions.runSensitive} onDeletionRequested={onDeletionRequested} />}
      </main>
      {sensitiveActions.open && <StepUpDialog
        mfaEnabled={Boolean(user.mfaEnabled)}
        onClose={() => sensitiveActions.finish(false)}
        onComplete={() => sensitiveActions.finish(true)}
        returnFocus={sensitiveActions.returnFocus}
      />}
    </div>
  );
}

function StepUpDialog({ mfaEnabled, onClose, onComplete, returnFocus }: { mfaEnabled: boolean; onClose: () => void; onComplete: () => void; returnFocus: HTMLElement | null }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const returnTarget = useRef(returnFocus);

  useEffect(() => () => {
    window.requestAnimationFrame(() => {
      const target = returnTarget.current;
      let restored = false;
      if (target && target !== document.body && target.isConnected && !target.matches(':disabled') && !target.closest('[inert]')) {
        target.focus();
        restored = document.activeElement === target;
      }
      if (!restored) {
        document.querySelector<HTMLElement>('[role="dialog"] button:not([disabled]), [role="dialog"][tabindex], main button:not([disabled])')?.focus();
      }
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const value = form.get('credential');
    try {
      await api('/auth/step-up', {
        method: 'POST', body: JSON.stringify({ code: value }),
      });
      onComplete();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos confirmar tu identidad.'); }
    finally { setBusy(false); }
  }

  async function startGoogleStepUp() {
    setError(''); setBusy(true);
    try { await redirectToGoogle('/auth/google/step-up/start'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos confirmar tu identidad con Google.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="step-up-title" tabIndex={-1} autoFocus onKeyDown={(event) => { if (!busy) handleDialogKey(event, onClose); }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">Acción sensible</p><h2 id="step-up-title">Confirmá tu identidad</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Cerrar">×</button></div>
        {!mfaEnabled ? <div className="stack-form">
          <p>Volvé a confirmar tu cuenta de Google para continuar.</p>
          {error && <p className="message error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button type="button" className="button primary google-button" disabled={busy} onClick={startGoogleStepUp}><GoogleIcon />{busy ? 'Abriendo Google…' : 'Continuar con Google'}</button></div>
        </div> : <form className="stack-form" onSubmit={submit}>
          <label>Código de la app o de recuperación<input name="credential" type="text" autoComplete="one-time-code" maxLength={39} required autoFocus /></label>
          {error && <p className="message error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Confirmando…' : 'Continuar'}</button></div>
        </form>}
      </section>
    </div>
  );
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</header>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">∿</span><h3>{title}</h3><p>{body}</p>{action}</div>;
}

function ReprocessingBanner({ availableCandidates, batch, batchLimit = 100, busy, candidates, error, loading, onDismiss, onRetry, onReview, onStart, reviewCandidates }: {
  batch: ReprocessingBatch | null;
  busy: boolean;
  candidates: number;
  availableCandidates: number;
  batchLimit?: number;
  error: string;
  loading: boolean;
  reviewCandidates: number;
  onDismiss: () => void;
  onRetry: () => void;
  onReview: () => void;
  onStart: () => void;
}) {
  if (loading) return <aside className="reprocessing-banner quiet" role="status"><span className="loader" aria-hidden="true" /><div><strong>Consultando mejoras…</strong><small>Tu historial sigue disponible.</small></div></aside>;
  if (error && !batch) return <aside className="reprocessing-banner partial" aria-live="polite"><div><strong>No pudimos actualizar las recomendaciones</strong><small>{error}</small></div><button type="button" className="button secondary" onClick={onRetry}>Reintentar</button></aside>;
  const active = batchIsActive(batch);
  const resolved = batch ? batchResolved(batch) : 0;
  if (!batch && candidates === 0) return <aside className="reprocessing-banner quiet" aria-live="polite"><span aria-hidden="true">✓</span><div><strong>Análisis al día</strong><small>No hay documentos con una mejora compatible pendiente.</small></div></aside>;
  if (!batch && availableCandidates === 0) return <aside className="reprocessing-banner" aria-live="polite" aria-busy="true"><span className="loader" aria-hidden="true" /><div><strong>Buscando mejoras</strong><small>Hay {candidates} documento{candidates === 1 ? '' : 's'} en proceso; cada análisis activo sigue disponible.</small></div></aside>;
  const batchSize = Math.min(availableCandidates, batchLimit);
  const reviewRequired = Boolean(batch && !active && batch.progress.reviewRequired > 0 && reviewCandidates > 0);
  const outcome = batch && !active
    ? `${batch.progress.improved} mejorado${batch.progress.improved === 1 ? '' : 's'} · ${batch.progress.unchanged} sin cambios · ${batch.progress.reviewRequired} para revisar · ${batch.progress.failed} con error · ${batch.progress.skipped} conservado${batch.progress.skipped === 1 ? '' : 's'}`
    : null;
  return <aside className={`reprocessing-banner${batch?.status === 'FAILED' ? ' failed' : batch?.status === 'PARTIAL' ? ' partial' : ''}`} aria-live="polite" aria-busy={active}>
    <div><strong>{active ? 'Mejorando documentos' : candidates === 1 ? 'Hay una mejora disponible' : candidates > 1 ? `Hay mejoras para ${candidates} documentos` : 'Lote finalizado'}</strong><small>{active ? 'Cada resultado se compara por separado; el análisis activo no se pierde.' : outcome ?? 'Una versión nueva puede recuperar datos que hoy figuran como N/D.'}</small></div>
    {error && <div><strong>No pudimos actualizar el progreso</strong><small>{error}</small><button type="button" className="text-button" onClick={onRetry}>Reintentar</button></div>}
    {batch && <div className="reprocessing-progress"><progress max={Math.max(1, batch.progress.total)} value={resolved} aria-label="Progreso del reprocesamiento" /><span>{resolved}/{batch.progress.total}</span></div>}
    {!active && (reviewRequired || availableCandidates > 0 || batch) && <div className="reprocessing-actions">
      {reviewRequired && <button type="button" className="button primary" onClick={onReview}>Ir a revisar</button>}
      {availableCandidates > 0 && <button type="button" className={`button ${reviewRequired ? 'secondary' : 'primary'}`} disabled={busy} onClick={onStart}>{busy ? 'Iniciando…' : batchSize === 1 ? 'Buscar mejora' : candidates > batchLimit ? `Mejorar ${batchSize} de los primeros ${batchLimit}` : `Mejorar ${batchSize} documentos`}</button>}
      {batch && <button type="button" className="button secondary" onClick={onDismiss}>Cerrar</button>}
    </div>}
  </aside>;
}

function salaryScopeKey(context: SalaryContext) {
  return JSON.stringify([context.employmentContext, context.currencyCode]);
}

function salaryScopeForContext(history: SalaryHistory, context?: SalaryContext) {
  return context
    ? history.analytics.scopes.find((scope) => scope.employmentContext === context.employmentContext
      && scope.currencyCode === context.currencyCode)
    : undefined;
}

function appendSalaryContext(query: URLSearchParams, context: SalaryContext) {
  const stableDetectedContext = /^detected:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.employmentContext);
  const employerName = context.state === 'DETECTED' ? context.employerName ?? '' : '';
  if (context.employmentContext.startsWith('detected:') && !stableDetectedContext && !employerName) return false;
  query.set('employmentContext', context.employmentContext);
  query.set('currencyCode', context.currencyCode);
  if (!stableDetectedContext && employerName) query.set('employerName', employerName);
  return true;
}

function salaryConceptPath(context: SalaryContext | undefined, year: string, category: 'all' | SalaryCategory, cursor?: string) {
  if (!context) return null;
  const query = new URLSearchParams({ limit: '100' });
  if (!appendSalaryContext(query, context)) return null;
  if (year !== 'all') query.set('year', year);
  if (category !== 'all') query.set('category', category);
  if (cursor) query.set('cursor', cursor);
  return `/salary-history/concepts?${query}`;
}

function retainedSalaryScopeKey(current: string, history: SalaryHistory) {
  return history.contexts.some((context) => salaryScopeKey(context) === current)
    ? current
    : history.contexts[0] ? salaryScopeKey(history.contexts[0]) : '';
}

function locationSalaryContext(history: SalaryHistory, location: Pick<OwnerLocation, 'currencyCode' | 'employmentContext' | 'employmentId'>) {
  return history.contexts.find((context) => salaryContextIdentityMatches(context, location));
}

function effectiveSalaryContext(history: SalaryHistory, location: Pick<OwnerLocation, 'currencyCode' | 'employmentContext' | 'employmentId'>, retainedKey: string) {
  const requested = locationSalaryContext(history, location);
  if (requested) return requested;
  if (!location.employmentId && !location.employmentContext) return history.contexts[0];
  return history.contexts.find((context) => salaryScopeKey(context) === retainedKey) ?? history.contexts[0];
}

function salaryLocationMatchesContext(location: Pick<OwnerLocation, 'currencyCode' | 'employmentContext' | 'employmentId'>, context?: SalaryContext) {
  return (location.currencyCode ?? null) === (context?.currencyCode ?? null)
    && (location.employmentContext ?? null) === (context?.employmentContext ?? null)
    && (location.employmentId ?? null) === (context?.employmentId ?? null);
}

function SalaryScopeControl({ history, employments = [], selectedKey, onChange, id }: {
  history: SalaryHistory;
  employments?: Employment[];
  selectedKey: string;
  onChange: (key: string) => void;
  id: string;
}) {
  const [query, setQuery] = useState('');
  const context = history.contexts.find((item) => salaryScopeKey(item) === selectedKey) ?? history.contexts[0];
  if (!context) return null;
  const employmentById = new Map(employments.map((employment) => [employment.id, employment]));
  const filtered = history.contexts.filter((item) => salaryContextMatches(item, query, item.employmentId ? employmentById.get(item.employmentId) : null));
  const grouped = [
    ['FAVORITAS', filtered.filter((item) => item.isFavorite)],
    ['ACTUAL', filtered.filter((item) => !item.isFavorite && item.employmentStatus === 'ACTIVE')],
    ['ANTERIORES', filtered.filter((item) => !item.isFavorite && item.employmentStatus === 'ENDED')],
    ['SIN CONFIRMAR', filtered.filter((item) => !item.isFavorite && item.employmentStatus !== 'ACTIVE' && item.employmentStatus !== 'ENDED')],
  ] as const;
  const optionLabel = (item: SalaryContext) => {
    const employment = item.employmentId ? employmentById.get(item.employmentId) : undefined;
    return employment ? employmentOptionLabel(employment) : salaryContextOptionLabel(item);
  };
  const status = context.state === 'CONFIRMED' ? 'Confirmado' : context.state === 'DETECTED' ? 'Detectado' : 'Sin confirmar';
  const range = context.firstPeriod && context.lastPeriod
    ? `${periodLabel(context.firstPeriod)} a ${periodLabel(context.lastPeriod)}`
    : 'Período no disponible';
  return <section className="scope-control" aria-label="Contexto salarial">
    <div className="scope-picker"><label htmlFor={`${id}-search`}>Empleo y moneda</label>{history.contexts.length > 1
      ? <><input id={`${id}-search`} type="search" value={query} placeholder="Buscar empresa, puesto, año, período o estado" autoComplete="off" onChange={(event) => setQuery(event.target.value)} /><select id={id} aria-label="Contexto salarial seleccionado" value={filtered.some((item) => salaryScopeKey(item) === salaryScopeKey(context)) ? salaryScopeKey(context) : ''} onChange={(event) => onChange(event.target.value)}><option value="" disabled>{filtered.length ? 'Elegí un empleo' : 'Sin coincidencias'}</option>{grouped.map(([label, items]) => items.length ? <optgroup label={label} key={label}>{items.map((item) => <option value={salaryScopeKey(item)} key={salaryScopeKey(item)}>{optionLabel(item)}</option>)}</optgroup> : null)}</select></>
      : <strong>{optionLabel(context)}</strong>}</div>
    <div className="scope-meta">{context.isFavorite && <span className="status ready">Favorita</span>}<span className={`status ${context.state === 'CONFIRMED' ? 'ready' : 'pending'}`}>{status}</span><span>{range}</span></div>
  </section>;
}

function SalaryContextNotice({ context }: { context: SalaryContext }) {
  if (context.state === 'CONFIRMED') return null;
  return <p className="message warning" role="status">{context.state === 'DETECTED'
    ? 'Este análisis corresponde a una empresa detectada en recibos todavía sin asociar. Confirmá el empleo para consolidar su historial.'
    : 'Este análisis contiene recibos sin empresa confirmada. No se compara con otros contextos hasta que los asocies.'}</p>;
}

type SalaryRecoveryState = 'available' | 'processing' | 'partial';

const economicStatusLabels: Record<EconomicStatus, string> = {
  AVAILABLE: 'Disponible',
  PARTIAL: 'Parcial',
  PENDING: 'En preparación',
  UNAVAILABLE: 'No disponible',
};

function economicStatusClass(status: EconomicStatus) {
  return status === 'AVAILABLE' ? 'ready' : status === 'UNAVAILABLE' ? 'danger' : 'pending';
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const economicSelectionLabels: Record<EconomicObservation['selectionMethod'], string> = {
  PAYMENT_DATE: 'Fecha de pago',
  ISSUE_DATE: 'Fecha de emisión (alternativa sin fecha de pago)',
  PAYROLL_PERIOD_END: 'Fin del período (alternativa sin fechas del recibo)',
  EXACT_PERIOD: 'Período mensual exacto',
  LATEST_AVAILABLE: 'Última observación disponible',
};

function economicRequestedDateLabel(value: string) {
  return value === 'latest' ? 'Última disponible' : dateLabel(value);
}

function EconomicEvidence({ observations, referencePeriod }: { observations: EconomicObservation[]; referencePeriod?: string | null }) {
  if (!observations.length && !referencePeriod) return null;
  return <details className="economic-evidence">
    <summary>Fuente y metodología</summary>
    {referencePeriod && <p>Período de referencia: <strong>{periodLabel(referencePeriod)}</strong></p>}
    {observations.length ? <ul>{observations.map((observation, index) => {
      const sourceUrl = safeExternalUrl(observation.sourceUrl);
      const licenseUrl = safeExternalUrl(observation.licenseUrl);
      return <li key={`${observation.seriesCode}-${observation.observationDate}-${observation.revision}-${index}`}>
        <strong>{observation.source || observation.provider || observation.seriesCode}</strong>
        <dl><div><dt>Serie</dt><dd>{observation.seriesCode}</dd></div><div><dt>ID del proveedor</dt><dd>{observation.externalSeriesId}</dd></div><div><dt>Fecha solicitada</dt><dd>{economicRequestedDateLabel(observation.requestedDate)}</dd></div><div><dt>Fecha usada</dt><dd>{dateLabel(observation.observationDate)}{observation.requestedDate !== 'latest' && observation.requestedDate !== observation.observationDate && <small className="economic-fallback">Observación anterior disponible</small>}</dd></div><div><dt>Método</dt><dd>{economicSelectionLabels[observation.selectionMethod]}</dd></div><div><dt>Revisión</dt><dd>{observation.revision}</dd></div><div><dt>Proveedor</dt><dd>{observation.provider || '—'}</dd></div><div><dt>Actualización</dt><dd>{timestampLabel(observation.fetchedAt)}</dd></div></dl>
        {observation.methodology && <p>{observation.methodology}</p>}
        <div className="economic-source-links">{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer">Ver fuente oficial</a>}{licenseUrl && <a href={licenseUrl} target="_blank" rel="noopener noreferrer">Ver licencia de la fuente</a>}</div>
      </li>;
    })}</ul> : <p>No hay observaciones de fuente asociadas a este cálculo.</p>}
  </details>;
}

function SalaryMetricGrid({ scope, context, recoveryPeriods = new Map() }: { scope: SalaryScopeAnalytics; context: SalaryContext; recoveryPeriods?: Map<string, SalaryRecoveryState> }) {
  const current = scope.current;
  const currentYear = current?.period.slice(0, 4) ?? scope.annual[0]?.year;
  const annual = scope.annual.find((item) => item.year === currentYear) ?? null;
  const latest = current?.changes.latest ?? null;
  const ytd = current?.changes.ytd ?? null;
  const coverage = scope.coverage;
  const coverageKnown = coverage && coverage.basis !== 'INDETERMINATE_CONTEXT';
  const currentEvolution = current ? scope.evolution.find((point) => point.period === current.period) : undefined;
  const currentRecovery = current
    ? recoveryPeriods.get(current.period)
      ?? (currentEvolution?.quality?.reprocessableDocuments ? 'available' : currentEvolution?.quality?.incompleteDocuments ? 'partial' : undefined)
    : undefined;
  const recoveryCount = scope.evolution.filter((point) => point.quality?.reprocessableDocuments || recoveryPeriods.has(point.period)).length;
  return <section className="metric-grid salary-metrics" aria-label="Indicadores salariales">
    <article className="metric accent"><small>Básico comparable</small><strong><MoneyValue value={current?.comparableSalary} currency={context.currencyCode} kind="salary" /></strong><span>{currentRecovery && current?.comparableSalary === null ? currentRecovery === 'processing' ? 'Buscando el básico; el valor activo se conserva' : currentRecovery === 'partial' ? 'Análisis incompleto; requiere revisión' : `Podemos volver a buscarlo en ${periodLabel(current.period)}` : current ? periodLabel(current.period) : 'Sin período comparable'}</span></article>
    <article className="metric"><small>Neto actual</small><strong><MoneyValue value={current?.amounts.netAmount} currency={context.currencyCode} kind="salary" /></strong><span>{current ? `${periodLabel(current.period)} · sueldo regular` : 'N/D'}</span></article>
    <article className="metric"><small>Última variación</small><strong><PercentageValue value={latest?.percentage} /></strong><span>{latest ? `${periodLabel(latest.fromPeriod)} → ${periodLabel(latest.toPeriod)}` : recoveryCount ? `${recoveryCount} período${recoveryCount === 1 ? '' : 's'} con recuperación disponible` : 'Sin dos períodos comparables'}</span></article>
    <article className="metric"><small>Variación en el año</small><strong><PercentageValue value={ytd?.percentage} /></strong><span>{ytd ? `Desde ${periodLabel(ytd.fromPeriod)}` : recoveryCount ? 'Puede cambiar cuando terminen las mejoras' : 'Sin base comparable en el año'}</span></article>
    <article className="metric"><small>{annual ? `Cobrado en ${annual.year}` : 'Total anual'}</small><strong><MoneyValue value={annual?.totals.netAmount} currency={context.currencyCode} kind="salary" /></strong><span>{annual ? `${annual.periodCount} período${annual.periodCount === 1 ? '' : 's'} · ${annual.settlementCount} ${annual.settlementCount === 1 ? 'liquidación' : 'liquidaciones'}` : 'N/D'}</span></article>
    <article className="metric"><small>Cobertura</small><strong>{coverageKnown ? `${coverage.availablePeriods.length}/${coverage.expectedPeriods.length}` : 'N/D'}</strong><span>{coverageKnown ? coverage.boundaryContradiction ? 'Límites laborales contradictorios' : coverage.possibleMissingPeriods.length ? `${coverage.possibleMissingPeriods.length} posible${coverage.possibleMissingPeriods.length === 1 ? '' : 's'} faltante${coverage.possibleMissingPeriods.length === 1 ? '' : 's'}` : coverage.basis === 'OBSERVED' ? 'Rango basado en períodos observados' : 'Sin faltantes posibles en el rango' : 'No se puede determinar sin un contexto laboral'}</span></article>
  </section>;
}

function EconomicRealChange({ basisPoints }: { basisPoints?: string | null }) {
  const label = economicTrendLabel(basisPoints);
  if (!label) return <span>N/D</span>;
  return <span className="economic-real-change"><SensitiveValue value={label} mask="Resultado oculto" /> <PercentageValue value={percentageFromBasisPoints(basisPoints)} /></span>;
}

function EconomicProjectionNote({ projection }: { projection?: EconomicProjection }) {
  if (!projection || projection.status === 'AVAILABLE') return null;
  return <small>{economicStatusLabels[projection.status]}: {economicStatusMessage(projection.status, projection.reason)}</small>;
}

function EconomicChangeNote({ change }: { change?: { status: EconomicStatus; reason: EconomicReason } }) {
  if (!change || change.status === 'AVAILABLE') return null;
  return <small>Cambio {economicStatusLabels[change.status].toLocaleLowerCase('es-AR')}: {economicStatusMessage(change.status, change.reason)}</small>;
}

function SalaryEvolution({ scope, year = 'all', limit, perspective = 'nominal', recoveryPeriods = new Map(), selectedPeriod, onSelectPeriod }: { scope: SalaryScopeAnalytics; year?: string; limit?: number; perspective?: EconomicPerspective; recoveryPeriods?: Map<string, SalaryRecoveryState>; selectedPeriod?: string; onSelectPeriod?: (period: string) => void }) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const filtered = year === 'all' ? scope.evolution : scope.evolution.filter((point) => point.period.startsWith(`${year}-`));
  const points = recentPeriodRange(filtered, limit);
  if (!points.length) return <EmptyState title="Sin evolución para mostrar" body="Elegí otro año o importá recibos con datos comparables." />;
  const economic = perspective !== 'nominal';
  const perspectiveLabel = economicPerspectives.find(([value]) => value === perspective)?.[1] ?? 'Nominal';
  const valuesFor = (point: MonthlyEvolution) => {
    const projection = perspective === 'historical-usd' ? point.economic?.historicalUsd : perspective === 'purchasing-power' ? point.economic?.purchasingPower : undefined;
    return {
      comparableSalary: economic ? projection?.comparableSalary ?? null : point.comparableSalary,
      amounts: economic ? projection?.amounts ?? null : point.totals,
      currency: economic ? projection?.currencyCode || scope.currencyCode : scope.currencyCode,
      projection,
    };
  };
  const visualStep = Math.max(1, Math.ceil(points.length / 60));
  const chartPoints = points.filter((_, index) => index % visualStep === 0 || index === points.length - 1);
  const visualValues = chartPoints.flatMap((point) => { const values = valuesFor(point); return [values.comparableSalary, values.amounts?.netAmount ?? null]; })
    .flatMap((value) => value === null ? [] : [Number(value)])
    .filter((value) => Number.isFinite(value) && value > 0);
  const visualMaximum = Math.max(1, ...visualValues);
  const visualHeight = (value: string) => `${Math.max(2, (Number(value) / visualMaximum) * 100)}%`;
  const protectedHeights = privacyChartHeights(chartPoints.flatMap((point) => { const values = valuesFor(point); return [values.comparableSalary, values.amounts?.netAmount ?? null]; }));
  const chartHeight = (value: string, index: number) => privacyEnabled ? protectedHeights[index] ?? '40%' : visualHeight(value);
  const choosePeriod = (period: string) => onSelectPeriod?.(period);
  const standardExactTable = <div className="table-wrap salary-evolution-table" role="region" aria-label={`Tabla de evolución salarial en perspectiva ${perspectiveLabel}`} tabIndex={0}><table><caption className="sr-only">Valores de la evolución salarial en perspectiva {perspectiveLabel}</caption><thead><tr><th>Período</th><th>Básico comparable</th><th>Bruto total</th><th>Neto total</th><th>Descuentos / créditos</th>{economic && <th>Estado</th>}</tr></thead><tbody>{points.map((point) => {
    const recovery = recoveryPeriods.get(point.period) ?? (point.quality?.reprocessableDocuments ? 'available' : point.quality?.incompleteDocuments ? 'partial' : undefined);
    const values = valuesFor(point);
    const status = values.projection?.status ?? 'UNAVAILABLE';
    const reason = values.projection?.reason ?? null;
    return <tr className={selectedPeriod === point.period ? 'selected' : ''} key={point.period} onClick={() => choosePeriod(point.period)}><td data-label="Período"><button type="button" className="period-link" disabled={!onSelectPeriod} onClick={(event) => { event.stopPropagation(); choosePeriod(point.period); }}>{periodLabel(point.period)}</button></td><td data-label="Básico comparable"><MoneyValue value={values.comparableSalary} currency={values.currency} kind="salary" />{!economic && values.comparableSalary === null && recovery && <small className="nd-context">{recovery === 'processing' ? 'Buscando una mejora…' : recovery === 'partial' ? 'Análisis incompleto' : 'Mejora disponible'}</small>}</td><td data-label="Bruto total"><MoneyValue value={values.amounts?.grossAmount} currency={values.currency} kind="salary" /></td><td data-label="Neto total"><MoneyValue value={values.amounts?.netAmount} currency={values.currency} kind="salary" /></td><td data-label="Descuentos / créditos"><MoneyValue value={values.amounts?.deductionsAmount} currency={values.currency} kind="salary" creditAware /></td>{economic && <td data-label="Estado" className="economic-state"><div className="economic-state-content"><span className={`status ${economicStatusClass(status)}`}>{economicStatusLabels[status]}</span><small>{economicStatusMessage(status, reason)}</small></div></td>}</tr>;
  })}</tbody></table></div>;
  const referencePeriod = [...points].reverse().find((point) => point.economic?.purchasingPower.referencePeriod)?.economic?.purchasingPower.referencePeriod ?? null;
  const latestRealPoint = [...points].reverse().find((point) => typeof point.economic?.comparisonToPrevious?.purchasingPower.changeBasisPoints === 'string');
  const latestRealComparison = latestRealPoint?.economic?.comparisonToPrevious ?? null;
  const economicExactTable = <div className="table-wrap salary-evolution-table economic-monthly-table" role="region" aria-label="Evolución económica por período salarial del neto" tabIndex={0}>
    <table>
      <caption className="sr-only">Neto nominal, equivalente histórico en USD, inflación y poder adquisitivo por período</caption>
      <thead><tr><th>Período</th><th>Neto original</th><th>USD histórico</th><th>Inflación desde el período anterior</th><th>{referencePeriod ? `Neto a precios de ${periodLabel(referencePeriod)}` : 'Poder adquisitivo'}</th></tr></thead>
      <tbody>{points.map((point) => {
        const usd = point.economic?.historicalUsd;
        const purchasingPower = point.economic?.purchasingPower;
        const comparison = point.economic?.comparisonToPrevious;
        const fromPeriod = comparison?.fromPeriod;
        return <tr className={selectedPeriod === point.period ? 'selected' : ''} key={point.period} onClick={() => choosePeriod(point.period)}>
          <td data-label="Período"><button type="button" className="period-link" disabled={!onSelectPeriod} onClick={(event) => { event.stopPropagation(); choosePeriod(point.period); }}>{periodLabel(point.period)}</button></td>
          <td data-label="Neto original"><MoneyValue value={point.totals.netAmount} currency={scope.currencyCode} kind="salary" /></td>
          <td data-label="USD histórico"><div className="economic-monthly-value"><MoneyValue value={usd?.amounts?.netAmount} currency={usd?.currencyCode ?? 'USD'} kind="salary" />{fromPeriod && <small>Vs. {periodLabel(fromPeriod)}: <PercentageValue value={percentageFromBasisPoints(comparison?.historicalUsd.changeBasisPoints)} /></small>}<EconomicProjectionNote projection={usd} /><EconomicChangeNote change={comparison?.historicalUsd} /></div></td>
          <td data-label="Inflación desde el período anterior"><div className="economic-monthly-value"><PercentageValue value={percentageFromBasisPoints(comparison?.inflation.changeBasisPoints)} sensitive={false} /><small>{fromPeriod ? `Desde ${periodLabel(fromPeriod)}` : 'Primer período disponible'}</small><EconomicChangeNote change={comparison?.inflation} /></div></td>
          <td data-label={referencePeriod ? `Neto a precios de ${periodLabel(referencePeriod)}` : 'Poder adquisitivo'}><div className="economic-monthly-value"><MoneyValue value={purchasingPower?.amounts?.netAmount} currency={purchasingPower?.currencyCode ?? scope.currencyCode} kind="salary" />{fromPeriod && <small>Vs. {periodLabel(fromPeriod)}: <EconomicRealChange basisPoints={comparison?.purchasingPower.changeBasisPoints} /></small>}<EconomicProjectionNote projection={purchasingPower} /><EconomicChangeNote change={comparison?.purchasingPower} /></div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
  const exactTable = perspective === 'purchasing-power' ? economicExactTable : standardExactTable;
  const economicStates = economic ? points.map((point) => valuesFor(point).projection?.status ?? 'UNAVAILABLE') : [];
  const economicNotice = !economic ? '' : economicStates.includes('PARTIAL')
    ? 'Hay períodos con cobertura parcial. Cada fila indica qué cálculo pudo completarse.'
    : economicStates.every((status) => status === 'PENDING')
      ? 'Los datos económicos se están sincronizando.'
      : economicStates.every((status) => status === 'UNAVAILABLE')
        ? 'Esta perspectiva todavía no tiene cálculos disponibles para el rango elegido.'
        : economicStates.some((status) => status === 'PENDING' || status === 'UNAVAILABLE')
          ? 'Algunos períodos todavía no tienen un cálculo económico disponible.'
          : '';
  return <div className="salary-evolution">
    {economicNotice && <p className="message warning" role="status">{economicNotice}</p>}
    {perspective === 'purchasing-power' && <div className="economic-reading" role="note"><strong>¿El neto total cobrado ganó o perdió poder de compra?</strong>{latestRealPoint && latestRealComparison ? <p>Último cambio real del neto total: <EconomicRealChange basisPoints={latestRealComparison.purchasingPower.changeBasisPoints} /> · {periodLabel(latestRealComparison.fromPeriod)} → {periodLabel(latestRealPoint.period)}.</p> : <p>Todavía no hay dos períodos con datos completos para medir el cambio real.</p>}<p>Cada fila reúne tu neto original, su equivalente histórico en USD, la inflación entre recibos y el neto ajustado por IPC. Aguinaldos, bonos u otras liquidaciones también forman parte del neto total, por lo que este resultado no equivale por sí solo a la evolución del sueldo regular.</p></div>}
    <div className="legend"><span className="comparable">Básico comparable</span><span className="net">Neto total</span></div>
    {visualValues.length > 0 && <div className="bar-chart salary-chart" role="group" aria-label={`Períodos del historial salarial en perspectiva ${perspectiveLabel}`}>{chartPoints.map((point, pointIndex) => { const values = valuesFor(point); return <button type="button" className={`bar-group${selectedPeriod === point.period ? ' selected' : ''}`} aria-label={`Abrir detalle de ${periodLabel(point.period)}`} aria-pressed={selectedPeriod === point.period} disabled={!onSelectPeriod} onClick={() => choosePeriod(point.period)} key={point.period}><span className="chart-tooltip"><span>{periodLabel(point.period)}</span><span>Básico: <MoneyValue value={values.comparableSalary} currency={values.currency} kind="salary" /></span><span>Neto: <MoneyValue value={values.amounts?.netAmount} currency={values.currency} kind="salary" /></span></span><span className="bars" aria-hidden="true">{values.comparableSalary !== null && <i className="bar comparable" style={{ height: chartHeight(values.comparableSalary, pointIndex * 2) }} />}{values.amounts?.netAmount != null && <i className="bar net" style={{ height: chartHeight(values.amounts.netAmount, pointIndex * 2 + 1) }} />}</span><small>{periodLabel(point.period)}</small></button>; })}</div>}
    {chartPoints.length < points.length && <p className="coverage-note">El gráfico muestra {chartPoints.length} puntos seleccionados; la tabla conserva los {points.length} períodos exactos.</p>}
    {points.length > 24 ? <details className="evolution-details"><summary>Ver tabla exacta ({points.length} períodos)</summary>{exactTable}</details> : exactTable}
  </div>;
}

const comparisonAmountLabels: Array<[keyof PeriodComparison['changes'], string]> = [
  ['basicAmount', 'Sueldo básico'],
  ['comparableSalary', 'Básico comparable'],
  ['grossAmount', 'Bruto'],
  ['netAmount', 'Neto'],
  ['deductionsAmount', 'Descuentos / créditos'],
  ['remunerativeAmount', 'Remunerativo'],
  ['nonRemunerativeAmount', 'No remunerativo'],
];

function EconomicComparisonCard({ projection, title }: { projection: EconomicComparisonProjection; title: string }) {
  return <article className="economic-comparison-card">
    <header><h4>{title}</h4><span className={`status ${economicStatusClass(projection.status)}`}>{economicStatusLabels[projection.status]}</span></header>
    <p>{economicStatusMessage(projection.status, projection.reason)}</p>
    <dl className="economic-comparison-values"><div><dt>Antes</dt><dd><MoneyValue value={amountFromCents(projection.earlierComparableNetCents)} currency={projection.currencyCode} kind="salary" /></dd></div><div><dt>Después</dt><dd><MoneyValue value={amountFromCents(projection.laterComparableNetCents)} currency={projection.currencyCode} kind="salary" /></dd></div><div><dt>Diferencia</dt><dd><MoneyValue value={amountFromCents(projection.changeCents)} currency={projection.currencyCode} kind="salary" /></dd></div><div><dt>Variación</dt><dd><PercentageValue value={percentageFromBasisPoints(projection.changeBasisPoints)} /></dd></div></dl>
    <EconomicEvidence observations={projection.observations} referencePeriod={projection.referencePeriod} />
  </article>;
}

function EconomicComparison({ economic }: { economic: NonNullable<PeriodComparison['economic']> }) {
  return <section className="economic-comparison" aria-labelledby="economic-comparison-title">
    <div><p className="eyebrow">Datos económicos</p><h4 id="economic-comparison-title">La misma comparación, en contexto</h4><p>Estos valores derivados no modifican los importes originales del recibo.</p></div>
    <div className="economic-comparison-grid"><EconomicComparisonCard projection={economic.historicalUsd} title="USD histórico" /><EconomicComparisonCard projection={economic.purchasingPower} title="Poder adquisitivo" /><article className="economic-comparison-card"><header><h4>Inflación del período</h4><span className={`status ${economicStatusClass(economic.inflation.status)}`}>{economicStatusLabels[economic.inflation.status]}</span></header><p>{economicStatusMessage(economic.inflation.status, economic.inflation.reason)}</p><dl className="economic-comparison-values"><div><dt>Variación del índice</dt><dd><PercentageValue value={percentageFromBasisPoints(economic.inflation.changeBasisPoints)} sensitive={false} /></dd></div></dl><EconomicEvidence observations={economic.inflation.observations} /></article></div>
  </section>;
}

function ComparisonResult({ comparison }: { comparison: PeriodComparison }) {
  const currency = comparison.currencyCode;
  return <div className="comparison-result" aria-live="polite">
    <p className="comparison-conclusion">{comparison.conclusionCode ? comparisonConclusionLabels[comparison.conclusionCode] : 'Comparación calculada con los importes disponibles.'}</p>
    <div className="table-wrap" role="region" aria-label="Comparación de períodos" tabIndex={0}><table><caption className="sr-only">Comparación de períodos</caption><thead><tr><th>Importe</th><th>{periodLabel(comparison.fromPeriod)}</th><th>{periodLabel(comparison.toPeriod)}</th><th>Diferencia</th><th>Variación</th></tr></thead><tbody>{comparisonAmountLabels.map(([key, label]) => {
      const change = comparison.changes[key];
      return <tr key={key}><th scope="row">{label}</th><td data-label={periodLabel(comparison.fromPeriod)}><MoneyValue value={change?.fromAmount} currency={currency} kind="salary" creditAware={key === 'deductionsAmount'} /></td><td data-label={periodLabel(comparison.toPeriod)}><MoneyValue value={change?.toAmount} currency={currency} kind="salary" creditAware={key === 'deductionsAmount'} /></td><td data-label="Diferencia"><MoneyValue value={change?.deltaAmount} currency={currency} kind="salary" /></td><td data-label="Variación"><PercentageValue value={change?.percentage} /></td></tr>;
    })}</tbody></table></div>
    {comparison.drivers && comparison.drivers.length > 0 && <div className="comparison-drivers"><h4>Qué cambió</h4><ul>{comparison.drivers.map((driver) => <li key={`${driver.type}-${driver.code}`}><span>{driver.type === 'DEDUCTIONS' ? 'Descuentos / créditos' : categoryLabels[driver.category as SalaryCategory] ?? earningLabels[driver.code] ?? 'Ingreso extraordinario'}</span><strong><MoneyValue value={driver.change.deltaAmount} currency={currency} kind="salary" /></strong></li>)}</ul></div>}
    {comparison.driversComplete === false && <p className="coverage-note">Explicación parcial: algún recibo no tiene todos sus conceptos normalizados.</p>}
    {comparison.earnings && comparison.earnings.length > 0 && <details><summary>Ver conceptos normalizados</summary><div className="table-wrap" role="region" aria-label="Conceptos comparados" tabIndex={0}><table><thead><tr><th>Concepto</th><th>Antes</th><th>Después</th><th>Diferencia</th></tr></thead><tbody>{comparison.earnings.map(({ code, change }) => <tr key={code}><td data-label="Concepto">{earningLabels[code] ?? 'Otro concepto'}</td><td data-label="Antes"><MoneyValue value={change.fromAmount} currency={currency} kind="salary" /></td><td data-label="Después"><MoneyValue value={change.toAmount} currency={currency} kind="salary" /></td><td data-label="Diferencia"><MoneyValue value={change.deltaAmount} currency={currency} kind="salary" /></td></tr>)}</tbody></table></div></details>}
    {comparison.economic && <EconomicComparison economic={comparison.economic} />}
  </div>;
}

function AnnualHistory({ rows, scope, category }: { rows: AnnualSalarySummary[]; scope: SalaryScopeAnalytics; category: 'all' | SalaryCategory }) {
  if (!rows.length) return <EmptyState title="Sin datos para ese año" body="Elegí otro año o importá recibos de ese período." />;
  const categories = category === 'all' ? salaryCategories : [category];
  return <div className="annual-list">{rows.map((annual) => {
    const yearCoverage = scope.coverage?.byYear.find((item) => item.year === annual.year);
    return <details className="panel annual-card" key={annual.year}><summary><span><strong>{annual.year}</strong><small>{annual.periodCount} período{annual.periodCount === 1 ? '' : 's'} · {annual.documentCount} documento{annual.documentCount === 1 ? '' : 's'}</small></span><strong><MoneyValue value={annual.totals.netAmount} currency={scope.currencyCode} kind="salary" /></strong></summary><div className="annual-body">
      <dl className="annual-kpis"><div><dt>Neto total</dt><dd><MoneyValue value={annual.totals.netAmount} currency={scope.currencyCode} kind="salary" /></dd></div><div><dt>Neto promedio</dt><dd><MoneyValue value={annual.averages.netAmount} currency={scope.currencyCode} kind="salary" /></dd></div><div><dt>Bruto total</dt><dd><MoneyValue value={annual.totals.grossAmount} currency={scope.currencyCode} kind="salary" /></dd></div><div><dt>Cambio comparable</dt><dd><PercentageValue value={annual.comparableChange?.percentage} /></dd></div></dl>
      {yearCoverage && <p className="coverage-note">Cobertura {yearCoverage.availablePeriods.length}/{yearCoverage.expectedPeriods.length}{yearCoverage.possibleMissingPeriods.length ? ` · posibles faltantes: ${yearCoverage.possibleMissingPeriods.map(periodLabel).join(', ')}` : ' · sin faltantes posibles'}</p>}
      <div className="table-wrap" role="region" aria-label={`Tabla desplazable del resumen ${annual.year}`} tabIndex={0}><table><thead><tr><th>Categoría</th><th>Liquidaciones</th><th>Bruto</th><th>Neto</th><th>Conceptos normalizados</th></tr></thead><tbody>{categories.map((item) => {
        const summary = annual.byCategory[item];
        return <tr key={item}><td data-label="Categoría">{categoryLabels[item]}</td><td data-label="Liquidaciones">{summary.settlementCount}</td><td data-label="Bruto"><MoneyValue value={summary.totals.grossAmount} currency={scope.currencyCode} kind="salary" /></td><td data-label="Neto"><MoneyValue value={summary.totals.netAmount} currency={scope.currencyCode} kind="salary" /></td><td data-label="Conceptos normalizados"><MoneyValue value={annual.normalizedEarningsByCategory?.[item]} currency={scope.currencyCode} kind="salary" /></td></tr>;
      })}</tbody></table></div>
    </div></details>;
  })}</div>;
}

function Summary({ user, onNavigate }: { user: User; onNavigate: NavigateApp }) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const [history, setHistory] = useState<SalaryHistory | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentTotal, setDocumentTotal] = useState(0);
  const [pendingReview, setPendingReview] = useState(0);
  const [selectedScopeKey, setSelectedScopeKey] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [documentError, setDocumentError] = useState('');

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true); setHistoryError('');
    try {
      const salaryHistory = await api<SalaryHistory>('/salary-history');
      setHistory(salaryHistory);
      setSelectedScopeKey((current) => retainedSalaryScopeKey(current, salaryHistory));
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : 'No pudimos cargar el análisis salarial.');
    } finally { setHistoryLoading(false); }
  }, []);
  const loadDocuments = useCallback(async () => {
    setDocumentsLoading(true); setDocumentError('');
    try {
      const page = await api<DocumentPage>('/documents?limit=5');
      setDocuments(page.items); setDocumentTotal(page.total); setPendingReview(page.pendingReview);
    } catch (caught) {
      setDocumentError(caught instanceof Error ? caught.message : 'No pudimos cargar los documentos recientes.');
    } finally { setDocumentsLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(loadHistory); }, [loadHistory]);
  useEffect(() => { void Promise.resolve().then(loadDocuments); }, [loadDocuments]);

  const context = history?.contexts.find((item) => salaryScopeKey(item) === selectedScopeKey) ?? history?.contexts[0];
  const scope = history && salaryScopeForContext(history, context);

  return (
    <div className="page" aria-busy={historyLoading || documentsLoading}>
      <PageHeader eyebrow="Resumen personal" title={`Hola, ${user.displayName?.split(' ')[0] || 'bienvenido'}`} action={<button className="button primary" onClick={() => onNavigate('import')}>Importar recibos</button>} />
      {historyError && <p className="message error" role="alert">{historyError} <button type="button" className="text-button" disabled={historyLoading} onClick={() => void loadHistory()}>{historyLoading ? 'Reintentando…' : 'Reintentar análisis'}</button></p>}
      {historyLoading && !history && <div className="empty-state salary-loading" role="status"><div className="loader" aria-hidden="true" /><p>Cargando tu historial salarial…</p></div>}
      {history && context && scope ? <>
        <SalaryScopeControl history={history} selectedKey={selectedScopeKey} onChange={setSelectedScopeKey} id="summary-salary-scope" />
        <SalaryContextNotice context={context} />
        <SalaryMetricGrid scope={scope} context={context} />
      </> : history && !historyLoading && <EmptyState title="Todavía no hay datos salariales" body="Importá un recibo soportado y completá su revisión para construir el historial." action={<button className="button primary" onClick={() => onNavigate('import')}>Importar recibos</button>} />}
      <div className="dashboard-grid summary-documents-grid">
        {history && context && scope && <section className="panel chart-panel"><div className="panel-heading"><div><p className="eyebrow">Evolución</p><h2>Comparable y neto reciente</h2></div><button className="text-button" onClick={() => onNavigate('history', { tab: 'summary', currencyCode: context.currencyCode, employmentContext: context.employmentContext, employmentId: context.employmentId })}>Analizar historial</button></div><SalaryEvolution scope={scope} limit={12} onSelectPeriod={(period) => onNavigate('history', { tab: 'evolution', currencyCode: context.currencyCode, employmentContext: context.employmentContext, employmentId: context.employmentId, period })} /></section>}
        <section className="panel recent-panel" aria-busy={documentsLoading}>
          <div className="panel-heading"><h2>Documentos recientes</h2><button className="text-button" onClick={() => onNavigate('history', { tab: 'documents', currencyCode: context?.currencyCode, employmentContext: context?.employmentContext, employmentId: context?.employmentId })}>Ver todos</button></div>
          {!documentsLoading && !documentError && <p className="coverage-note">{documentTotal} documento{documentTotal === 1 ? '' : 's'} · {pendingReview} para revisar</p>}
          {documentError && <p className="message error" role="alert">{documentError} <button type="button" className="text-button" disabled={documentsLoading} onClick={() => void loadDocuments()}>{documentsLoading ? 'Reintentando…' : 'Reintentar'}</button></p>}
          {documentsLoading && !documents.length ? <div className="compact-loading" role="status"><div className="loader" aria-hidden="true" /><span>Cargando documentos…</span></div> : documents.length ? <>
            <ul className="recent-list">{documents.map((document) => {
              const name = documentName(document, privacyEnabled);
              return <li key={document.id}><span className="file-icon">PDF</span><span className="document-copy"><strong title={name}>{name}</strong>{!privacyEnabled && name !== document.originalFilename && <small className="document-original" title={document.originalFilename}>Archivo original: {document.originalFilename}</small>}<small>{document.payrollPeriod ? `${document.employerName || 'Sin empresa asociada'} · Período: ${periodLabel(document.payrollPeriod)}` : document.documentType === 'UNSUPPORTED' || document.processingStatus === 'REJECTED_UNSUPPORTED' ? 'Documento no soportado' : 'Tipo pendiente de clasificación'}</small><small>Subido {timestampLabel(document.createdAt)}</small></span><DocumentStatusBadges document={document} /></li>;
            })}</ul>
            <p className="recent-count">Mostrando últimos {documents.length} de {documentTotal}</p>
          </> : !documentError && <EmptyState title="Sin documentos" body="Todavía no importaste ningún documento." action={<button className="button secondary" onClick={() => onNavigate('import')}>Importar</button>} />}
        </section>
      </div>
    </div>
  );
}

function Status({ value }: { value: string }) {
  const risky = /FAILED|QUARANTINED|REJECTED|CANCELLED/.test(value);
  const pending = /CREATED|UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION|NEEDS_REVIEW|NEEDS_TYPE_CONFIRMATION/.test(value);
  return <span className={`status ${value === 'DUPLICATE' ? 'duplicate' : risky ? 'danger' : pending ? 'pending' : 'ready'}`}>{documentStatusLabel(value)}</span>;
}

function DocumentStatusBadges({ document }: { document: DocumentItem }) {
  return <span className="document-badges"><Status value={document.processingStatus} />{document.decisionRequired && <span className="status pending">Para revisar</span>}{document.errorCode === 'DOCUMENT_DUPLICATE' && document.processingStatus !== 'DUPLICATE' && <span className="status duplicate">Duplicado</span>}</span>;
}

function Employments({ selectedLocation, onNavigate, runSensitive }: { selectedLocation: OwnerLocation; onNavigate: NavigateApp; runSensitive: RunSensitive }) {
  const [items, setItems] = useState<Employment[]>([]);
  const [detections, setDetections] = useState<EmploymentDetection[]>([]);
  const [salaryHistory, setSalaryHistory] = useState<SalaryHistory | null>(null);
  const [editing, setEditing] = useState<Employment | null | 'new'>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<EmploymentDetection | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const load = useCallback(async () => {
    setError(''); setLoading(true);
    try {
      const [employmentsResult, detectedResult, historyResult] = await Promise.allSettled([
        api<Employment[]>('/employments'),
        api<EmploymentDetection[]>('/employment-detections'),
        api<SalaryHistory>('/salary-history'),
      ]);
      if (employmentsResult.status === 'fulfilled') setItems(employmentsResult.value);
      if (detectedResult.status === 'fulfilled') setDetections(detectedResult.value);
      if (historyResult.status === 'fulfilled') setSalaryHistory(historyResult.value);
      else setSalaryHistory(null);
      const failure = employmentsResult.status === 'rejected' ? employmentsResult.reason
        : detectedResult.status === 'rejected' ? detectedResult.reason
          : historyResult.status === 'rejected' ? historyResult.reason : null;
      if (failure) setError(failure instanceof Error ? failure.message : 'No pudimos cargar todos los datos de tus empleos.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!editing || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    const currentEmployment = editing;
    const form = new FormData(event.currentTarget);
    const employerName = String(form.get('employerName') ?? '');
    try {
      const payload = {
        employerName, role: form.get('role') || null,
        startDate: form.get('startDate'), endDate: form.get('endDate') || null,
        countryCode: 'AR', currencyCode: form.get('currencyCode') || 'ARS',
      };
      const path = currentEmployment === 'new' ? '/employments' : `/employments/${currentEmployment.id}`;
      await api(path, { method: currentEmployment === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(payload) });
      setEditing(null); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos guardar el empleo.'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function remove(item: Employment) {
    if (!confirm(`¿Eliminar el empleo en ${item.employerName}? Las liquidaciones no se borrarán.`)) return;
    try {
      await runSensitive(async () => {
        await api(`/employments/${item.id}`, { method: 'DELETE', body: '{}' });
        await load();
      });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos eliminarlo.'); }
  }

  async function toggleFavorite(item: Employment) {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await api(`/employers/${item.employerId}/favorite`, {
        method: 'PUT', body: JSON.stringify({ isFavorite: !item.isFavorite }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos actualizar la empresa favorita.');
    } finally { savingRef.current = false; setSaving(false); }
  }

  async function confirmDetection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmation) return;
    const detection = confirmation;
    const form = new FormData(event.currentTarget);
    const employmentId = String(form.get('employmentId') ?? '');
    setError(''); setConfirmationError(''); setConfirming(true);
    try {
      await api('/employment-detections/confirm', {
        method: 'POST',
        body: JSON.stringify({
          employerId: detection.employerId,
          employerName: detection.employerName,
          currencyCode: detection.currencyCode,
          ...(employmentId && employmentId !== 'new'
            ? { employmentId }
            : { startDate: form.get('startDate'), endDate: form.get('endDate') || null }),
        }),
      });
      setConfirmation(null);
      await load();
    } catch (caught) {
      setConfirmationError(caught instanceof Error ? caught.message : 'No pudimos confirmar el empleo detectado.');
    } finally { setConfirming(false); }
  }

  function closeConfirmation() {
    if (confirming) return;
    setConfirmation(null); setConfirmationError('');
  }

  const matchingEmployments = confirmation
    ? items.filter((item) => item.currencyCode === confirmation.currencyCode
      && (confirmation.employerId
        ? item.employerId === confirmation.employerId
        : normalizedEmployerName(item.employerName) === normalizedEmployerName(confirmation.employerName)))
    : [];

  const selectedEmploymentId = selectedLocation.employmentId;
  const selectedEmployment = selectedEmploymentId ? items.find((item) => item.id === selectedEmploymentId) : undefined;
  const selectedContext = selectedEmployment && salaryHistory
    ? salaryContextForEmployment(salaryHistory.contexts, selectedEmployment.id, {
      employmentContext: selectedLocation.employmentContext,
      currencyCode: selectedLocation.currencyCode,
    })
    : undefined;
  const selectedScope = salaryHistory && salaryScopeForContext(salaryHistory, selectedContext);
  if (selectedEmploymentId) {
    const selectedSalaryLocation = {
      currencyCode: selectedContext?.currencyCode ?? selectedLocation.currencyCode ?? selectedEmployment?.currencyCode,
      employmentContext: selectedContext?.employmentContext,
      employmentId: selectedEmploymentId,
    };
    const historyHref = (tab: HistoryTab, period?: string) => `/${writeOwnerLocation('', { section: 'history', tab, ...selectedSalaryLocation, period: period ?? null })}`;
    return <div className="page" aria-busy={loading || saving}>
      <nav className="breadcrumbs" aria-label="Migas de pan"><span><Link href="/?section=jobs" onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate('jobs', { employmentId: null }); } }}>Empleos</Link></span><span>{selectedEmployment?.employerName ?? 'Detalle'}</span></nav>
      {loading && !selectedEmployment && <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando empleo…</p></div>}
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Reintentando…' : 'Reintentar'}</button></p>}
      {!loading && !selectedEmployment && !error && <EmptyState title="No encontramos ese empleo" body="Puede haber sido eliminado o no pertenecer a tu cuenta." action={<button className="button secondary" onClick={() => onNavigate('jobs', { employmentId: null })}>Volver a empleos</button>} />}
      {selectedEmployment && <>
        <PageHeader eyebrow="Trayectoria" title={selectedEmployment.employerName} action={<button type="button" className="button secondary" disabled={saving} onClick={() => void toggleFavorite(selectedEmployment)}>{saving ? 'Guardando…' : selectedEmployment.isFavorite ? 'Quitar de favoritas' : 'Marcar favorita'}</button>} />
        <section className="panel employment-detail"><div className="employment-detail-heading"><div className="employer-avatar">{selectedEmployment.employerName.slice(0, 2).toUpperCase()}</div><div><h2>{selectedEmployment.role || 'Puesto sin especificar'}</h2><p>{selectedEmployment.employerStatus === 'VERIFIED' ? 'Empresa verificada' : selectedEmployment.employerStatus === 'PENDING' ? 'Empresa por verificar' : 'Empresa registrada'}</p></div></div><dl><div><dt>Desde</dt><dd>{dateLabel(selectedEmployment.startDate)}</dd></div><div><dt>Hasta</dt><dd>{selectedEmployment.endDate ? dateLabel(selectedEmployment.endDate) : 'Actualidad'}</dd></div><div><dt>Moneda</dt><dd>{selectedEmployment.currencyCode}</dd></div><div><dt>Estado</dt><dd>{selectedEmployment.status === 'ACTIVE' ? 'Empleo actual' : 'Empleo anterior'}</dd></div></dl></section>
        {selectedScope && selectedContext ? <><SalaryMetricGrid scope={selectedScope} context={selectedContext} /><section className="panel employment-coverage"><div className="panel-heading"><div><p className="eyebrow">Fuentes vinculadas</p><h2>Cobertura del historial</h2></div></div><dl className="employment-summary"><div><dt>Liquidaciones</dt><dd>{selectedScope.annual.reduce((total, annual) => total + annual.settlementCount, 0)}</dd></div><div><dt>Documentos</dt><dd>{selectedScope.annual.reduce((total, annual) => total + annual.documentCount, 0)}</dd></div><div><dt>Períodos</dt><dd>{selectedScope.evolution.length}</dd></div><div><dt>Posibles faltantes</dt><dd>{selectedScope.coverage.possibleMissingPeriods.length}</dd></div></dl>{selectedScope.coverage.possibleMissingPeriods.length > 0 && <p className="coverage-note">Revisá: {selectedScope.coverage.possibleMissingPeriods.map(periodLabel).join(', ')}.</p>}</section></> : salaryHistory && !error ? <EmptyState title="Sin historial salarial asociado" body="Los datos aparecerán cuando asocies y revises recibos de este empleo." /> : null}
        <section className="employment-detail-actions" aria-label="Explorar datos del empleo">{([['summary', 'Revisar y comparar períodos'], ['evolution', 'Explorar evolución'], ['documents', 'Ver documentos fuente']] as Array<[HistoryTab, string]>).map(([tab, label]) => <a className="panel detail-action" href={historyHref(tab)} key={tab} onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate('history', { tab, ...selectedSalaryLocation }); } }}><strong>{label}</strong><span aria-hidden="true">→</span></a>)}</section>
      </>}
    </div>;
  }

  return (
    <div className="page" aria-busy={loading || confirming || saving}>
      <PageHeader eyebrow="Trayectoria" title="Empleos" action={<button className="button primary" disabled={saving} onClick={() => setEditing('new')}>Agregar empleo</button>} />
      <p className="page-intro">Usalos para agrupar recibos y entender cada etapa de tu carrera.</p>
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Recargando…' : 'Recargar'}</button></p>}
      <div className="stack-form">
        {loading && !items.length && !detections.length && <div className="empty-state" role="status" aria-live="polite"><div className="loader" aria-hidden="true" /><p>Cargando empleos…</p></div>}
        {detections.length > 0 && <section className="panel" aria-labelledby="detected-employments-title">
          <div className="panel-heading"><div><p className="eyebrow">Pendientes de confirmación</p><h2 id="detected-employments-title">Empleos detectados</h2></div></div>
          <div className="employment-grid">{detections.map((detection) => {
            const key = JSON.stringify([detection.employerId ?? detection.employerName, detection.currencyCode]);
            const hasMatch = items.some((item) => item.currencyCode === detection.currencyCode && (detection.employerId
              ? item.employerId === detection.employerId
              : normalizedEmployerName(item.employerName) === normalizedEmployerName(detection.employerName)));
            return <article className="employment-card" key={key}><div className="employer-avatar">{detection.employerName.slice(0, 2).toUpperCase()}</div><div className="employment-main"><div><h2>{detection.employerName}</h2><p>{detection.documentCount} recibo{detection.documentCount === 1 ? '' : 's'} sin asociar</p></div><span className="status pending">{hasMatch ? 'Sin asociar' : 'Detectado'}</span><dl><div><dt>Primer recibo</dt><dd>{periodLabel(detection.firstPeriod)}</dd></div><div><dt>Último recibo</dt><dd>{periodLabel(detection.lastPeriod)}</dd></div><div><dt>Moneda</dt><dd>{detection.currencyCode}</dd></div></dl><div className="card-actions"><button type="button" className="button compact" disabled={confirming} onClick={() => { setConfirmationError(''); setConfirmation(detection); }}>{hasMatch ? 'Asociar recibos' : 'Confirmar empleo'}</button></div></div></article>;
          })}</div>
        </section>}
        <section aria-label="Empleos confirmados">
          {detections.length > 0 && <div className="panel-heading"><div><p className="eyebrow">Trayectoria confirmada</p><h2>Empleos confirmados</h2></div></div>}
          {items.length ? <div className="employment-grid">{items.map((item) => {
            const itemContext = salaryHistory ? salaryContextForEmployment(salaryHistory.contexts, item.id) : undefined;
            const itemScope = salaryHistory && salaryScopeForContext(salaryHistory, itemContext);
            const settlementCount = itemScope?.annual.reduce((total, annual) => total + annual.settlementCount, 0) ?? 0;
            const documentCount = itemScope?.annual.reduce((total, annual) => total + annual.documentCount, 0) ?? 0;
            const itemLocation = { currencyCode: itemContext?.currencyCode ?? item.currencyCode, employmentContext: itemContext?.employmentContext, employmentId: item.id };
            return <article className="employment-card interactive" key={item.id}><a className="employment-card-link" href={`/${writeOwnerLocation('', { section: 'jobs', ...itemLocation })}`} aria-label={`Abrir detalle de ${item.employerName}, ${item.role || 'puesto sin especificar'}`} onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate('jobs', itemLocation); } }} /><div className="employer-avatar">{item.employerName.slice(0, 2).toUpperCase()}</div><div className="employment-main"><div><h2>{item.employerName}</h2><p>{item.role || 'Puesto sin especificar'}</p>{item.isFavorite && <span className="status ready">Favorita</span>}{item.employerStatus === 'PENDING' && <span className="status pending">Empresa por verificar</span>}</div><span className={`status ${item.status === 'ACTIVE' ? 'ready' : ''}`}>{item.status === 'ACTIVE' ? 'Activo' : 'Finalizado'}</span><dl><div><dt>Desde</dt><dd>{dateLabel(item.startDate)}</dd></div><div><dt>Hasta</dt><dd>{item.endDate ? dateLabel(item.endDate) : 'Actualidad'}</dd></div><div><dt>Moneda</dt><dd>{item.currencyCode}</dd></div></dl>{itemScope?.current && <div className="employment-card-summary"><span>Último neto · {periodLabel(itemScope.current.period)}</span><strong><MoneyValue value={itemScope.current.amounts.netAmount} currency={itemContext?.currencyCode ?? item.currencyCode} kind="salary" /></strong><small>{settlementCount} {settlementCount === 1 ? 'liquidación' : 'liquidaciones'} · {documentCount} documento{documentCount === 1 ? '' : 's'}{itemScope.coverage.possibleMissingPeriods.length ? ` · ${itemScope.coverage.possibleMissingPeriods.length} posible${itemScope.coverage.possibleMissingPeriods.length === 1 ? '' : 's'} faltante${itemScope.coverage.possibleMissingPeriods.length === 1 ? '' : 's'}` : ''}</small></div>}</div><details className="employment-menu"><summary aria-label={`Acciones para ${item.employerName}`}>•••</summary><div><button type="button" className="text-button" disabled={saving} onClick={() => void toggleFavorite(item)}>{item.isFavorite ? 'Quitar de favoritas' : 'Marcar favorita'}</button><button className="text-button" disabled={saving} onClick={() => setEditing(item)}>Editar</button><button className="text-button danger-text" disabled={saving} onClick={() => void remove(item)}>Eliminar</button></div></details><span className="employment-arrow" aria-hidden="true">→</span></article>;
          })}</div> : !loading && !error && <EmptyState title={detections.length ? 'Todavía no confirmaste empleos' : 'Sumá tu primer empleo'} body={detections.length ? 'Confirmá una detección o agregá un empleo manualmente.' : 'Podés empezar por tu trabajo actual y completar el resto después.'} action={<button className="button primary" disabled={saving} onClick={() => setEditing('new')}>Agregar empleo</button>} />}
        </section>
      </div>
      {editing && <div className="modal-layer" role="presentation" onMouseDown={() => { if (!saving) setEditing(null); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="employment-title" aria-busy={saving} tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, () => { if (!saving) setEditing(null); })} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2 id="employment-title">{editing === 'new' ? 'Nuevo empleo' : 'Editar empleo'}</h2><button className="icon-button" disabled={saving} onClick={() => setEditing(null)} aria-label="Cerrar">×</button></div><form className="stack-form" onSubmit={save}><label>Empresa<input name="employerName" defaultValue={editing === 'new' ? '' : editing.employerName} minLength={2} maxLength={160} required /></label><label>Puesto<input name="role" defaultValue={editing === 'new' ? '' : editing.role ?? ''} maxLength={120} /></label><div className="field-row"><label>Inicio<input name="startDate" type="date" defaultValue={editing === 'new' ? '' : editing.startDate.slice(0, 10)} required /></label><label>Fin<input name="endDate" type="date" defaultValue={editing === 'new' ? '' : editing.endDate?.slice(0, 10) ?? ''} /></label></div><label>Moneda<select name="currencyCode" defaultValue={editing === 'new' ? 'ARS' : editing.currencyCode}><option value="ARS">ARS — Peso argentino</option><option value="USD">USD — Dólar</option><option value="EUR">EUR — Euro</option></select></label>{error && <p className="message error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => setEditing(null)}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button></div></form></section></div>}
      {confirmation && <div className="modal-layer" role="presentation" onMouseDown={closeConfirmation}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="employment-confirmation-title" aria-describedby="employment-confirmation-description" tabIndex={-1} onKeyDown={(event) => handleDialogKey(event, closeConfirmation)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-head"><div><p className="eyebrow">Empleo detectado</p><h2 id="employment-confirmation-title">Confirmar empleo</h2></div><button type="button" className="icon-button" disabled={confirming} onClick={closeConfirmation} aria-label="Cerrar">×</button></div>
          <form className="stack-form" onSubmit={confirmDetection}>
            <label>Empresa<input value={confirmation.employerName} readOnly /></label>
            <div className="field-row"><label>Moneda<input value={confirmation.currencyCode} readOnly /></label><label>Documentos detectados<input value={confirmation.documentCount} readOnly /></label></div>
            <p id="employment-confirmation-description">Detectamos recibos entre {periodLabel(confirmation.firstPeriod)} y {periodLabel(confirmation.lastPeriod)}. El último recibo no implica que el empleo haya finalizado.</p>
            {matchingEmployments.length > 0 && <label>Asociar a<select name="employmentId" defaultValue={matchingEmployments.length === 1 ? matchingEmployments[0]!.id : ''} required autoFocus><option value="" disabled>Elegí un empleo</option>{matchingEmployments.map((item) => <option key={item.id} value={item.id}>{employmentOptionLabel(item)}</option>)}<option value="new">Crear otro empleo</option></select><small>Al elegir uno existente se conservan sus fechas y datos.</small></label>}
            <div className="field-row"><label>{matchingEmployments.length ? 'Inicio (si creás otro)' : 'Inicio'}<input name="startDate" type="date" defaultValue={`${confirmation.firstPeriod}-01`} required autoFocus={!matchingEmployments.length} /></label><label>Fin (opcional)<input name="endDate" type="date" /></label></div>
            {confirmationError && <p className="message error" role="alert">{confirmationError}</p>}
            <div className="modal-actions"><button type="button" className="button secondary" disabled={confirming} onClick={closeConfirmation}>Cancelar</button><button className="button primary" disabled={confirming}>{confirming ? 'Confirmando…' : matchingEmployments.length ? 'Asociar recibos' : 'Confirmar empleo'}</button></div>
          </form>
        </section>
      </div>}
    </div>
  );
}

function Importer({ onBusyChange, onDone }: { onBusyChange: (busy: boolean) => void; onDone: () => void }) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<ImportProgress[]>([]);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [employmentId, setEmploymentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasActiveBatch = batch !== null && ['ACTIVE', 'PAUSED'].includes(batch.status);

  const applyBatch = useCallback((snapshot: ImportBatch) => {
    setBatch(snapshot);
    setProgress((current) => snapshot.items.map((item) => importProgressItem(
      item,
      current.find((candidate) => candidate.key === item.clientItemKey),
    )));
  }, []);

  useEffect(() => {
    let stopped = false;
    Promise.all([api<Employment[]>('/employments'), api<ImportBatch | null>('/imports/active')])
      .then(([jobs, active]) => {
        if (stopped) return;
        setEmployments(jobs);
        if (active) {
          applyBatch(active);
          const associated = new Set(active.items.map((item) => item.employmentId).filter(Boolean));
          if (associated.size === 1) setEmploymentId(String([...associated][0]));
        }
      })
      .catch((caught: unknown) => {
        if (!stopped) setError(caught instanceof Error ? caught.message : 'No pudimos recuperar tus importaciones.');
      });
    return () => { stopped = true; };
  }, [applyBatch]);

  useEffect(() => {
    if (!batch?.id || !['ACTIVE', 'PAUSED'].includes(batch.status)) return;
    let stopped = false;
    let timer = 0;
    const refresh = async () => {
      try {
        const snapshot = await api<ImportBatch>(`/imports/${batch.id}`);
        if (stopped) return;
        applyBatch(snapshot);
        if (['ACTIVE', 'PAUSED'].includes(snapshot.status)) timer = window.setTimeout(refresh, 2_500);
      } catch {
        if (!stopped) timer = window.setTimeout(refresh, 2_500);
      }
    };
    timer = window.setTimeout(refresh, 500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [applyBatch, batch?.id, batch?.status]);

  function choose(list: FileList | null) {
    if (!list || busy || hasActiveBatch) return;
    const selected = Array.from(list);
    const valid = selected.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    setFiles(valid);
    setBatch(null);
    setProgress(valid.map((file) => ({ key: crypto.randomUUID(), name: file.name, status: 'PENDIENTE', uploadPercentage: 0 })));
    setError(valid.length !== selected.length ? 'Omitimos archivos que no parecen ser PDF.' : '');
  }

  function update(index: number, patch: Partial<ImportProgress>) {
    setProgress((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  }

  async function start() {
    if (!files.length || busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const batch = await api<{ id: string; items: Array<{ id: string; clientItemKey: string }> }>('/imports', {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ items: files.map((file, index) => ({
          clientItemKey: progress[index]?.key,
          originalFilename: file.name,
          declaredMimeType: 'application/pdf',
          expectedSizeBytes: file.size,
          employmentId: employmentId || null,
        })) }),
      });
      setBatch({
        id: batch.id,
        status: 'ACTIVE',
        progress: { total: batch.items.length, resolved: 0, percentage: 0 },
        totals: { PENDING_UPLOAD: batch.items.length },
        items: batch.items.map((item, index) => ({
          ...item,
          originalFilename: files[index]?.name ?? progress[index]?.name ?? 'document.pdf',
          employmentId: employmentId || null,
          status: 'PENDING_UPLOAD',
        })),
      });
      let uploadFailed = false;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]; const item = batch.items[index];
        if (!file || !item) continue;
        update(index, { status: 'SUBIENDO', uploadPercentage: 0, message: undefined });
        try {
          const upload = await api<{ id: string } & AuthorizedUpload>('/upload-sessions', { method: 'POST', body: JSON.stringify({ itemId: item.id }) });
          const uploaded = await uploadFile(upload, file, (uploadPercentage) => update(index, { uploadPercentage: Math.min(uploadPercentage, 99) }));
          if (!uploaded.ok) throw new Error(`El almacenamiento rechazó el archivo (${uploaded.status}).`);
          await api(`/upload-sessions/${upload.id}/complete`, { method: 'POST', body: '{}' });
          update(index, { status: 'EN_COLA', uploadPercentage: 100, message: 'Validación de seguridad en curso' });
        } catch (caught) {
          uploadFailed = true;
          update(index, { status: 'ERROR', message: caught instanceof Error ? caught.message : 'No se pudo subir.' });
        }
      }
      if (uploadFailed) applyBatch(await api<ImportBatch>(`/imports/${batch.id}/cancel`, { method: 'POST', body: '{}' }));
      setFiles([]);
      onDone();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la importación.'); }
    finally { setBusy(false); onBusyChange(false); }
  }

  async function cancelPending() {
    if (!batch || busy) return;
    setError('');
    try {
      applyBatch(await api<ImportBatch>(`/imports/${batch.id}/cancel`, { method: 'POST', body: '{}' }));
      setFiles([]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cancelar las cargas pendientes.'); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Carga privada" title="Importar recibos" />
      <p className="page-intro">Seleccioná uno o muchos PDFs. Cada archivo avanza por separado y podés cerrar esta pantalla cuando termine la carga.</p>
      <label className="import-employment">Asociar todo el lote a<select value={employmentId} disabled={hasActiveBatch || busy} onChange={(event) => setEmploymentId(event.target.value)}><option value="">Sin asociar · detectar empresa</option>{employments.map((employment) => <option key={employment.id} value={employment.id}>{employmentOptionLabel(employment)}</option>)}</select><small>Si mezclás empresas, dejalo sin asociar y usá los checkboxes del historial después.</small></label>
      <label className={`drop-zone${hasActiveBatch || busy ? ' disabled' : ''}`} aria-disabled={hasActiveBatch || busy} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files); }}><input type="file" accept="application/pdf,.pdf" multiple disabled={hasActiveBatch || busy} onChange={(event) => choose(event.target.files)} /><span className="upload-mark">↑</span><strong>{hasActiveBatch ? 'Hay un lote en curso' : 'Arrastrá tus recibos acá'}</strong><span>{hasActiveBatch ? 'Cuando termine vas a poder iniciar otro' : 'o hacé clic para elegir PDFs'}</span><small>El servidor limita archivos, tamaño total, espacio por cuenta y trabajo simultáneo.</small></label>
      {error && <p className="message error" role="alert">{error}</p>}
      {(batch || progress.length > 0) && <section className="panel upload-list" aria-live="polite"><div className="panel-heading"><div><p className="eyebrow">Lote</p><h2>{batch?.progress.total ?? progress.length} archivo{(batch?.progress.total ?? progress.length) === 1 ? '' : 's'}</h2></div>{batch && <span className="batch-id">Lote {batch.id.slice(0, 8)}</span>}</div>{batch && <div className="upload-summary"><progress max={Math.max(1, batch.progress.total)} value={batch.progress.resolved} aria-label="Progreso del lote" /><strong>{batch.progress.resolved} de {batch.progress.total} resueltos · {batch.progress.percentage}%</strong><small>{batch.totals.PROCESSING ?? 0} procesando · {(batch.totals.UPLOADED ?? 0) + (batch.totals.PENDING_UPLOAD ?? 0)} pendientes · {batch.totals.NEEDS_REVIEW ?? 0} para revisar · {(batch.totals.REJECTED ?? 0) + (batch.totals.FAILED ?? 0)} no procesados{batch.totals.DUPLICATE ? ` · ${batch.totals.DUPLICATE} duplicado${batch.totals.DUPLICATE === 1 ? '' : 's'} descartado${batch.totals.DUPLICATE === 1 ? '' : 's'}` : ''}</small></div>}<ul>{progress.map((item, index) => { const name = privacyEnabled ? `Archivo PDF ${index + 1}` : item.name; return <li key={item.key}><span className="file-icon">PDF</span><span className="upload-name"><strong>{name}</strong><small>{item.message ?? (item.status === 'PENDIENTE' ? 'Listo para subir' : 'Enviando…')} · {item.uploadPercentage}% cargado</small><progress max="100" value={item.uploadPercentage} aria-label={`Carga de ${name}`} /></span><span className={`upload-state ${item.status.toLowerCase()}`}>{item.status.replace('_', ' ')}</span></li>; })}</ul><div className="upload-footer"><p>{hasActiveBatch && !busy && progress.some((item) => item.status === 'PENDIENTE') ? 'La carga se interrumpió. Cancelá los pendientes y volvé a seleccionarlos.' : 'Los errores de un archivo no detienen el resto del lote.'}</p>{hasActiveBatch ? (batch.totals.PENDING_UPLOAD ?? 0) > 0 && <button className="button secondary" disabled={busy} onClick={cancelPending}>Cancelar pendientes</button> : <button className="button primary" disabled={busy || !files.length} onClick={start}>{busy ? 'Subiendo…' : 'Iniciar importación'}</button>}</div></section>}
      <aside className="privacy-note"><span aria-hidden="true">◇</span><div><strong>Privado por diseño</strong><p>Los PDFs se guardan con claves opacas. Antes de extraer datos pasan por validación de formato y malware.</p></div></aside>
    </div>
  );
}

function History({ initialLocation, onLocationChange, runSensitive }: { initialLocation: OwnerLocation; onLocationChange: (patch: OwnerLocationPatch, replace?: boolean, preserveDocument?: boolean) => void; runSensitive: RunSensitive }) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const initialCurrencyCode = useRef(initialLocation.currencyCode);
  const initialEmploymentId = useRef(initialLocation.employmentId);
  const initialEmploymentContext = useRef(initialLocation.employmentContext);
  const historyInitialized = useRef(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [history, setHistory] = useState<SalaryHistory | null>(null);
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<string[]>([]);
  const [employmentChoice, setEmploymentChoice] = useState('');
  const [associating, setAssociating] = useState(false);
  const [selected, setSelected] = useState<DocumentItem | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [processingRuns, setProcessingRuns] = useState<ProcessingRun[]>([]);
  const [runPreviews, setRunPreviews] = useState<Record<string, ProcessingComparisonPreview | null | undefined>>({});
  const [runPreviewErrors, setRunPreviewErrors] = useState<Record<string, string>>({});
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [reprocessingCandidates, setReprocessingCandidates] = useState<ReprocessingCandidate[]>([]);
  const [reprocessingCandidateTotal, setReprocessingCandidateTotal] = useState(0);
  const [reprocessingBatchLimit, setReprocessingBatchLimit] = useState(100);
  const [reprocessingBatch, setReprocessingBatch] = useState<ReprocessingBatch | null>(null);
  const [dismissedReprocessingBatchId, setDismissedReprocessingBatchId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(dismissedReprocessingBatchKey); }
    catch { return null; }
  });
  const [reprocessingLoading, setReprocessingLoading] = useState(true);
  const [reprocessingBusy, setReprocessingBusy] = useState(false);
  const [reprocessingError, setReprocessingError] = useState('');
  const [tab, setTab] = useState<HistoryTab>(initialLocation.tab ?? 'summary');
  const [selectedScopeKey, setSelectedScopeKey] = useState('');
  const selectedScopeKeyRef = useRef('');
  const [yearFilter, setYearFilter] = useState(initialLocation.year ?? 'all');
  const [evolutionRange, setEvolutionRange] = useState<(typeof evolutionRanges)[number][0]>(initialLocation.range ?? '12');
  const [perspective, setPerspective] = useState<EconomicPerspective>(initialLocation.tab === 'purchasing-power' ? 'purchasing-power' : initialLocation.perspective ?? 'nominal');
  const [selectedPeriod, setSelectedPeriod] = useState(initialLocation.period ?? '');
  const [categoryFilter, setCategoryFilter] = useState<'all' | SalaryCategory>('all');
  const [fromPeriod, setFromPeriod] = useState('');
  const [toPeriod, setToPeriod] = useState('');
  const [comparison, setComparison] = useState<PeriodComparison | null>(null);
  const [comparisonLoaded, setComparisonLoaded] = useState(false);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [concepts, setConcepts] = useState<SalaryConcept[]>([]);
  const [conceptCursor, setConceptCursor] = useState<string | null>(null);
  const [conceptLoading, setConceptLoading] = useState(false);
  const [conceptLoadingMore, setConceptLoadingMore] = useState(false);
  const [conceptError, setConceptError] = useState('');
  const [conceptReloadKey, setConceptReloadKey] = useState(0);
  const conceptRequestGeneration = useRef(0);
  const [documentKind, setDocumentKind] = useState<'ALL' | 'PAYROLL' | 'UNSUPPORTED'>(initialLocation.documentType ?? 'ALL');
  const [documentSearchDraft, setDocumentSearchDraft] = useState('');
  const [documentSearch, setDocumentSearch] = useState('');
  const [documentYearDraft, setDocumentYearDraft] = useState(initialLocation.year && initialLocation.year !== 'all' ? initialLocation.year : '');
  const [documentYear, setDocumentYear] = useState(initialLocation.year ?? 'all');
  const [documentPeriod, setDocumentPeriod] = useState(initialLocation.period ?? '');
  const [documentSettlementType, setDocumentSettlementType] = useState(() => initialLocation.settlementType && settlementTypeOptions.includes(initialLocation.settlementType as (typeof settlementTypeOptions)[number]) ? initialLocation.settlementType : 'all');
  const [documentEmploymentId, setDocumentEmploymentId] = useState(initialLocation.employmentId ?? 'all');
  const [documentStatusGroup, setDocumentStatusGroup] = useState<(typeof documentStatusGroups)[number][0]>(initialLocation.status ?? 'ALL');
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [loadingMoreDocuments, setLoadingMoreDocuments] = useState(false);
  const [documentCursor, setDocumentCursor] = useState<string | null>(null);
  const [documentTotal, setDocumentTotal] = useState(0);
  const [documentPendingReview, setDocumentPendingReview] = useState(0);
  const [documentError, setDocumentError] = useState('');
  const [documentNavigationError, setDocumentNavigationError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [preview, setPreview] = useState<{ documentId: string; expiresAt?: string; url: string } | null>(null);
  const [privacyPreviewDocumentId, setPrivacyPreviewDocumentId] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequested = useRef(false);
  const previewGeneration = useRef(0);
  const documentRequestGeneration = useRef(0);
  const comparisonRequestGeneration = useRef(0);
  const loadedDocumentCount = useRef(0);
  const [openedFromList, setOpenedFromList] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [locationSeed, setLocationSeed] = useState<{ evidenceId?: string; page?: number }>({});
  const allowNextPop = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const reviewUrl = useRef('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selectedId = selected?.id;
  const selectedStatus = selected?.processingStatus;
  const activeDocumentId = useRef<string | undefined>(selectedId);
  const context = history?.contexts.find((item) => salaryScopeKey(item) === selectedScopeKey) ?? history?.contexts[0];
  const scope = history && salaryScopeForContext(history, context);

  const invalidatePreview = useCallback(() => {
    previewGeneration.current += 1;
    previewRequested.current = false;
    setPreview(null);
    setPreviewBusy(false);
    setPreviewError('');
  }, []);
  const invalidateScopeData = useCallback(() => {
    conceptRequestGeneration.current += 1;
    comparisonRequestGeneration.current += 1;
    documentRequestGeneration.current += 1;
    setConcepts([]); setConceptCursor(null); setConceptError(''); setConceptLoading(false); setConceptLoadingMore(false);
    setComparison(null); setComparisonLoaded(false); setComparisonLoading(false); setFromPeriod(''); setToPeriod('');
    setDocuments([]); setDocumentCursor(null); setDocumentTotal(0); setDocumentPendingReview(0); setDocumentError(''); setDocumentNavigationError('');
    setDocumentsLoading(true); setLoadingMoreDocuments(false); setCheckedDocumentIds([]);
    invalidatePreview(); setPrivacyPreviewDocumentId(null); activeDocumentId.current = undefined; setSelected(null); setDetail(null);
  }, [invalidatePreview]);
  const canonicalizeSalaryContext = useCallback((next?: SalaryContext) => {
    initialCurrencyCode.current = next?.currencyCode;
    initialEmploymentContext.current = next?.employmentContext;
    initialEmploymentId.current = next?.employmentId ?? undefined;
    onLocationChange({
      currencyCode: next?.currencyCode ?? null,
      employmentContext: next?.employmentContext ?? null,
      employmentId: next?.employmentId ?? null,
    }, true, true);
    if (readDocumentLocation(window.location.search)) reviewUrl.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }, [onLocationChange]);
  useEffect(() => subscribePrivacyMode(() => {
    if (!privacySnapshot()) return;
    setPrivacyPreviewDocumentId(null);
    invalidatePreview();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }), [invalidatePreview]);
  useEffect(() => { activeDocumentId.current = selectedId; }, [selectedId]);
  useEffect(() => { loadedDocumentCount.current = documents.length; }, [documents.length]);
  useEffect(() => {
    if (selected) return;
    opener.current?.focus();
    opener.current = null;
  }, [selected]);

  const authorizePreview = useCallback(() => {
    if (!selectedId) return;
    if (privacyEnabled && privacyPreviewDocumentId !== selectedId) {
      if (!window.confirm('El modo privacidad está activo. El PDF original contiene datos salariales que no pueden ocultarse dentro del documento. ¿Mostrarlo igualmente?')) return;
      setPrivacyPreviewDocumentId(selectedId);
    }
    const documentId = selectedId;
    if (activeDocumentId.current !== documentId) return;
    const generation = ++previewGeneration.current;
    previewRequested.current = true;
    setPreviewBusy(true); setPreviewError(''); setError('');
    void runSensitive(async () => {
      try {
        const signed = await api<{ expiresAt?: string; url: string }>(`/documents/${documentId}/original?disposition=inline`);
        if (activeDocumentId.current === documentId && previewGeneration.current === generation) setPreview({ ...signed, documentId });
      } finally {
        if (activeDocumentId.current === documentId && previewGeneration.current === generation) setPreviewBusy(false);
      }
    }).catch((caught: unknown) => {
      if (activeDocumentId.current !== documentId || previewGeneration.current !== generation) return;
      setPreviewBusy(false);
      setPreviewError(caught instanceof Error ? caught.message : 'No pudimos autorizar la vista privada.');
    });
  }, [privacyEnabled, privacyPreviewDocumentId, runSensitive, selectedId]);

  const applyDocuments = useCallback((docs: DocumentItem[]) => {
    setDocuments(docs);
    setCheckedDocumentIds((current) => current.filter((id) => docs.some((document) => document.id === id && associationReadyStatuses.has(document.processingStatus))));
    const location = readDocumentLocation(window.location.search);
    const linked = location ? resolveDocumentItem(docs, location.documentId) : undefined;
    if (linked && location) {
      reviewUrl.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      setTab('documents');
      setLocationSeed({ evidenceId: location.evidenceId, page: location.page });
      activeDocumentId.current = linked.id;
      setSelected(linked);
    } else {
      setSelected((current) => current ? docs.find((document) => document.id === current.id) ?? current : null);
    }
  }, []);
  const fetchDocumentPage = useCallback((cursor?: string, limit = 100) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (documentKind !== 'ALL') query.set('documentType', documentKind);
    if (documentSearch) query.set('search', documentSearch);
    if (documentYear !== 'all') query.set('year', documentYear);
    if (documentPeriod) query.set('period', documentPeriod);
    if (documentSettlementType !== 'all' && documentKind !== 'UNSUPPORTED') query.set('settlementType', documentSettlementType);
    if (context) {
      if (!appendSalaryContext(query, context)) throw new Error('No pudimos resolver el contexto laboral detectado.');
    } else if (initialEmploymentContext.current) {
      if (!initialCurrencyCode.current || /^detected:[0-9a-f]{24}$/i.test(initialEmploymentContext.current)) {
        throw new Error('No pudimos resolver el contexto laboral solicitado.');
      }
      query.set('employmentContext', initialEmploymentContext.current);
      query.set('currencyCode', initialCurrencyCode.current);
    } else if (documentEmploymentId !== 'all') query.set('employmentId', documentEmploymentId);
    if (documentStatusGroup !== 'ALL') query.set('statusGroup', documentStatusGroup);
    if (cursor) query.set('cursor', cursor);
    return api<DocumentPage>(`/documents?${query}`);
  }, [context, documentEmploymentId, documentKind, documentPeriod, documentSearch, documentSettlementType, documentStatusGroup, documentYear]);
  const reloadDocuments = useCallback(async (silent = false) => {
    if (loading) return;
    const generation = ++documentRequestGeneration.current;
    setLoadingMoreDocuments(false);
    setDocumentNavigationError('');
    if (!silent) {
      setDocumentsLoading(true); setDocuments([]); setDocumentCursor(null);
    }
    setDocumentError('');
    try {
      const page = await fetchDocumentPrefix(fetchDocumentPage, silent ? Math.max(100, loadedDocumentCount.current) : 100);
      if (generation !== documentRequestGeneration.current) return;
      applyDocuments(page.items);
      setDocumentCursor(page.nextCursor); setDocumentTotal(page.total); setDocumentPendingReview(page.pendingReview);
    } catch (caught) {
      if (generation !== documentRequestGeneration.current) return;
      setDocumentError(caught instanceof Error ? caught.message : 'No pudimos cargar los documentos.');
    } finally { if (!silent && generation === documentRequestGeneration.current) setDocumentsLoading(false); }
  }, [applyDocuments, fetchDocumentPage, loading]);
  const loadSalary = useCallback(async (preferredLocation?: Pick<OwnerLocation, 'currencyCode' | 'employmentContext' | 'employmentId'>) => {
    comparisonRequestGeneration.current += 1;
    const next = await api<SalaryHistory>('/salary-history');
    const owner = readOwnerLocation(window.location.search);
    const effective = effectiveSalaryContext(next, preferredLocation ?? owner, selectedScopeKeyRef.current);
    const nextKey = effective ? salaryScopeKey(effective) : '';
    if (nextKey !== selectedScopeKeyRef.current) invalidateScopeData();
    setHistory(next);
    selectedScopeKeyRef.current = nextKey;
    setSelectedScopeKey(nextKey);
    setDocumentEmploymentId(effective?.employmentId ?? 'all');
    if (!salaryLocationMatchesContext(owner, effective)) canonicalizeSalaryContext(effective);
    setComparison(null); setComparisonLoaded(false);
    return next;
  }, [canonicalizeSalaryContext, invalidateScopeData]);
  const loadReprocessingCandidates = useCallback(async () => {
    const next = await api<{ items: ReprocessingCandidate[]; total: number; batchLimit: number }>('/reprocessing/candidates?page=1&limit=100');
    setReprocessingCandidates(next.items);
    setReprocessingCandidateTotal(next.total);
    setReprocessingBatchLimit(next.batchLimit);
    return next;
  }, []);
  const loadRecovery = useCallback(async () => {
    setReprocessingLoading(true); setReprocessingError('');
    const [candidates, batch] = await Promise.allSettled([
        api<{ items: ReprocessingCandidate[]; total: number; batchLimit: number }>('/reprocessing/candidates?page=1&limit=100'),
        api<ReprocessingBatch | null>('/reprocessing-batches/latest'),
      ]);
    if (candidates.status === 'fulfilled') {
      setReprocessingCandidates(candidates.value.items);
      setReprocessingCandidateTotal(candidates.value.total);
      setReprocessingBatchLimit(candidates.value.batchLimit);
    }
    if (batch.status === 'fulfilled') setReprocessingBatch(batch.value);
    const failure = candidates.status === 'rejected' ? candidates.reason : batch.status === 'rejected' ? batch.reason : null;
    if (failure) setReprocessingError(failure instanceof Error ? failure.message : 'No pudimos consultar todas las mejoras disponibles.');
    setReprocessingLoading(false);
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [historyResult, jobsResult] = await Promise.allSettled([
      api<SalaryHistory>('/salary-history'),
      api<Employment[]>('/employments'),
    ]);
    if (historyResult.status === 'fulfilled') {
      const nextHistory = historyResult.value;
      const owner = readOwnerLocation(window.location.search);
      const effective = effectiveSalaryContext(nextHistory, owner, selectedScopeKeyRef.current);
      const nextKey = effective ? salaryScopeKey(effective) : '';
      setHistory(nextHistory);
      selectedScopeKeyRef.current = nextKey;
      setSelectedScopeKey(nextKey);
      if (!salaryLocationMatchesContext(owner, effective)) canonicalizeSalaryContext(effective);
      if (!historyInitialized.current) {
        historyInitialized.current = true;
        setDocumentEmploymentId(effective?.employmentId ?? 'all');
      }
      setComparison(null); setComparisonLoaded(false);
    }
    if (jobsResult.status === 'fulfilled') setEmployments(jobsResult.value);
    const failure = historyResult.status === 'rejected' ? historyResult.reason : jobsResult.status === 'rejected' ? jobsResult.reason : null;
    if (failure) setError(failure instanceof Error ? failure.message : 'No pudimos cargar todo el historial.');
    setLoading(false);
  }, [canonicalizeSalaryContext]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { void Promise.resolve().then(loadRecovery); }, [loadRecovery]);
  useEffect(() => { void Promise.resolve().then(() => reloadDocuments()); }, [reloadDocuments]);
  const activeReprocessingBatchId = reprocessingBatch && batchIsActive(reprocessingBatch) ? reprocessingBatch.id : null;
  useEffect(() => {
    if (!activeReprocessingBatchId) return;
    const batchId = activeReprocessingBatchId;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api<ReprocessingBatch>(`/reprocessing-batches/${batchId}`);
        setReprocessingError('');
        setReprocessingBatch(next);
        if (!batchIsActive(next)) {
          window.clearInterval(timer);
          await Promise.all([loadReprocessingCandidates(), loadSalary(), reloadDocuments(true)]);
        }
      } catch (caught) {
        setReprocessingError(caught instanceof Error ? caught.message : 'No pudimos actualizar el lote.');
      } finally { polling = false; }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [activeReprocessingBatchId, loadReprocessingCandidates, loadSalary, reloadDocuments]);
  useEffect(() => {
    if (loadingMoreDocuments || !documents.some((document) => processingDocumentPattern.test(document.processingStatus))) return;
    const timer = window.setTimeout(async () => {
      const generation = ++documentRequestGeneration.current;
      try {
        const docs: DocumentItem[] = [];
        const targetCount = Math.max(100, documents.length);
        let cursor: string | undefined;
        let nextCursor: string | null = null;
        let total = documentTotal;
        let pendingReview = documentPendingReview;
        while (docs.length < targetCount) {
          const pageLimit = Math.min(100, targetCount - docs.length);
          const page = await fetchDocumentPage(cursor, pageLimit);
          if (generation !== documentRequestGeneration.current) return;
          docs.push(...page.items);
          total = page.total; pendingReview = page.pendingReview; nextCursor = page.nextCursor;
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        const visible = docs;
        if (generation !== documentRequestGeneration.current) return;
        applyDocuments(visible);
        setDocumentCursor(nextCursor); setDocumentTotal(total); setDocumentPendingReview(pendingReview);
        if (selectedId) setDetailReload((value) => value + 1);
        if (!visible.some((document) => processingDocumentPattern.test(document.processingStatus))) {
          try { await loadSalary(); }
          catch (caught) { setError(caught instanceof Error ? caught.message : 'Los documentos se actualizaron, pero no el análisis salarial.'); }
        }
      } catch (caught) { if (generation === documentRequestGeneration.current) setDocumentError(caught instanceof Error ? caught.message : 'No pudimos actualizar el procesamiento.'); }
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [documents, applyDocuments, documentPendingReview, documentTotal, fetchDocumentPage, loadSalary, loadingMoreDocuments, selectedId]);
  const loadProcessingRuns = useCallback(async () => {
    if (!selectedId) { setProcessingRuns([]); setRunPreviews({}); setRunPreviewErrors({}); return; }
    const documentId = selectedId;
    setRunsLoading(true); setRunsError('');
    try {
      const next = await api<{ items: ProcessingRun[] }>(`/documents/${documentId}/processing-runs?limit=20`);
      const reviewRuns = next.items.filter((run) => !run.active && (run.status === 'REVIEW_REQUIRED' || run.promotionOutcome === 'REVIEW_REQUIRED'));
      const details = await Promise.allSettled(reviewRuns.map((run) => api<ProcessingRunDetail>(`/documents/${documentId}/processing-runs/${run.id}`)));
      if (activeDocumentId.current === documentId) {
        const previews: Record<string, ProcessingComparisonPreview | null | undefined> = {};
        const errors: Record<string, string> = {};
        reviewRuns.forEach((run, index) => {
          const result = details[index];
          if (result?.status === 'fulfilled') previews[run.id] = result.value.comparisonPreview;
          else if (result?.status === 'rejected') errors[run.id] = result.reason instanceof Error ? result.reason.message : 'No pudimos cargar la comparación.';
        });
        setProcessingRuns(next.items);
        setRunPreviews(previews);
        setRunPreviewErrors(errors);
      }
    } catch (caught) {
      if (activeDocumentId.current === documentId) setRunsError(caught instanceof Error ? caught.message : 'No pudimos cargar el historial técnico.');
    } finally {
      if (activeDocumentId.current === documentId) setRunsLoading(false);
    }
  }, [selectedId]);
  useEffect(() => {
    if (selectedId) void Promise.resolve().then(loadProcessingRuns);
  }, [loadProcessingRuns, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const documentId = selectedId;
    let stopped = false;
    api<DocumentDetail>(`/documents/${documentId}`)
      .then((nextDetail) => {
        if (stopped || activeDocumentId.current !== documentId) return;
        setDetailError('');
        setDetail(nextDetail);
        setSelected((current) => current?.id === documentId ? {
          ...current,
          documentType: nextDetail.documentType,
          errorCode: nextDetail.errorCode,
          originalAvailable: nextDetail.originalAvailable,
          processingStatus: nextDetail.processingStatus,
        } : current);
        if (nextDetail.originalAvailable && nextDetail.securityStatus === 'CLEAN' && !previewRequested.current && !privacyEnabled) authorizePreview();
      })
      .catch(async (caught: unknown) => {
        if (stopped || activeDocumentId.current !== documentId) return;
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        if (!stopped && activeDocumentId.current === documentId) setDetailError(caught instanceof ApiError && caught.status === 404 ? 'Este documento fue eliminado o ya no está disponible.' : caught instanceof Error ? caught.message : 'No pudimos abrir el detalle.');
      });
    return () => { stopped = true; };
  }, [authorizePreview, detailReload, privacyEnabled, selectedId, selectedStatus]);

  const refreshDetail = useCallback(async () => {
    if (!selectedId) return;
    const documentId = selectedId;
    const nextDetail = await api<DocumentDetail>(`/documents/${documentId}`);
    if (activeDocumentId.current === documentId) setDetail(nextDetail);
    return nextDetail;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !detail?.analysis?.reprocess.inProgress) return;
    const documentId = selectedId;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api<DocumentDetail>(`/documents/${documentId}`);
        if (activeDocumentId.current !== documentId) return;
        setDetail(next);
        await loadProcessingRuns();
        if (!next.analysis?.reprocess.inProgress) {
          window.clearInterval(timer);
          await Promise.all([loadSalary(), reloadDocuments(true), loadReprocessingCandidates()]);
        }
      } catch (caught) {
        if (activeDocumentId.current === documentId) setDetailError(caught instanceof ApiError && caught.status === 404 ? 'Este documento fue eliminado mientras estaba abierto.' : caught instanceof Error ? caught.message : 'No pudimos actualizar el análisis.');
      } finally { polling = false; }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [detail?.analysis?.reprocess.inProgress, loadProcessingRuns, loadReprocessingCandidates, loadSalary, reloadDocuments, selectedId]);

  useEffect(() => {
    const syncFromHistory = () => {
      const allowed = allowNextPop.current;
      allowNextPop.current = false;
      if (!allowed && reviewBusy) {
        window.history.pushState(window.history.state, '', reviewUrl.current);
        return;
      }
      if (!allowed && reviewDirty && !window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?')) {
        window.history.pushState(window.history.state, '', reviewUrl.current);
        return;
      }
      const location = readDocumentLocation(window.location.search);
      const owner = readOwnerLocation(window.location.search);
      initialCurrencyCode.current = owner.currencyCode;
      initialEmploymentId.current = owner.employmentId;
      initialEmploymentContext.current = owner.employmentContext;
      setTab(owner.tab ?? (location ? 'documents' : 'summary'));
      setYearFilter(owner.year ?? 'all');
      setEvolutionRange(owner.range ?? '12');
      setPerspective(owner.tab === 'purchasing-power' ? 'purchasing-power' : owner.perspective ?? 'nominal');
      setSelectedPeriod(owner.period ?? '');
      setDocumentYear(owner.year ?? 'all');
      setDocumentYearDraft(owner.year && owner.year !== 'all' ? owner.year : '');
      setDocumentPeriod(owner.period ?? '');
      setDocumentKind(owner.documentType ?? 'ALL');
      setDocumentSettlementType(owner.settlementType && settlementTypeOptions.includes(owner.settlementType as (typeof settlementTypeOptions)[number]) ? owner.settlementType : 'all');
      setDocumentStatusGroup(owner.status ?? 'ALL');
      if (history) {
        const nextContext = effectiveSalaryContext(history, owner, selectedScopeKey);
        const nextKey = nextContext ? salaryScopeKey(nextContext) : '';
        if (nextKey !== selectedScopeKey) {
          invalidateScopeData();
          setCategoryFilter('all');
        }
        selectedScopeKeyRef.current = nextKey;
        setSelectedScopeKey(nextKey);
        setDocumentEmploymentId(nextContext?.employmentId ?? 'all');
        if (!salaryLocationMatchesContext(owner, nextContext)) canonicalizeSalaryContext(nextContext);
      } else {
        setDocumentEmploymentId(owner.employmentId ?? 'all');
      }
      if (location?.documentId !== selectedId) {
        invalidatePreview();
        setPrivacyPreviewDocumentId(null);
        setDetail(null);
        setDetailError('');
        setProcessingRuns([]);
        setRunPreviews({});
        setRunPreviewErrors({});
        setRunsError('');
      }
      setOpenedFromList(false);
      setLocationSeed(location ? { evidenceId: location.evidenceId, page: location.page } : {});
      const next = location ? resolveDocumentItem(documents, location.documentId) : null;
      activeDocumentId.current = next?.id;
      setSelected(next);
      if (location) reviewUrl.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!location) { setDetail(null); setPreview(null); }
    };
    window.addEventListener('popstate', syncFromHistory);
    return () => window.removeEventListener('popstate', syncFromHistory);
  }, [canonicalizeSalaryContext, documents, history, invalidatePreview, invalidateScopeData, reviewBusy, reviewDirty, selectedId, selectedScopeKey]);

  function openDocument(document: DocumentItem, trigger: HTMLButtonElement) {
    if (selectedId === document.id) {
      if (!detail) { setDetailError(''); setDetailReload((value) => value + 1); }
      return;
    }
    invalidatePreview();
    setPrivacyPreviewDocumentId(null);
    opener.current = trigger;
    activeDocumentId.current = document.id;
    setProcessingRuns([]); setRunPreviews({}); setRunPreviewErrors({}); setRunsError('');
    setSelected(document); setDetail(null); setDetailError(''); setLocationSeed({}); setOpenedFromList(true); setError('');
    reviewUrl.current = `${window.location.pathname}${writeDocumentLocation(window.location.search, { documentId: document.id })}${window.location.hash}`;
    window.history.pushState(window.history.state, '', reviewUrl.current);
  }
  async function saveCorrections(changes: Array<{ field: ExtractedFieldDetail; value: string }>, extractionRunId: string) {
    try {
      const ordered = [...changes].sort((left, right) =>
        Number(right.field.fieldPath === 'settlement.payrollPeriod') - Number(left.field.fieldPath === 'settlement.payrollPeriod'));
      for (const { field, value } of ordered) {
        await api(`/documents/${selected?.id}/corrections`, {
          method: 'POST',
          body: JSON.stringify({ ...(field.id ? { extractedFieldId: field.id } : { fieldPath: field.fieldPath }), correctedValue: value, extractionRunId }),
        });
      }
    } finally {
      await Promise.all([refreshDetail(), loadSalary(), reloadDocuments(true)]);
    }
  }
  async function deleteOriginal() {
    if (!selected || !confirm('¿Eliminar el PDF original? Los datos estructurados se conservarán.')) return;
    invalidatePreview();
    await runSensitive(async () => {
      await api(`/documents/${selected.id}/original`, { method: 'DELETE', body: '{}' });
      await Promise.all([reloadDocuments(true), refreshDetail()]);
    });
  }
  async function downloadOriginal() {
    if (!selected) return;
    if (privacyEnabled && !window.confirm('El modo privacidad está activo. El PDF descargado conserva todos los datos salariales. ¿Descargarlo igualmente?')) return;
    await runSensitive(async () => {
      const download = await api<{ url: string }>(`/documents/${selected.id}/original?disposition=attachment`);
      const anchor = document.createElement('a');
      anchor.href = download.url;
      anchor.rel = 'noreferrer';
      anchor.click();
    });
  }
  async function deleteDocument() {
    if (!selected || !confirm('¿Eliminar el PDF y todos sus datos extraídos? Esta acción no se puede deshacer.')) return;
    invalidatePreview();
    await runSensitive(async () => {
      await api(`/documents/${selected.id}`, { method: 'DELETE', body: '{}' });
      onLocationChange({ tab: 'documents', employmentId: context?.employmentId ?? null }, true);
      activeDocumentId.current = undefined;
      setSelected(null); setDetail(null);
      await Promise.all([loadSalary(), reloadDocuments(true)]);
    });
  }
  async function confirmType(documentType: 'PAYROLL' | 'UNSUPPORTED') {
    if (!selected) return;
    await api(`/documents/${selected.id}/type-confirmation`, { method: 'POST', body: JSON.stringify({ documentType }) });
    await Promise.all([loadSalary(), reloadDocuments(true), refreshDetail()]);
  }
  async function saveUnsupportedFeedback(comment: string) {
    if (!selected) return null;
    const saved = await api<{ comment: string | null }>(`/documents/${selected.id}/unsupported-feedback`, {
      method: 'PUT', body: JSON.stringify({ comment }),
    });
    await refreshDetail();
    return saved.comment;
  }
  async function completeReview(acceptDeductionsMismatch: boolean, extractionRunId: string) {
    if (!selected) return;
    await api(`/documents/${selected.id}/review-complete`, { method: 'POST', body: JSON.stringify({ acceptDeductionsMismatch, extractionRunId }) });
    await Promise.all([loadSalary(), reloadDocuments(true), refreshDetail()]);
  }

  const updateDocumentLocation = useCallback((page: number, evidenceId?: string) => {
    if (!selectedId) return;
    reviewUrl.current = `${window.location.pathname}${writeDocumentLocation(window.location.search, { documentId: selectedId, page, evidenceId })}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', reviewUrl.current);
  }, [selectedId]);

  function closeDocument() {
    invalidatePreview();
    setPrivacyPreviewDocumentId(null);
    if (openedFromList && readDocumentLocation(window.location.search)?.documentId === selectedId) {
      allowNextPop.current = true;
      window.history.back();
      return;
    }
    onLocationChange({ tab: 'documents', employmentId: context?.employmentId ?? null }, true);
    activeDocumentId.current = undefined;
    setSelected(null); setDetail(null); setDetailError('');
  }

  function closeDetailState() {
    if (reviewBusy || (reviewDirty && !window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?'))) return;
    closeDocument();
  }

  async function navigateDocument(direction: -1 | 1) {
    if (!selectedId) return;
    setDocumentNavigationError('');
    const index = documents.findIndex(({ id }) => id === selectedId);
    if (index < 0) return;
    let next = documents[index + direction];
    if (!next && direction === 1 && documentCursor && !loadingMoreDocuments) {
      const generation = ++documentRequestGeneration.current;
      setLoadingMoreDocuments(true); setDocumentError('');
      try {
        const page = await fetchDocumentPage(documentCursor);
        if (generation !== documentRequestGeneration.current || activeDocumentId.current !== selectedId) return;
        next = page.items[0];
        setDocuments((current) => [...current, ...page.items.filter((item) => !current.some(({ id }) => id === item.id))]);
        setDocumentCursor(page.nextCursor); setDocumentTotal(page.total); setDocumentPendingReview(page.pendingReview);
      } catch (caught) {
        if (generation === documentRequestGeneration.current && activeDocumentId.current === selectedId) {
          setDocumentNavigationError(caught instanceof Error ? caught.message : 'No pudimos cargar el siguiente documento.');
        }
      } finally {
        if (generation === documentRequestGeneration.current) setLoadingMoreDocuments(false);
      }
    }
    if (!next) return;
    invalidatePreview();
    setPrivacyPreviewDocumentId(null);
    activeDocumentId.current = next.id;
    setProcessingRuns([]); setRunPreviews({}); setRunPreviewErrors({}); setRunsError('');
    setSelected(next); setDetail(null); setDetailError(''); setLocationSeed({});
    reviewUrl.current = `${window.location.pathname}${writeDocumentLocation(window.location.search, { documentId: next.id })}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', reviewUrl.current);
  }

  async function reprocessDocument(retry = false) {
    if (!selected || !confirm(retry ? '¿Reintentar el análisis de este PDF? El intento fallido queda en el historial técnico.' : '¿Buscar una mejora con la versión actual? El análisis activo y tus correcciones se conservan mientras comparamos.')) return;
    await api(`/documents/${selected.id}/reprocess`, {
      method: 'POST',
      body: JSON.stringify(retry ? { retry: true } : {}),
      headers: { 'Idempotency-Key': browserOpaqueToken() },
    });
    await Promise.all([reloadDocuments(true), refreshDetail(), loadProcessingRuns(), loadReprocessingCandidates()]);
  }
  async function decideProcessingRun(run: ProcessingRun, decision: 'PROMOTE' | 'KEEP_ACTIVE') {
    if (!selected || !detail?.analysis) return;
    try {
      await api(`/documents/${selected.id}/processing-runs/${run.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, expectedActiveRunId: detail.analysis.activeRunId }),
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'ACTIVE_RUN_CHANGED') {
        await Promise.all([refreshDetail(), loadProcessingRuns()]);
        throw new Error('El análisis activo fue actualizado en otra sesión. Recargamos el historial para que decidas sobre la versión vigente.');
      }
      throw caught;
    }
    await Promise.all([refreshDetail(), loadProcessingRuns(), loadRecovery(), loadSalary(), reloadDocuments(true)]);
  }
  function dismissReprocessingBatch() {
    if (!reprocessingBatch || batchIsActive(reprocessingBatch)) return;
    setDismissedReprocessingBatchId(reprocessingBatch.id);
    try { window.localStorage.setItem(dismissedReprocessingBatchKey, reprocessingBatch.id); }
    catch { /* El estado local alcanza hasta recargar si storage está bloqueado. */ }
  }
  function reviewReprocessingResults() {
    setTab('documents'); setDocumentKind('ALL'); setDocumentSearchDraft(''); setDocumentSearch('');
    setDocumentYearDraft(''); setDocumentYear('all'); setDocumentPeriod(''); setDocumentSettlementType('all');
    setDocumentEmploymentId(context?.employmentId ?? 'all'); setDocumentStatusGroup('REVIEW'); setCheckedDocumentIds([]); setSelected(null);
    onLocationChange({ tab: 'documents', employmentId: context?.employmentId ?? null, documentType: 'ALL', year: null, period: null, settlementType: null, status: 'REVIEW' }, false);
    window.setTimeout(() => {
      const panel = document.getElementById('history-panel-documents');
      panel?.focus();
      panel?.scrollIntoView({ block: 'start' });
    });
  }
  async function startReprocessingBatch() {
    const availableCandidates = reprocessingCandidates.filter((candidate) => candidate.available).length;
    if (reprocessingBusy || batchIsActive(reprocessingBatch) || !availableCandidates) return;
    const batchSize = Math.min(availableCandidates, reprocessingBatchLimit);
    const batchScope = reprocessingCandidateTotal > reprocessingBatchLimit
      ? `; se procesarán ${batchSize} ahora de ${reprocessingCandidateTotal} candidatos`
      : reprocessingCandidateTotal > batchSize ? `; ${reprocessingCandidateTotal - batchSize} ya están en proceso` : '';
    if (!confirm(`¿Buscar mejoras en ${batchSize} documento${batchSize === 1 ? '' : 's'}${batchScope}? Los análisis activos se conservan hasta comparar cada resultado.`)) return;
    setReprocessingBusy(true); setReprocessingError('');
    try {
      const next = await api<ReprocessingBatch>('/reprocessing-batches', {
        method: 'POST',
        body: '{}',
        headers: { 'Idempotency-Key': browserOpaqueToken() },
      });
      setReprocessingBatch(next);
      await loadReprocessingCandidates();
    } catch (caught) {
      setReprocessingError(caught instanceof Error ? caught.message : 'No pudimos iniciar el lote.');
    } finally { setReprocessingBusy(false); }
  }
  async function associateDocuments() {
    if (!checkedDocumentIds.length || !employmentChoice || associating) return;
    const preferredEmploymentId = employmentChoice === 'none' ? undefined : employmentChoice;
    const preferredEmployment = employments.find((employment) => employment.id === preferredEmploymentId);
    const preferredLocation = preferredEmploymentId ? {
      currencyCode: context?.currencyCode ?? preferredEmployment?.currencyCode,
      employmentContext: preferredEmploymentId,
      employmentId: preferredEmploymentId,
    } : undefined;
    setAssociating(true); setError('');
    try {
      await api('/documents/employment', {
        method: 'PATCH',
        body: JSON.stringify({
          documentIds: checkedDocumentIds,
          employmentId: employmentChoice === 'none' ? null : employmentChoice,
        }),
      });
      setCheckedDocumentIds([]); setEmploymentChoice(''); await Promise.all([loadSalary(preferredLocation), reloadDocuments(true)]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos asociar los documentos.'); }
    finally { setAssociating(false); }
  }

  const years = scope?.annual.map(({ year }) => year) ?? [];
  const selectedYear = yearFilter === 'all' || years.includes(yearFilter) ? yearFilter : 'all';
  const periods = scope?.evolution.map(({ period }) => period) ?? [];
  const availableRangeValues = relevantEvolutionRanges(periods);
  const selectedEvolutionRange = (availableRangeValues as readonly string[]).includes(evolutionRange) ? evolutionRange : 'all';
  const evolutionTab = tab === 'evolution' || tab === 'purchasing-power';
  const selectedPerspective: EconomicPerspective = tab === 'purchasing-power' ? 'purchasing-power' : perspective;
  const selectedPerspectiveLabel = economicPerspectives.find(([value]) => value === selectedPerspective)?.[1] ?? 'Nominal';
  const selectedFromPeriod = periods.includes(fromPeriod) ? fromPeriod : periods[0] ?? '';
  const selectedToPeriod = periods.includes(toPeriod) ? toPeriod : periods.at(-1) ?? '';
  const visibleComparison = comparison
    && comparison.employmentContext === context?.employmentContext
    && comparison.currencyCode === context?.currencyCode
    && comparison.fromPeriod === selectedFromPeriod
    && comparison.toPeriod === selectedToPeriod
    ? comparison
    : null;
  const selectedPoint = scope?.evolution.find((point) => point.period === selectedPeriod) ?? null;
  const selectedEconomicProjection = selectedPoint && selectedPerspective === 'historical-usd'
    ? selectedPoint.economic?.historicalUsd
    : selectedPoint && selectedPerspective === 'purchasing-power'
      ? selectedPoint.economic?.purchasingPower
      : undefined;
  const selectedEconomicObservations = selectedPoint && selectedPerspective === 'purchasing-power'
    ? [...(selectedPoint.economic?.historicalUsd.observations ?? []), ...(selectedPoint.economic?.purchasingPower.observations ?? [])]
    : selectedEconomicProjection?.observations ?? [];
  const selectedPointAmounts = selectedPerspective === 'nominal' ? selectedPoint?.totals : selectedEconomicProjection?.amounts;
  const selectedPointComparable = selectedPerspective === 'nominal' ? selectedPoint?.comparableSalary : selectedEconomicProjection?.comparableSalary;
  const selectedPointCurrency = selectedPerspective === 'nominal' ? scope?.currencyCode : selectedEconomicProjection?.currencyCode || scope?.currencyCode;
  const purchasingPowerReferencePeriod = selectedPerspective === 'purchasing-power'
    ? scope?.evolution.map((point) => point.economic?.purchasingPower.referencePeriod).find((period) => period) ?? null
    : null;
  const economicContextDescription = purchasingPowerReferencePeriod
    ? `El gráfico y la columna de poder adquisitivo están expresados a precios de ${periodLabel(purchasingPowerReferencePeriod)}. Los importes originales del recibo no cambian.`
    : 'Es una perspectiva derivada: los importes originales del recibo no cambian.';
  const annualRows = scope?.annual.filter(({ year }) => selectedYear === 'all' || year === selectedYear) ?? [];
  const latestEvents = scope?.events?.slice(-6).reverse() ?? [];
  const possibleDuplicates = context
    ? history?.analytics.possibleDuplicates.filter((duplicate) => duplicate.employmentContext === context.employmentContext && duplicate.currencyCode === context.currencyCode) ?? []
    : [];
  const conceptPath = tab === 'concepts' ? salaryConceptPath(context, selectedYear, categoryFilter) : null;
  useEffect(() => {
    if (!conceptPath) return;
    const generation = ++conceptRequestGeneration.current;
    let stopped = false;
    void Promise.resolve().then(async () => {
      setConceptLoading(true); setConcepts([]); setConceptCursor(null); setConceptError('');
      try {
        const page = await api<SalaryConceptPage>(conceptPath);
        if (!stopped && generation === conceptRequestGeneration.current) { setConcepts(page.items); setConceptCursor(page.nextCursor); }
      } catch (caught) {
        if (!stopped && generation === conceptRequestGeneration.current) setConceptError(caught instanceof Error ? caught.message : 'No pudimos cargar los conceptos.');
      } finally { if (!stopped && generation === conceptRequestGeneration.current) setConceptLoading(false); }
    });
    return () => { stopped = true; };
  }, [conceptPath, conceptReloadKey]);

  function selectScope(key: string) {
    invalidateScopeData();
    selectedScopeKeyRef.current = key;
    setSelectedScopeKey(key); setYearFilter('all'); setCategoryFilter('all');
    const nextContext = history?.contexts.find((item) => salaryScopeKey(item) === key);
    initialCurrencyCode.current = nextContext?.currencyCode;
    initialEmploymentId.current = nextContext?.employmentId ?? undefined;
    initialEmploymentContext.current = nextContext?.employmentContext;
    setEvolutionRange('12'); setSelectedPeriod('');
    setDocumentYear('all'); setDocumentYearDraft(''); setDocumentPeriod('');
    setDocumentEmploymentId(nextContext?.employmentId ?? 'all');
    onLocationChange({ currencyCode: nextContext?.currencyCode ?? null, employmentContext: nextContext?.employmentContext ?? null, employmentId: nextContext?.employmentId ?? null, year: null, period: null, perspective: tab === 'evolution' || tab === 'purchasing-power' ? selectedPerspective : null, range: null }, false);
  }

  function historyTabPatch(next: HistoryTab): OwnerLocationPatch {
    const scopeLocation = {
      section: 'history' as const,
      currencyCode: context?.currencyCode ?? initialLocation.currencyCode ?? null,
      employmentContext: context?.employmentContext ?? initialLocation.employmentContext ?? null,
      employmentId: context?.employmentId ?? initialLocation.employmentId ?? null,
    };
    if (next === 'documents') {
      const year = tab === 'annual' || tab === 'concepts' ? selectedYear : documentYear;
      const period = tab === 'evolution' || tab === 'purchasing-power' ? selectedPeriod : documentPeriod;
      return { ...scopeLocation, tab: next, year, period: period || null, perspective: null, range: null, documentType: documentKind, settlementType: documentSettlementType === 'all' ? null : documentSettlementType, status: documentStatusGroup };
    }
    if (next === 'annual' || next === 'concepts') {
      const year = tab === 'documents' ? documentYear : selectedYear;
      return { ...scopeLocation, tab: next, year, period: null, perspective: null, range: null, documentType: null, settlementType: null, status: null };
    }
    if (next === 'evolution') {
      const period = tab === 'documents' ? documentPeriod : selectedPeriod;
      const nextPerspective = tab === 'purchasing-power' ? 'nominal' : selectedPerspective;
      return { ...scopeLocation, tab: next, year: null, period: period || null, perspective: nextPerspective, range: selectedEvolutionRange, documentType: null, settlementType: null, status: null };
    }
    if (next === 'purchasing-power') {
      const period = tab === 'documents' ? documentPeriod : selectedPeriod;
      return { ...scopeLocation, tab: next, year: null, period: period || null, perspective: 'purchasing-power', range: selectedEvolutionRange, documentType: null, settlementType: null, status: null };
    }
    return { ...scopeLocation, tab: next, year: null, period: null, perspective: null, range: null, documentType: null, settlementType: null, status: null };
  }

  function historyTabHref(next: HistoryTab) {
    return `/${writeOwnerLocation('', historyTabPatch(next))}`;
  }

  function selectHistoryTab(next: HistoryTab) {
    setTab(next);
    if (next === 'documents') {
      const year = tab === 'annual' || tab === 'concepts' ? selectedYear : documentYear;
      const period = tab === 'evolution' || tab === 'purchasing-power' ? selectedPeriod : documentPeriod;
      setDocumentYear(year); setDocumentYearDraft(year === 'all' ? '' : year); setDocumentPeriod(period);
    } else if (next === 'annual' || next === 'concepts') {
      setYearFilter(tab === 'documents' ? documentYear : selectedYear);
    } else if (next === 'evolution') {
      const period = tab === 'documents' ? documentPeriod : selectedPeriod;
      setSelectedPeriod(period); setPerspective(tab === 'purchasing-power' ? 'nominal' : selectedPerspective);
    } else if (next === 'purchasing-power') {
      const period = tab === 'documents' ? documentPeriod : selectedPeriod;
      setSelectedPeriod(period); setPerspective('purchasing-power');
    }
    onLocationChange(historyTabPatch(next), false);
  }

  function selectPerspective(next: EconomicPerspective) {
    const nextTab = tab === 'purchasing-power' && next !== 'purchasing-power' ? 'evolution' : tab;
    setPerspective(next);
    if (nextTab !== tab) setTab(nextTab);
    onLocationChange({ tab: nextTab, perspective: next, range: selectedEvolutionRange }, true);
  }

  function selectEvolutionPeriod(period: string) {
    setSelectedPeriod(period);
    onLocationChange({ tab: tab === 'purchasing-power' ? 'purchasing-power' : 'evolution', employmentId: context?.employmentId ?? null, period, perspective: selectedPerspective }, true);
  }

  function showPeriodDocuments(period: string) {
    setTab('documents'); setDocumentPeriod(period); setDocumentYear('all'); setDocumentYearDraft('');
    setDocumentEmploymentId(context?.employmentId ?? 'all'); setCheckedDocumentIds([]); setSelected(null);
    onLocationChange({ tab: 'documents', employmentId: context?.employmentId ?? null, period, perspective: null, year: null }, false);
  }

  function preparePeriodComparison(period: string) {
    comparisonRequestGeneration.current += 1;
    const index = periods.indexOf(period);
    const previous = periods[index - 1] ?? periods[0] ?? '';
    setFromPeriod(previous); setToPeriod(period); setComparison(null); setComparisonLoaded(false); setTab('summary');
    onLocationChange({ tab: 'summary', employmentId: context?.employmentId ?? null, period, perspective: null }, false);
  }

  function selectDocumentKind(kind: (typeof documentKinds)[number][0]) {
    setDocumentKind(kind); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentPeriod('');
    setDocumentSettlementType('all'); setCheckedDocumentIds([]); setSelected(null);
    onLocationChange({ documentType: kind, year: null, period: null, settlementType: null }, true);
  }

  function moveHistoryTab(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    const last = historyTabs.length - 1;
    const nextIndex = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = historyTabs[nextIndex]![0];
    selectHistoryTab(next);
    document.getElementById(`history-tab-${next}`)?.focus();
  }

  async function loadMoreConcepts() {
    const path = conceptCursor ? salaryConceptPath(context, selectedYear, categoryFilter, conceptCursor) : null;
    if (!path || conceptLoadingMore) return;
    const generation = conceptRequestGeneration.current;
    setConceptLoadingMore(true); setConceptError('');
    try {
      const page = await api<SalaryConceptPage>(path);
      if (generation !== conceptRequestGeneration.current) return;
      setConcepts((current) => [...current, ...page.items]);
      setConceptCursor(page.nextCursor);
    } catch (caught) {
      if (generation === conceptRequestGeneration.current) setConceptError(caught instanceof Error ? caught.message : 'No pudimos cargar más conceptos.');
    } finally { if (generation === conceptRequestGeneration.current) setConceptLoadingMore(false); }
  }

  async function comparePeriods() {
    if (!context || !selectedFromPeriod || !selectedToPeriod || selectedFromPeriod === selectedToPeriod) return;
    const generation = ++comparisonRequestGeneration.current;
    setComparisonLoading(true); setComparisonLoaded(false); setError('');
    try {
      const query = new URLSearchParams({
        employmentContext: context.employmentContext,
        currencyCode: context.currencyCode,
        fromPeriod: selectedFromPeriod,
        toPeriod: selectedToPeriod,
      });
      const next = await api<PeriodComparison | null>(`/salary-history/comparison?${query}`);
      if (generation !== comparisonRequestGeneration.current) return;
      setComparison(next);
      setComparisonLoaded(true);
    } catch (caught) { if (generation === comparisonRequestGeneration.current) setError(caught instanceof Error ? caught.message : 'No pudimos comparar los períodos.'); }
    finally { if (generation === comparisonRequestGeneration.current) setComparisonLoading(false); }
  }

  async function loadMoreDocuments() {
    if (!documentCursor || loadingMoreDocuments) return;
    const generation = ++documentRequestGeneration.current;
    setLoadingMoreDocuments(true); setDocumentError('');
    try {
      const page = await fetchDocumentPage(documentCursor);
      if (generation !== documentRequestGeneration.current) return;
      setDocuments((current) => [...current, ...page.items.filter((item) => !current.some(({ id }) => id === item.id))]);
      setDocumentCursor(page.nextCursor); setDocumentTotal(page.total); setDocumentPendingReview(page.pendingReview);
    } catch (caught) {
      if (generation === documentRequestGeneration.current) setDocumentError(caught instanceof Error ? caught.message : 'No pudimos cargar más documentos.');
    } finally {
      if (generation === documentRequestGeneration.current) setLoadingMoreDocuments(false);
    }
  }

  const assignableDocuments = documents.filter((document) => document.documentType === 'PAYROLL' && associationReadyStatuses.has(document.processingStatus));
  const allAssignableSelected = assignableDocuments.length > 0
    && assignableDocuments.every((document) => checkedDocumentIds.includes(document.id));
  const candidateByDocument = new Map(reprocessingCandidates.map((candidate) => [candidate.documentId, candidate]));
  const documentGroups = new Map<string, DocumentItem[]>();
  for (const item of documents) {
    const year = item.payrollPeriod?.slice(0, 4) || item.createdAt.slice(0, 4) || 'Sin fecha';
    documentGroups.set(year, [...(documentGroups.get(year) ?? []), item]);
  }
  const candidatePeriods = new Map<string, 'available' | 'processing'>();
  for (const document of documents) {
    const candidate = candidateByDocument.get(document.id);
    if (!candidate || !document.payrollPeriod || !context) continue;
    const sameContext = context.employmentId
      ? document.employmentId === context.employmentId
      : context.employerName
        ? document.employerName === context.employerName
        : !document.employmentId;
    if (sameContext) candidatePeriods.set(document.payrollPeriod, candidate.inProgress ? 'processing' : 'available');
  }
  function documentRow(document: DocumentItem) {
    const showCheckbox = documentKind === 'PAYROLL';
    const assignable = document.documentType === 'PAYROLL' && associationReadyStatuses.has(document.processingStatus);
    const name = documentName(document, privacyEnabled);
    const metadata = document.documentType === 'PAYROLL'
      ? [document.employerName || 'Sin empresa asociada', document.payrollPeriod ? `Período: ${periodLabel(document.payrollPeriod)}` : 'Período sin detectar', document.settlementType ? settlementTypeLabel(document.settlementType) : null].filter(Boolean).join(' · ')
      : document.documentType === 'UNSUPPORTED' || document.processingStatus === 'REJECTED_UNSUPPORTED'
        ? 'Documento no soportado'
        : 'Tipo pendiente de clasificación';
    const candidate = candidateByDocument.get(document.id);
    return <div className={`document-entry${showCheckbox ? '' : ' no-check'}`} key={document.id}>{showCheckbox && <label className="document-check" title={assignable ? 'Seleccionar documento' : 'Disponible cuando termine el procesamiento'}><input type="checkbox" aria-label={`Seleccionar ${name}`} disabled={!assignable} checked={checkedDocumentIds.includes(document.id)} onChange={(event) => setCheckedDocumentIds((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} /></label>}<button type="button" className="document-row" onClick={(event) => openDocument(document, event.currentTarget)}><span className="file-icon">PDF</span><span className="document-copy"><strong title={name}>{name}</strong>{!privacyEnabled && name !== document.originalFilename && <small className="document-original" title={document.originalFilename}>Archivo original: {document.originalFilename}</small>}<small>{metadata}</small><small>Subido {timestampLabel(document.createdAt)}</small>{candidate && <small className="document-improvement">{candidate.inProgress ? 'Buscando una mejora…' : 'Mejora disponible para datos faltantes'}</small>}{document.errorCode && document.errorCode !== 'DOCUMENT_DUPLICATE' && <small className="document-reason">{importErrorLabels[document.errorCode] ?? 'El documento no pudo procesarse.'}</small>}</span><span className="document-badges"><DocumentStatusBadges document={document} />{candidate && <span className={`status ${candidate.inProgress ? 'pending' : 'ready'}`}>{candidate.inProgress ? 'Procesando' : 'Mejora disponible'}</span>}</span><span aria-hidden="true">›</span></button></div>;
  }
  const selectedDocumentIndex = documents.findIndex(({ id }) => id === selected?.id);
  const reprocessingBatchDismissed = batchWasDismissed(reprocessingBatch, dismissedReprocessingBatchId);
  const visibleReprocessingBatch = reprocessingBatchDismissed ? null : reprocessingBatch;
  const showReprocessingBanner = !reprocessingBatchDismissed || reprocessingCandidateTotal > 0;

  return (
    <div className="page" aria-busy={loading || documentsLoading || comparisonLoading || conceptLoading || conceptLoadingMore}>
      <PageHeader eyebrow="Datos estructurados" title="Historial salarial" />
      {showReprocessingBanner && <ReprocessingBanner availableCandidates={reprocessingCandidates.filter((candidate) => candidate.available).length} batch={visibleReprocessingBatch} batchLimit={reprocessingBatchLimit} busy={reprocessingBusy} candidates={reprocessingCandidateTotal} error={reprocessingError} loading={reprocessingLoading} onDismiss={dismissReprocessingBatch} onRetry={() => void loadRecovery()} onReview={reviewReprocessingResults} onStart={() => void startReprocessingBatch()} reviewCandidates={documentPendingReview} />}
      <div className="tabs history-tabs" role="tablist" aria-label="Secciones del historial">{historyTabs.map(([value, label], index) => <a id={`history-tab-${value}`} role="tab" href={historyTabHref(value)} aria-controls={`history-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={tab === value ? 'active' : ''} onKeyDown={(event) => moveHistoryTab(event, index)} onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); selectHistoryTab(value); } }} key={value}>{label}</a>)}</div>
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Reintentando…' : 'Reintentar'}</button></p>}
      {loading && !history && <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando el historial salarial…</p></div>}

      {history && context && scope && <>
        <SalaryScopeControl history={history} employments={employments} selectedKey={selectedScopeKey} onChange={selectScope} id="history-salary-scope" />
        <SalaryContextNotice context={context} />
        {(evolutionTab || tab === 'annual' || tab === 'concepts') && <div className="history-filters">{evolutionTab ? <><label>Rango<select value={selectedEvolutionRange} onChange={(event) => { const range = event.target.value as (typeof evolutionRanges)[number][0]; setEvolutionRange(range); onLocationChange({ range }, true); }}>{evolutionRanges.filter(([value]) => (availableRangeValues as readonly (string | number)[]).includes(value === 'all' ? 'all' : Number(value))).map(([value, label]) => <option value={value} key={value}>{value === 'all' ? 'Todo el empleo' : label}</option>)}</select></label><label>Ver evolución como<select value={selectedPerspective} onChange={(event) => selectPerspective(event.target.value as EconomicPerspective)}>{economicPerspectives.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></> : <><label>Año<select value={selectedYear} onChange={(event) => { setYearFilter(event.target.value); onLocationChange({ year: event.target.value }, true); }}><option value="all">Todos</option>{years.map((year) => <option value={year} key={year}>{year}</option>)}</select></label><label>Categoría<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | SalaryCategory)}><option value="all">Todas</option>{salaryCategories.map((item) => <option value={item} key={item}>{categoryLabels[item]}</option>)}</select></label></>}</div>}
      </>}

      {tab === 'summary' && <section id="history-panel-summary" role="tabpanel" aria-labelledby="history-tab-summary" tabIndex={0}>{history && context && scope ? <>
        <SalaryMetricGrid scope={scope} context={context} recoveryPeriods={candidatePeriods} />
        <div className="history-summary-grid">
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Últimos cambios</p><h2>Eventos informados</h2></div></div>{latestEvents.length ? <ul className="event-list">{latestEvents.map((event) => <li key={`${event.type}-${event.period}-${event.type === 'EXTRAORDINARY' ? event.settlementId : event.change.toPeriod}`}><span><strong>{event.type === 'COMPARABLE_INCREASE' ? 'Aumento comparable' : categoryLabels[event.category]}</strong><small>{periodLabel(event.period)}</small></span><strong>{event.type === 'COMPARABLE_INCREASE' ? <PercentageValue value={event.change.percentage} /> : <MoneyValue value={event.amount} currency={scope.currencyCode} kind="salary" />}</strong></li>)}</ul> : <EmptyState title="Sin cambios informados" body="Hacen falta más períodos comparables o liquidaciones extraordinarias." />}</section>
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Calidad del historial</p><h2>Cobertura</h2></div></div>{scope.coverage && scope.coverage.basis !== 'INDETERMINATE_CONTEXT' ? <><p className="coverage-total"><strong>{scope.coverage.availablePeriods.length}/{scope.coverage.expectedPeriods.length}</strong> períodos disponibles</p><p>{scope.coverage.possibleMissingPeriods.length ? `Posibles faltantes: ${scope.coverage.possibleMissingPeriods.map(periodLabel).join(', ')}.` : scope.coverage.basis === 'OBSERVED' ? 'Sin faltantes dentro del rango observado; no implica una relación laboral completa.' : 'No se detectaron posibles faltantes dentro del rango laboral.'}</p>{scope.coverage.boundaryContradiction && <p className="message warning" role="status">Las fechas del empleo contradicen períodos observados; se amplió el rango para no ocultarlos.</p>}</> : <p>N/D: sin contexto laboral suficiente para determinar períodos esperados.</p>}{possibleDuplicates.length > 0 && <p className="message warning" role="status">Hay {possibleDuplicates.length} período{possibleDuplicates.length === 1 ? '' : 's'} con posibles recibos duplicados para revisar.</p>}</section>
        </div>
        <section className="panel comparison-panel"><div className="panel-heading"><div><p className="eyebrow">Comparación exacta</p><h2>Dos períodos</h2></div></div>{periods.length > 1 ? <><div className="comparison-controls"><label>Desde<select value={selectedFromPeriod} onChange={(event) => { comparisonRequestGeneration.current += 1; setFromPeriod(event.target.value); setComparison(null); setComparisonLoaded(false); setComparisonLoading(false); }} >{periods.map((period) => <option value={period} key={period}>{periodLabel(period)}</option>)}</select></label><label>Hasta<select value={selectedToPeriod} onChange={(event) => { comparisonRequestGeneration.current += 1; setToPeriod(event.target.value); setComparison(null); setComparisonLoaded(false); setComparisonLoading(false); }}>{periods.map((period) => <option value={period} key={period}>{periodLabel(period)}</option>)}</select></label><button type="button" className="button primary" disabled={comparisonLoading || selectedFromPeriod === selectedToPeriod} onClick={() => void comparePeriods()}>{comparisonLoading ? 'Comparando…' : 'Comparar'}</button></div>{visibleComparison && <ComparisonResult comparison={visibleComparison} />}{comparisonLoaded && !visibleComparison && <EmptyState title="No se pueden comparar" body="No hay datos suficientes en uno de los períodos elegidos." />}</> : <EmptyState title="Falta otro período" body="La comparación necesita al menos dos períodos del mismo empleo y moneda." />}</section>
      </> : history && !loading ? <EmptyState title="Todavía no hay datos salariales" body="Importá recibos soportados y completá su revisión para construir el historial." /> : null}</section>}

      {evolutionTab && <section id={`history-panel-${tab}`} role="tabpanel" aria-labelledby={`history-tab-${tab}`} tabIndex={0}>{scope ? <section className="panel chart-panel"><div className="panel-heading"><div><p className="eyebrow">{tab === 'purchasing-power' ? 'Poder adquisitivo' : 'Evolución'}</p><h2>{selectedPerspective === 'nominal' ? 'Comparable y neto' : `Comparable y neto · ${selectedPerspectiveLabel}`}</h2></div></div>{selectedPerspective !== 'nominal' && <div className="economic-context" role="note"><strong>Contexto económico</strong><span>{context?.countryCode ?? 'País sin confirmar'} · moneda original {scope.currencyCode}{history?.economicCalculationVersion ? ` · cálculo ${history.economicCalculationVersion}` : ''}</span><p>{economicContextDescription}</p></div>}<SalaryEvolution scope={scope} perspective={selectedPerspective} limit={evolutionRanges.find(([value]) => value === selectedEvolutionRange)?.[2]} recoveryPeriods={candidatePeriods} selectedPeriod={selectedPoint?.period} onSelectPeriod={selectEvolutionPeriod} />{selectedPoint && <section className="settlement-detail" aria-labelledby="selected-period-title"><div className="panel-heading"><div><p className="eyebrow">Período seleccionado · {selectedPerspectiveLabel}</p><h3 id="selected-period-title">{periodLabel(selectedPoint.period)}</h3></div><button type="button" className="icon-button" aria-label="Cerrar detalle del período" onClick={() => { setSelectedPeriod(''); onLocationChange({ period: null }, true); }}>×</button></div>{selectedPerspective !== 'nominal' && <div className="economic-period-state"><span className={`status ${economicStatusClass(selectedEconomicProjection?.status ?? 'UNAVAILABLE')}`}>{economicStatusLabels[selectedEconomicProjection?.status ?? 'UNAVAILABLE']}</span><p>{economicStatusMessage(selectedEconomicProjection?.status ?? 'UNAVAILABLE', selectedEconomicProjection?.reason ?? null)}</p></div>}<dl className="settlement-overview"><div><dt>Básico comparable</dt><dd><MoneyValue value={selectedPointComparable} currency={selectedPointCurrency} kind="salary" /></dd></div><div><dt>Bruto</dt><dd><MoneyValue value={selectedPointAmounts?.grossAmount} currency={selectedPointCurrency} kind="salary" /></dd></div><div><dt>Neto</dt><dd><MoneyValue value={selectedPointAmounts?.netAmount} currency={selectedPointCurrency} kind="salary" /></dd></div><div><dt>Descuentos / créditos</dt><dd><MoneyValue value={selectedPointAmounts?.deductionsAmount} currency={selectedPointCurrency} kind="salary" creditAware /></dd></div></dl>{selectedPerspective !== 'nominal' && <EconomicEvidence observations={selectedEconomicObservations} referencePeriod={selectedEconomicProjection?.referencePeriod} />}<div className="modal-actions"><button type="button" className="button primary" onClick={() => showPeriodDocuments(selectedPoint.period)}>Ver conceptos y documentos fuente</button>{periods.length > 1 && <button type="button" className="button secondary" onClick={() => preparePeriodComparison(selectedPoint.period)}>Comparar período</button>}</div></section>}</section> : history && !loading ? <EmptyState title="Sin evolución" body="Todavía no hay liquidaciones analizadas." /> : null}</section>}

      {tab === 'annual' && <section id="history-panel-annual" role="tabpanel" aria-labelledby="history-tab-annual" tabIndex={0}>{scope ? <AnnualHistory rows={annualRows} scope={scope} category={categoryFilter} /> : history && !loading ? <EmptyState title="Sin resumen anual" body="Todavía no hay liquidaciones analizadas." /> : null}</section>}

      {tab === 'concepts' && <section id="history-panel-concepts" role="tabpanel" aria-labelledby="history-tab-concepts" tabIndex={0} aria-busy={conceptLoading || conceptLoadingMore}>
        {conceptError && <p className="message error" role="alert">{conceptError} <button type="button" className="text-button" disabled={conceptLoading} onClick={() => setConceptReloadKey((current) => current + 1)}>Reintentar</button></p>}
        {conceptLoading ? <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando conceptos…</p></div> : scope && concepts.length ? <><div className="table-wrap" role="region" aria-label="Conceptos salariales" tabIndex={0}><table><caption className="sr-only">Conceptos normalizados paginados por el servidor</caption><thead><tr><th>Período</th><th>Liquidación</th><th>Categoría</th><th>Concepto</th><th>Recurrencia</th><th>Importe</th></tr></thead><tbody>{concepts.map((row) => <tr key={`${row.settlementId}-${row.earningIndex}`}><td data-label="Período">{periodLabel(row.period)}</td><td data-label="Liquidación">{settlementTypeLabel(row.settlementType)}</td><td data-label="Categoría">{categoryLabels[row.category]}</td><td data-label="Concepto">{earningLabels[row.code] ?? 'Otro concepto'}</td><td data-label="Recurrencia">{row.isRecurring === true ? 'Recurrente' : row.isRecurring === false ? 'No recurrente' : 'N/D'}</td><td data-label="Importe"><MoneyValue value={row.amount} currency={scope.currencyCode} kind="salary" /></td></tr>)}</tbody></table></div>{conceptCursor && <div className="load-more"><button type="button" className="button secondary" disabled={conceptLoadingMore} onClick={() => void loadMoreConcepts()}>{conceptLoadingMore ? 'Cargando…' : 'Cargar más'}</button></div>}</> : scope ? <EmptyState title="Sin conceptos para esos filtros" body="Sólo se muestran conceptos ya normalizados por el servidor." /> : history && !loading ? <EmptyState title="Sin conceptos" body="Todavía no hay liquidaciones analizadas." /> : null}
      </section>}

      {tab === 'documents' && <section id="history-panel-documents" role="tabpanel" aria-labelledby="history-tab-documents" tabIndex={0}>
        <div className="document-kind" role="group" aria-label="Tipo de documento">{documentKinds.map(([value, label]) => <button type="button" aria-pressed={documentKind === value} className={documentKind === value ? 'active' : ''} onClick={() => selectDocumentKind(value)} key={value}>{label}</button>)}</div>
        <form className="document-filters" role="search" onSubmit={(event) => { event.preventDefault(); const year = documentYearDraft || 'all'; setDocumentSearch(documentSearchDraft.trim()); setDocumentYear(year); onLocationChange({ year }, true); }}><label>Buscar<input type="search" value={documentSearchDraft} maxLength={100} placeholder="Archivo, empresa, mes o tipo" onChange={(event) => setDocumentSearchDraft(event.target.value)} /></label><label>Año<input type="text" inputMode="numeric" pattern="20[0-9]{2}" maxLength={4} value={documentYearDraft} placeholder="Todos" title="Ingresá un año entre 2000 y 2099" onChange={(event) => setDocumentYearDraft(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label><label>Período<input type="month" value={documentPeriod} onChange={(event) => { setDocumentPeriod(event.target.value); onLocationChange({ period: event.target.value || null }, true); }} /></label>{documentKind !== 'UNSUPPORTED' && <label>Tipo de liquidación<select value={documentSettlementType} onChange={(event) => { setDocumentSettlementType(event.target.value); onLocationChange({ settlementType: event.target.value === 'all' ? null : event.target.value }, true); }}><option value="all">Todos</option>{settlementTypeOptions.map((value) => <option value={value} key={value}>{settlementTypeLabel(value)}</option>)}</select></label>}<label>Estado<select value={documentStatusGroup} onChange={(event) => { const status = event.target.value as (typeof documentStatusGroups)[number][0]; setDocumentStatusGroup(status); onLocationChange({ status }, true); }}>{documentStatusGroups.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button type="submit" className="button secondary compact">Buscar</button>{(documentSearch || documentYear !== 'all' || documentPeriod || documentSettlementType !== 'all' || documentStatusGroup !== 'ALL') && <button type="button" className="text-button" onClick={() => { setDocumentSearchDraft(''); setDocumentSearch(''); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentPeriod(''); setDocumentSettlementType('all'); setDocumentStatusGroup('ALL'); onLocationChange({ year: null, period: null, settlementType: null, status: 'ALL' }, true); }}>Limpiar filtros</button>}</form>
        {documentError && <p className="message error" role="alert">{documentError} <button type="button" className="text-button" disabled={documentsLoading} onClick={() => void reloadDocuments()}>{documentsLoading ? 'Reintentando…' : 'Reintentar'}</button></p>}
        {!documentsLoading && !documentError && <p className="document-count">{documentTotal} documento{documentTotal === 1 ? '' : 's'} · {documentPendingReview} para revisar · mostrando {documents.length}</p>}
        {documentPeriod && <p className="coverage-note">Documentos de {periodLabel(documentPeriod)}. Abrí uno para revisar sus conceptos y, si decidís mostrarlo, el PDF fuente.</p>}
        {documentKind === 'PAYROLL' && documents.length > 0 && <div className="bulk-association"><label><input type="checkbox" checked={allAssignableSelected} onChange={(event) => setCheckedDocumentIds(event.target.checked ? assignableDocuments.map(({ id }) => id) : [])} />Seleccionar todos</label><span>{checkedDocumentIds.length} seleccionado{checkedDocumentIds.length === 1 ? '' : 's'}</span><select aria-label="Empleo para asociar" value={employmentChoice} onChange={(event) => setEmploymentChoice(event.target.value)}><option value="">Elegí un empleo</option>{employments.map((employment) => <option key={employment.id} value={employment.id}>{employmentOptionLabel(employment)}</option>)}<option value="none">Quitar asociación</option></select><button type="button" className="button primary compact" disabled={!checkedDocumentIds.length || !employmentChoice || associating} onClick={() => void associateDocuments()}>{associating ? 'Guardando…' : 'Aplicar'}</button></div>}
        <div id="document-results">{documentError ? null : documentsLoading ? <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando documentos…</p></div> : documents.length ? <><div className="document-groups">{[...documentGroups.entries()].map(([year, items]) => <details className="document-year" open key={year}><summary><strong>{year}</strong><span>{items.length} documento{items.length === 1 ? '' : 's'}</span></summary><div className="document-list">{items.map(documentRow)}</div></details>)}</div>{documentCursor && <div className="load-more"><button type="button" className="button secondary" disabled={loadingMoreDocuments} onClick={() => void loadMoreDocuments()}>{loadingMoreDocuments ? 'Cargando…' : 'Cargar más'}</button></div>}</> : <EmptyState title="No encontramos documentos con estos filtros" body="Probá limpiar los filtros o importá un PDF nuevo." action={<button type="button" className="button secondary" onClick={() => { setDocumentSearchDraft(''); setDocumentSearch(''); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentPeriod(''); setDocumentSettlementType('all'); setDocumentStatusGroup('ALL'); onLocationChange({ year: null, period: null, settlementType: null, status: 'ALL' }, true); }}>Limpiar filtros</button>} />}</div>
      </section>}

      {selected && (!detail || detailError) && <div className="modal-layer" role="presentation" onMouseDown={closeDetailState}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="document-loading-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, closeDetailState)} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p className="eyebrow">Documento privado</p><h2 id="document-loading-title">{documentName(selected, privacyEnabled)}</h2></div><button className="icon-button" disabled={reviewBusy} onClick={closeDetailState} aria-label="Cerrar">×</button></div>{detailError ? <><p className="message error" role="alert">{detailError}</p><div className="modal-actions"><button type="button" className="button secondary" disabled={reviewBusy} onClick={closeDetailState}>Cerrar</button><button type="button" className="button primary" disabled={reviewBusy} onClick={() => setDetailReload((value) => value + 1)}>Reintentar</button></div></> : <p aria-live="polite">Cargando metadatos y datos extraídos…</p>}</section></div>}
      {selected && detail && !detailError && <DocumentReview
        key={selected.id}
        detail={detail}
        initialEvidenceId={locationSeed.evidenceId}
        initialPage={locationSeed.page}
        position={{ canNext: selectedDocumentIndex >= 0 && (selectedDocumentIndex < documents.length - 1 || Boolean(documentCursor)), current: selectedDocumentIndex < 0 ? null : selectedDocumentIndex + 1, total: Math.max(1, documentTotal) }}
        settlement={detail.reviewSettlement ?? undefined}
        source={preview?.documentId === selected.id && (!privacyEnabled || privacyPreviewDocumentId === selected.id) ? preview : null}
        sourceBusy={previewBusy}
        sourceError={previewError}
        navigationBusy={loadingMoreDocuments}
        navigationError={documentNavigationError}
        onAuthorizePreview={authorizePreview}
        onClose={closeDocument}
        onCompleteReview={completeReview}
        onConfirmType={confirmType}
        onDeleteDocument={deleteDocument}
        onDeleteOriginal={deleteOriginal}
        onBusyChange={setReviewBusy}
        onDirtyChange={setReviewDirty}
        onDownload={downloadOriginal}
        onLocationChange={updateDocumentLocation}
        onNavigate={navigateDocument}
        onReprocess={reprocessDocument}
        onRunDecision={decideProcessingRun}
        onSave={saveCorrections}
        onSaveUnsupportedFeedback={saveUnsupportedFeedback}
        processingRuns={processingRuns}
        runPreviewErrors={runPreviewErrors}
        runPreviews={runPreviews}
        runsError={runsError}
        runsLoading={runsLoading}
      />}
    </div>
  );
}

function MfaSettings({ onSessionsChanged, onUserChanged, runSensitive }: { onSessionsChanged: () => void; onUserChanged: (user: User) => void; runSensitive: RunSensitive }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, nextUser] = await Promise.all([api<MfaStatus>('/auth/mfa'), api<User>('/auth/me')]);
    setStatus(nextStatus);
    onUserChanged(nextUser);
  }, [onUserChanged]);
  const completeEnrollment = useCallback(async () => {
    await refresh();
    onSessionsChanged();
  }, [onSessionsChanged, refresh]);

  useEffect(() => {
    api<MfaStatus>('/auth/mfa').then(setStatus).catch((caught) => setError(caught instanceof Error ? caught.message : 'No pudimos consultar el segundo factor.'));
  }, []);

  async function regenerateRecoveryCodes() {
    if (!confirm('¿Generar códigos nuevos? Los códigos de recuperación anteriores dejarán de funcionar.')) return;
    setError(''); setMessage('');
    setBusy(true);
    try {
      await runSensitive(async () => {
        const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST', body: '{}' });
        setRecoveryCodes(result.recoveryCodes);
        setStatus((current) => current ? { ...current, recoveryCodesRemaining: result.recoveryCodes.length } : current);
        onSessionsChanged();
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos renovar los códigos.'); }
    finally { setBusy(false); }
  }

  async function disable() {
    if (!confirm('¿Desactivar el segundo factor? Tu cuenta quedará protegida sólo por tu acceso principal.')) return;
    setError(''); setMessage('');
    setBusy(true);
    try {
      await runSensitive(async () => {
        await api('/auth/mfa', { method: 'DELETE' });
        setRecoveryCodes(null);
        await refresh();
        onSessionsChanged();
        setMessage('Segundo factor desactivado.');
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos desactivar el segundo factor.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="settings-card setting-wide"><div className="setting-icon" aria-hidden="true">2</div><div><div className="setting-heading"><h2>Segundo factor</h2>{status && <span className={`status ${status.enabled ? 'ready' : 'pending'}`}>{status.enabled ? 'Activo' : 'Inactivo'}</span>}</div>
      {!status && !error && <p>Cargando estado…</p>}
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" onClick={() => { setError(''); void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'No pudimos consultar el segundo factor.')); }}>Reintentar</button></p>}
      {message && <p className="message success" aria-live="polite">{message}</p>}
      {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} /> : status?.enabled ? <>
        <p>Tu cuenta usa un segundo factor para nuevos inicios de sesión y acciones sensibles.</p>
        <dl className="security-details"><div><dt>Método</dt><dd>{status.method === 'TOTP' ? 'Aplicación autenticadora' : status.method || 'Aplicación autenticadora'}</dd></div><div><dt>Configurado</dt><dd>{timestampLabel(status.enabledAt)}</dd></div><div><dt>Códigos de recuperación</dt><dd>{status.recoveryCodesRemaining} disponible{status.recoveryCodesRemaining === 1 ? '' : 's'}</dd></div></dl>
        <p className="setting-note">Generar códigos nuevos invalida todos los anteriores. Desactivar esta protección reduce la seguridad de la cuenta. Ambas acciones vuelven a confirmar tu identidad.</p>
        <div className="setting-actions inline-actions"><button className="button secondary" disabled={busy} onClick={regenerateRecoveryCodes}>{busy ? 'Confirmando…' : 'Generar códigos nuevos'}</button><button className="button danger-button" disabled={busy} onClick={disable}>Desactivar segundo factor</button></div>
      </> : status ? <><p>Usá una app autenticadora compatible con códigos TOTP. Si no la activás, las acciones sensibles te pedirán volver a confirmar tu cuenta de Google.</p><MfaEnrollment pending={status.pendingEnrollment} onComplete={completeEnrollment} /></> : null}
    </div></section>
  );
}

function sessionDeviceLabel(session: AuthSession) {
  const device = ({ DESKTOP: 'Computadora', MOBILE: 'Teléfono', TABLET: 'Tablet' } as Record<string, string>)[session.deviceType];
  const browser = ({ CHROME: 'Chrome', EDGE: 'Edge', FIREFOX: 'Firefox', SAFARI: 'Safari' } as Record<string, string>)[session.browser];
  const operatingSystem = ({ ANDROID: 'Android', IOS: 'iOS', LINUX: 'Linux', MACOS: 'macOS', WINDOWS: 'Windows' } as Record<string, string>)[session.operatingSystem];
  const details = [device, browser, operatingSystem].filter(Boolean);
  return details.length ? details.join(' · ') : 'Dispositivo no identificado';
}

function SessionsSettings({ refreshKey, runSensitive }: { refreshKey: number; runSensitive: RunSensitive }) {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setSessions(await api<AuthSession[]>('/auth/sessions')); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cargar tus sesiones.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshKey]);

  async function revoke(session: AuthSession) {
    if (!confirm(`¿Finalizar la sesión de ${sessionDeviceLabel(session)}?`)) return;
    setBusyId(session.id); setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        const result = await api<{ revoked: boolean }>(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
        setSessions((current) => current.filter(({ id }) => id !== session.id));
        setMessage(result.revoked ? 'Sesión finalizada.' : 'Esa sesión ya no estaba activa.');
      });
    } catch (caught) {
      const nextError = caught instanceof Error ? caught.message : 'No pudimos finalizar la sesión.';
      await load();
      setError(nextError);
    } finally { setBusyId(null); }
  }

  async function revokeOthers() {
    if (!confirm('¿Cerrar todas las otras sesiones? Esta sesión seguirá activa.')) return;
    setBusyId('others'); setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        const result = await api<{ revokedSessions: number }>('/auth/sessions/revoke-others', { method: 'POST', body: '{}' });
        setSessions((current) => current.filter(({ current: isCurrent }) => isCurrent));
        setMessage(result.revokedSessions ? `Cerramos ${result.revokedSessions} ${result.revokedSessions === 1 ? 'sesión' : 'sesiones'}.` : 'No había otras sesiones activas.');
      });
    } catch (caught) {
      const nextError = caught instanceof Error ? caught.message : 'No pudimos cerrar las otras sesiones.';
      await load();
      setError(nextError);
    } finally { setBusyId(null); }
  }

  const ordered = [...sessions].sort((left, right) => Number(right.current) - Number(left.current));
  const others = sessions.filter(({ current }) => !current);
  return <section className="settings-card setting-wide sessions-card"><div className="setting-icon" aria-hidden="true">↪</div><div><div className="setting-heading"><h2>Sesiones activas</h2>{!loading && <span className="status">{sessions.length}</span>}</div><p>Revisá en qué navegadores y dispositivos está abierta tu cuenta. No usamos ubicación ni fingerprinting para identificarlos.</p>
    {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>Reintentar</button></p>}
    {message && <p className="message success" aria-live="polite">{message}</p>}
    {loading ? <div className="compact-loading" role="status"><div className="loader" aria-hidden="true" /><span>Cargando sesiones…</span></div> : <div className="session-list">{ordered.map((session) => <article className="session-row" key={session.id}><div className="session-main"><div className="session-title"><strong>{sessionDeviceLabel(session)}</strong>{session.current && <span className="status ready">Esta sesión</span>}</div><dl><div><dt>Iniciada</dt><dd>{timestampLabel(session.createdAt)}</dd></div><div><dt>Última actividad</dt><dd>{timestampLabel(session.lastSeenAt)}</dd></div><div><dt>Vence</dt><dd>{timestampLabel(session.expiresAt)}</dd></div></dl></div>{!session.current && <button type="button" className="button secondary" disabled={busyId !== null} onClick={() => void revoke(session)}>{busyId === session.id ? 'Finalizando…' : 'Finalizar sesión'}</button>}</article>)}{!others.length && <p className="session-empty">No tenés otras sesiones activas.</p>}</div>}
    {!loading && others.length > 0 && <div className="session-footer"><button type="button" className="button secondary" disabled={busyId !== null} onClick={() => void revokeOthers()}>{busyId === 'others' ? 'Cerrando…' : 'Cerrar las otras sesiones'}</button></div>}
  </div></section>;
}

const exportStatusLabels: Record<string, string> = {
  PENDING: 'Solicitada', RUNNING: 'Descargando', READY: 'Disponible', COMPLETED: 'Descargada',
  FAILED: 'No se pudo descargar', CANCELLED: 'Cancelada', EXPIRED: 'Vencida',
};

function PrivacySettings({ runSensitive }: { runSensitive: RunSensitive }) {
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function requestExport() {
    setBusy(true); setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        const next = await api<ExportJob>('/privacy/exports', { method: 'POST', body: '{}' });
        setExportJob(next);
        setMessage(next.status === 'READY' ? 'Tu exportación está disponible.' : 'Solicitamos tu exportación.');
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la exportación.'); }
    finally { setBusy(false); }
  }
  async function refreshExport() {
    if (!exportJob) return;
    setBusy(true); setError('');
    try { setExportJob(await api<ExportJob>(`/privacy/exports/${exportJob.id}`)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos consultar la exportación.'); }
    finally { setBusy(false); }
  }
  async function downloadExport() {
    if (!exportJob?.downloadUrl) return;
    setBusy(true); setError('');
    try {
      await runSensitive(() => downloadApiFile(exportJob.downloadUrl!, 'salarivo-export.json'));
      setExportJob(await api<ExportJob>(`/privacy/exports/${exportJob.id}`));
    }
    catch (caught) {
      const nextError = caught instanceof Error ? caught.message : 'No pudimos descargar la exportación.';
      try { setExportJob(await api<ExportJob>(`/privacy/exports/${exportJob.id}`)); }
      catch { /* Keep the actionable download error when the status refresh also fails. */ }
      setError(nextError);
    }
    finally { setBusy(false); }
  }

  const canRefresh = exportJob && ['PENDING', 'RUNNING', 'READY'].includes(exportJob.status);
  const canRequestAgain = !exportJob || ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(exportJob.status);
  const completedLabel = exportJob?.status === 'COMPLETED' ? 'Descarga completada'
    : exportJob?.status === 'FAILED' ? 'Finalizada con error'
      : exportJob?.status === 'CANCELLED' ? 'Cancelada'
        : exportJob?.status === 'EXPIRED' ? 'Marcada como vencida'
          : null;
  const expiryLabel = exportJob?.status === 'READY' ? 'Disponible hasta'
    : exportJob && ['PENDING', 'RUNNING'].includes(exportJob.status) ? 'Vence'
      : exportJob?.status === 'EXPIRED' ? 'Venció'
        : null;
  return <>
    {error && <p className="message error" role="alert">{error}</p>}{message && <p className="message success" aria-live="polite">{message}</p>}
    <section className="settings-card setting-wide"><div className="setting-icon" aria-hidden="true">⇩</div><div><div className="setting-heading"><h2>Exportar mis datos</h2>{exportJob && <span className={`status ${exportJob.status === 'READY' || exportJob.status === 'COMPLETED' ? 'ready' : ['FAILED', 'CANCELLED', 'EXPIRED'].includes(exportJob.status) ? 'danger' : 'pending'}`}>{exportStatusLabels[exportJob.status] ?? 'Estado desconocido'}</span>}</div><p>Generá un JSON legible con tu cuenta, métodos de acceso, empleos, importaciones, metadatos de documentos, liquidaciones, conceptos, correcciones, sesiones y solicitudes de privacidad. No incluye PDFs originales, IDs internos, datos técnicos de procesamiento, secretos ni credenciales.</p>{exportJob && <dl className="export-details"><div><dt>Solicitada</dt><dd>{timestampLabel(exportJob.createdAt)}</dd></div>{exportJob.startedAt && <div><dt>Descarga iniciada</dt><dd>{timestampLabel(exportJob.startedAt)}</dd></div>}{exportJob.completedAt && completedLabel && <div><dt>{completedLabel}</dt><dd>{timestampLabel(exportJob.completedAt)}</dd></div>}{exportJob.expiresAt && expiryLabel && <div><dt>{expiryLabel}</dt><dd>{timestampLabel(exportJob.expiresAt)}</dd></div>}</dl>}<div className="setting-actions inline-actions">{exportJob?.status === 'READY' && exportJob.downloadUrl && <button type="button" className="button primary" disabled={busy} onClick={() => void downloadExport()}>{busy ? 'Preparando…' : 'Descargar exportación'}</button>}{canRefresh && <button type="button" className="button secondary" disabled={busy} onClick={() => void refreshExport()}>{busy ? 'Actualizando…' : 'Actualizar estado'}</button>}{canRequestAgain && <button type="button" className="button secondary" disabled={busy} onClick={() => void requestExport()}>{busy ? 'Solicitando…' : exportJob ? 'Solicitar una nueva' : 'Solicitar exportación'}</button>}</div></div></section>
    <section className="settings-card setting-wide"><div className="setting-icon" aria-hidden="true">◇</div><div><h2>Originales y datos estructurados</h2><p>El PDF original y los datos de la liquidación tienen ciclos separados.</p><div className="data-lifecycle"><article><strong>Eliminar sólo el PDF</strong><p>El archivo deja de estar disponible para ver, descargar o reprocesar. Conservás los datos estructurados y las correcciones que ya revisaste.</p></article><article><strong>Eliminar PDF y datos</strong><p>Se eliminan también la extracción, la liquidación, sus conceptos y correcciones. Ambas opciones están en el detalle del documento, dentro de Historial.</p></article></div></div></section>
    <section className="settings-card setting-wide"><div className="setting-icon" aria-hidden="true">§</div><div><h2>Documentos legales</h2><p>Consultá la versión vigente de los <a className="inline-link" href="/terms" target="_blank" rel="noreferrer">Términos de uso</a> y el <a className="inline-link" href="/privacy" target="_blank" rel="noreferrer">Aviso de privacidad</a>.</p></div></section>
  </>;
}

function AccountSettings({ user, runSensitive, onDeletionRequested }: {
  user: User;
  runSensitive: RunSensitive;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = dialog.current;
    if (current && !current.open) current.showModal();
    return () => { if (current?.open) current.close(); };
  }, [open]);

  function showDialog(trigger: HTMLButtonElement) {
    opener.current = trigger; setConfirmation(''); setError(''); setOpen(true);
  }
  function closeDialog() {
    if (busy) return;
    setOpen(false);
    window.requestAnimationFrame(() => opener.current?.focus());
  }
  async function deleteAccount() {
    if (confirmation !== 'ELIMINAR') return;
    setError(''); setBusy(true);
    const receiptToken = browserOpaqueToken();
    try {
      await runSensitive(async () => {
        try {
          await api('/privacy/account', {
            method: 'DELETE', body: JSON.stringify({ confirmation, receiptToken }),
          });
          onDeletionRequested(receiptToken, 'accepted');
        } catch (caught) {
          if (caught instanceof ApiError && caught.code === 'STEP_UP_REQUIRED') {
            if (dialog.current?.open) dialog.current.close();
            setOpen(false);
            throw caught;
          }
          if (!(caught instanceof ApiError) || caught.status >= 500) onDeletionRequested(receiptToken, 'ambiguous');
          else throw caught;
        }
      });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos solicitar la baja.'); }
    finally { setBusy(false); }
  }

  if (user.role === 'ADMIN') return <section className="settings-card setting-wide"><div className="setting-icon" aria-hidden="true">!</div><div><h2>Baja de una cuenta administrativa</h2><p>Para preservar el último acceso de gobierno, otra persona con permiso debe retirar primero tu rol administrativo. Después podés solicitar la eliminación como usuario.</p></div></section>;
  return <>
    <section className="danger-zone"><div><p className="eyebrow">Zona de peligro</p><h2>Eliminar cuenta</h2><p>Inicia el borrado irreversible de tu cuenta, documentos, liquidaciones, sesiones y datos asociados.</p><strong>Esta acción no se puede deshacer.</strong></div><button type="button" className="button danger-button" onClick={(event) => showDialog(event.currentTarget)}>Eliminar cuenta</button></section>
    {open && <dialog ref={dialog} className="modal-layer" aria-labelledby="delete-account-title" aria-describedby="delete-account-description" onCancel={(event) => { event.preventDefault(); if (!busy) closeDialog(); }} onKeyDown={(event) => { if (!busy) handleDialogKey(event, closeDialog); }} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}><section className="modal danger-dialog"><div className="modal-head"><div><p className="eyebrow">Acción irreversible</p><h2 id="delete-account-title">Eliminar tu cuenta</h2></div><button type="button" className="icon-button" disabled={busy} onClick={closeDialog} aria-label="Cerrar">×</button></div><div id="delete-account-description"><p>Se iniciará el borrado de:</p><ul><li>documentos originales y archivos temporales;</li><li>información estructurada, liquidaciones y correcciones;</li><li>empleos e importaciones;</li><li>sesiones, segundo factor y acceso vinculado con Google;</li><li>exportaciones y configuración de la cuenta.</li></ul><p>La solicitud es irreversible. El borrado puede quedar pendiente mientras terminan cargas o procesos activos; recibirás una constancia para consultar su estado.</p></div><label className="delete-confirmation" htmlFor="delete-account-confirmation">Escribí <strong>ELIMINAR</strong> para continuar<input id="delete-account-confirmation" value={confirmation} autoComplete="off" disabled={busy} autoFocus onChange={(event) => setConfirmation(event.target.value)} /></label>{error && <p className="message error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={closeDialog}>Cancelar</button><button type="button" className="button danger-button" disabled={busy || confirmation !== 'ELIMINAR'} onClick={() => void deleteAccount()}>{busy ? 'Solicitando eliminación…' : 'Eliminar mi cuenta'}</button></div></section></dialog>}
  </>;
}

const settingsTabs = [
  ['security', 'Seguridad'],
  ['privacy', 'Privacidad y datos'],
  ['account', 'Cuenta'],
] as const;
type SettingsTab = (typeof settingsTabs)[number][0];

function Settings({ user, onUserChanged, runSensitive, onDeletionRequested }: {
  user: User;
  onUserChanged: (user: User) => void;
  runSensitive: RunSensitive;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [tab, setTab] = useState<SettingsTab>('security');
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = settingsTabs.length - 1;
    const nextIndex = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = settingsTabs[nextIndex]![0];
    setTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  }
  return <div className="page narrow-page settings-page"><PageHeader eyebrow="Tu cuenta" title="Configuración" /><div className="tabs settings-tabs" role="tablist" aria-label="Secciones de configuración">{settingsTabs.map(([value, label], index) => <button type="button" id={`settings-tab-${value}`} role="tab" aria-controls={`settings-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={tab === value ? 'active' : ''} onKeyDown={(event) => moveTab(event, index)} onClick={() => setTab(value)} key={value}>{label}</button>)}</div>
    <section id="settings-panel-security" role="tabpanel" aria-labelledby="settings-tab-security" tabIndex={0} hidden={tab !== 'security'}><MfaSettings key={String(user.mfaEnabled)} onSessionsChanged={() => setSessionsRefreshKey((value) => value + 1)} onUserChanged={onUserChanged} runSensitive={runSensitive} /><SessionsSettings refreshKey={sessionsRefreshKey} runSensitive={runSensitive} /></section>
    <section id="settings-panel-privacy" role="tabpanel" aria-labelledby="settings-tab-privacy" tabIndex={0} hidden={tab !== 'privacy'}><PrivacySettings runSensitive={runSensitive} /></section>
    <section id="settings-panel-account" role="tabpanel" aria-labelledby="settings-tab-account" tabIndex={0} hidden={tab !== 'account'}><AccountSettings user={user} runSensitive={runSensitive} onDeletionRequested={onDeletionRequested} /></section>
  </div>;
}
