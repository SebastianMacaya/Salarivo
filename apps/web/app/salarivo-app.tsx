'use client';

import { FormEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { DocumentReview, type DocumentDetail, type ExtractedFieldDetail } from './document-review';
import { readDocumentLocation, writeDocumentLocation } from './document-evidence';
import {
  money,
  percentage,
  periodLabel,
  recentPeriodRange,
  salaryCategories,
  settlementTypeLabel,
  type SalaryCategory,
} from './format';
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
  authMethods: 'GOOGLE'[];
};
type MfaStatus = { enabled: boolean; pendingEnrollment: boolean; recoveryCodesRemaining: number };
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
  currencyCode: string;
};
type EmploymentDetection = {
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
  errorCode?: string | null;
};
type SalaryAmounts = {
  basicAmount: string | null;
  grossAmount: string | null;
  netAmount: string | null;
  deductionsAmount: string | null;
  remunerativeAmount: string | null;
  nonRemunerativeAmount: string | null;
};
type MoneyChange = { fromAmount: string; toAmount: string; deltaAmount: string; percentage: string | null };
type SalaryChange = MoneyChange & { fromPeriod: string; toPeriod: string };
type MonthlyEvolution = {
  period: string;
  totals: SalaryAmounts;
  regular: SalaryAmounts;
  comparableSalary: string | null;
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
  currencyCode: string;
  employmentStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  firstPeriod: string | null;
  lastPeriod: string | null;
};
type SalaryHistory = {
  calculationVersion: string;
  contexts: SalaryContext[];
  coverage: { documents: number; activeEmployments: number; completedDocuments: number; needsReviewDocuments: number; pendingReviewDocuments: number; unassociatedDocuments: number; analyzedSettlements: number };
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
    throw new ApiError(message, response.status, code);
  }
  return (Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body) as T;
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
    throw new ApiError(body.error?.message ?? 'No pudimos descargar la exportación.', response.status, body.error?.code ?? 'REQUEST_FAILED');
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function shortDate(value?: string | null) {
  if (!value) return 'Actualidad';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(
    new Date(`${value.slice(0, 10)}T12:00:00`),
  );
}

function apiUrl(path: string) {
  return path.startsWith('/api/v1/') ? `${API_ROOT}${path.slice('/api/v1'.length)}` : path;
}

function browserOpaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function documentName(document: DocumentItem) {
  return document.displayFilename || document.originalFilename;
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

const statusLabels: Record<string, string> = {
  UPLOADED: 'Recibido',
  SECURITY_VALIDATION: 'Validando seguridad',
  DOCUMENT_CLASSIFICATION: 'Clasificando',
  TEXT_EXTRACTION: 'Extrayendo texto',
  OCR: 'Leyendo imagen',
  PARSING: 'Interpretando',
  NORMALIZATION: 'Normalizando',
  VALIDATION: 'Validando datos',
  PROCESSING: 'Procesando',
  NEEDS_REVIEW: 'Requiere revisión',
  NEEDS_TYPE_CONFIRMATION: 'Confirmar tipo',
  COMPLETED: 'Listo',
  DUPLICATE: 'Duplicado',
  QUARANTINED: 'En cuarentena',
  FAILED_RETRYABLE: 'Reintentando',
  FAILED_PERMANENT: 'No procesado',
  REJECTED_UNSUPPORTED: 'Tipo no soportado',
  RETRY_SCHEDULED: 'Reintento programado',
  CANCELLED: 'Cancelado',
  DELETED: 'Eliminado',
};
const associationReadyStatuses = new Set([
  'COMPLETED', 'NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION', 'REJECTED_UNSUPPORTED',
  'QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED',
]);
const processingDocumentPattern = /UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION/;
const historyTabs = [
  ['summary', 'Resumen'],
  ['evolution', 'Evolución'],
  ['annual', 'Por año'],
  ['concepts', 'Conceptos'],
  ['documents', 'Documentos'],
] as const;
const documentFilterStatuses = [
  ['COMPLETED', 'Listos'],
  ['NEEDS_REVIEW', 'Requieren revisión'],
  ['NEEDS_TYPE_CONFIRMATION', 'Requieren confirmar tipo'],
  ['REJECTED_UNSUPPORTED', 'No soportados'],
  ['FAILED_PERMANENT', 'Con error'],
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
  if (!user.onboardingCompleted) {
    return <OnboardingScreen user={user} onComplete={setUser} onLogout={() => setUser(null)} />;
  }
  return <PrivateApp
    user={user}
    authNotice={authNotice}
    onAuthNoticeDismiss={() => setAuthNotice('')}
    onUserChanged={setUser}
    onLogout={() => setUser(null)}
    onDeletionRequested={(token, source) => { setDeletionReceiptEntry({ token, source }); setUser(null); }}
  />;
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
        <p className={receipt?.status === 'COMPLETED' ? 'message success' : 'message'}>Estado: <strong>{receipt ? receipt.status === 'COMPLETED' ? 'Completado' : 'Pendiente' : 'Sin confirmar'}</strong>{receipt?.completedAt ? ` · ${shortDate(receipt.completedAt)}` : ''}</p>
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
        <p><small>La configuración vence el {new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(enrollment.expiresAt))}.</small></p>
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
    Promise.all([api<LegalSummary>('/legal/terms'), api<LegalSummary>('/legal/privacy')])
      .then(([terms, privacy]) => setLegalVersions({ terms: terms.version, privacy: privacy.version }))
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
          const [terms, privacy] = await Promise.all([api<LegalSummary>('/legal/terms'), api<LegalSummary>('/legal/privacy')]);
          setLegalVersions({ terms: terms.version, privacy: privacy.version });
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
          <h2 id="access-title">{mode === 'google-register' ? 'Completá tu registro' : mode === 'deletion' ? 'Consultá una eliminación' : 'Ingresá a Salarivo'}</h2>
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
          <div className="access-actions">
            {mode === 'login' ? <button className="text-button" onClick={() => changeMode('deletion')}>Consultar una eliminación</button> : <button className="text-button" onClick={() => changeMode('login')}>Volver al ingreso</button>}
          </div>
        </div>
      </section>
    </main>
  );
}

type Section = 'summary' | 'jobs' | 'import' | 'history' | 'privacy';
const sections: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'summary', label: 'Resumen', icon: '⌂' },
  { id: 'jobs', label: 'Empleos', icon: '▣' },
  { id: 'import', label: 'Importar', icon: '↑' },
  { id: 'history', label: 'Historial', icon: '≋' },
  { id: 'privacy', label: 'Privacidad', icon: '◇' },
];

function PrivateApp({ user, authNotice, onAuthNoticeDismiss, onUserChanged, onLogout, onDeletionRequested }: {
  user: User;
  authNotice: string;
  onAuthNoticeDismiss: () => void;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [section, setSection] = useState<Section>('summary');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const stepUpGate = useRef<StepUpGate | null>(null);
  const stepUpReturnFocus = useRef<HTMLElement | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const visibleSections = sections;

  useEffect(() => {
    if (!readDocumentLocation(window.location.search)) return;
    const timer = window.setTimeout(() => setSection('history'));
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!importBusy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [importBusy]);

  const runSensitive = useCallback<RunSensitive>(async (action) => {
    const callerFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (;;) {
      try { await action(); return; }
      catch (caught) {
        if (!(caught instanceof ApiError) || caught.code !== 'STEP_UP_REQUIRED') throw caught;
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        if (!stepUpGate.current) {
          stepUpReturnFocus.current = callerFocus;
          stepUpGate.current = createStepUpGate();
          setStepUpOpen(true);
        }
        if (!await stepUpGate.current.promise) return;
      }
    }
  }, []);

  const finishStepUp = useCallback((approved: boolean) => {
    const gate = stepUpGate.current;
    stepUpGate.current = null;
    setStepUpOpen(false);
    gate?.complete(approved);
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
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} inert={stepUpOpen ? true : undefined} aria-hidden={stepUpOpen || undefined}>
        <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú">×</button></div>
        <nav aria-label="Navegación principal">
          {visibleSections.map((item) => <button key={item.id} className={section === item.id ? 'nav-item active' : 'nav-item'} disabled={importBusy} onClick={() => { setSection(item.id); setMenuOpen(false); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
          {user.role === 'ADMIN' && <Link className="nav-item" href="/admin" aria-disabled={importBusy} tabIndex={importBusy ? -1 : undefined} onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (importBusy) event.preventDefault(); }}><span aria-hidden="true">⚙</span>Administración</Link>}
        </nav>
        {logoutError && <p className="message error" role="alert">{logoutError}</p>}
        <div className="sidebar-user">
          <span className="avatar">{(user.displayName || user.email).slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.displayName || 'Mi cuenta'}</strong><small>{user.email}</small></span>
          <button className="icon-button" disabled={logoutBusy || importBusy} onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">{logoutBusy ? '…' : '↪'}</button>
        </div>
      </aside>
      {menuOpen && <button className="backdrop" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} />}
      <main className="content" inert={stepUpOpen ? true : undefined} aria-hidden={stepUpOpen || undefined}>
        <header className="mobile-header"><button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menú">☰</button><Brand /></header>
        {authNotice && <p className="message success" aria-live="polite">{authNotice} <button type="button" className="text-button" onClick={onAuthNoticeDismiss}>Cerrar</button></p>}
        {section === 'summary' && <Summary key={refreshKey} user={user} onNavigate={setSection} />}
        {section === 'jobs' && <Employments key={refreshKey} onChanged={() => setRefreshKey((n) => n + 1)} runSensitive={runSensitive} />}
        {section === 'import' && <Importer onBusyChange={setImportBusy} onDone={() => setRefreshKey((n) => n + 1)} />}
        {section === 'history' && <History key={refreshKey} runSensitive={runSensitive} />}
        {section === 'privacy' && <Privacy user={user} onUserChanged={onUserChanged} runSensitive={runSensitive} onDeletionRequested={onDeletionRequested} />}
      </main>
      {stepUpOpen && <StepUpDialog
        mfaEnabled={Boolean(user.mfaEnabled)}
        onClose={() => finishStepUp(false)}
        onComplete={() => finishStepUp(true)}
        returnFocus={stepUpReturnFocus.current}
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

function salaryMoney(value: string | null | undefined, currency: string) {
  return value === null || value === undefined ? 'N/D' : money(value, currency);
}

function salaryPercentage(value: string | null | undefined) {
  return value === null || value === undefined ? 'N/D' : percentage(value);
}

function deductionOrCredit(value: string | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'N/D';
  return value.startsWith('-') ? `Crédito ${money(value.slice(1), currency)}` : money(value, currency);
}

function salaryContextName(context: SalaryContext) {
  return context.employerName || 'Empleo sin confirmar';
}

function salaryScopeKey(context: SalaryContext) {
  return JSON.stringify([context.employmentContext, context.currencyCode]);
}

function retainedSalaryScopeKey(current: string, history: SalaryHistory) {
  return history.contexts.some((context) => salaryScopeKey(context) === current)
    ? current
    : history.contexts[0] ? salaryScopeKey(history.contexts[0]) : '';
}

function SalaryScopeControl({ history, selectedKey, onChange, id }: {
  history: SalaryHistory;
  selectedKey: string;
  onChange: (key: string) => void;
  id: string;
}) {
  const context = history.contexts.find((item) => salaryScopeKey(item) === selectedKey) ?? history.contexts[0];
  if (!context) return null;
  const status = context.state === 'CONFIRMED' ? 'Confirmado' : context.state === 'DETECTED' ? 'Detectado' : 'Sin confirmar';
  const range = context.firstPeriod && context.lastPeriod
    ? `${periodLabel(context.firstPeriod)} a ${periodLabel(context.lastPeriod)}`
    : 'Período no disponible';
  return <section className="scope-control" aria-label="Contexto salarial">
    <div><label htmlFor={id}>Empleo y moneda</label>{history.contexts.length > 1
      ? <select id={id} value={salaryScopeKey(context)} onChange={(event) => onChange(event.target.value)}>{history.contexts.map((item) => <option value={salaryScopeKey(item)} key={salaryScopeKey(item)}>{salaryContextName(item)} · {item.currencyCode}</option>)}</select>
      : <strong>{salaryContextName(context)} · {context.currencyCode}</strong>}</div>
    <div className="scope-meta"><span className={`status ${context.state === 'CONFIRMED' ? 'ready' : 'pending'}`}>{status}</span><span>{range}</span></div>
  </section>;
}

function SalaryContextNotice({ context }: { context: SalaryContext }) {
  if (context.state === 'CONFIRMED') return null;
  return <p className="message warning" role="status">{context.state === 'DETECTED'
    ? 'Este análisis corresponde a una empresa detectada en recibos todavía sin asociar. Confirmá el empleo para consolidar su historial.'
    : 'Este análisis contiene recibos sin empresa confirmada. No se compara con otros contextos hasta que los asocies.'}</p>;
}

function SalaryMetricGrid({ scope, context }: { scope: SalaryScopeAnalytics; context: SalaryContext }) {
  const current = scope.current;
  const currentYear = current?.period.slice(0, 4) ?? scope.annual[0]?.year;
  const annual = scope.annual.find((item) => item.year === currentYear) ?? null;
  const latest = current?.changes.latest ?? null;
  const ytd = current?.changes.ytd ?? null;
  const coverage = scope.coverage;
  const coverageKnown = coverage && coverage.basis !== 'INDETERMINATE_CONTEXT';
  return <section className="metric-grid salary-metrics" aria-label="Indicadores salariales">
    <article className="metric accent"><small>Básico comparable</small><strong>{salaryMoney(current?.comparableSalary, context.currencyCode)}</strong><span>{current ? periodLabel(current.period) : 'Sin período comparable'}</span></article>
    <article className="metric"><small>Neto actual</small><strong>{salaryMoney(current?.amounts.netAmount, context.currencyCode)}</strong><span>{current ? `${periodLabel(current.period)} · sueldo regular` : 'N/D'}</span></article>
    <article className="metric"><small>Última variación</small><strong>{salaryPercentage(latest?.percentage)}</strong><span>{latest ? `${periodLabel(latest.fromPeriod)} → ${periodLabel(latest.toPeriod)}` : 'Sin dos períodos comparables'}</span></article>
    <article className="metric"><small>Variación en el año</small><strong>{salaryPercentage(ytd?.percentage)}</strong><span>{ytd ? `Desde ${periodLabel(ytd.fromPeriod)}` : 'Sin base comparable en el año'}</span></article>
    <article className="metric"><small>{annual ? `Cobrado en ${annual.year}` : 'Total anual'}</small><strong>{salaryMoney(annual?.totals.netAmount, context.currencyCode)}</strong><span>{annual ? `${annual.periodCount} período${annual.periodCount === 1 ? '' : 's'} · ${annual.settlementCount} ${annual.settlementCount === 1 ? 'liquidación' : 'liquidaciones'}` : 'N/D'}</span></article>
    <article className="metric"><small>Cobertura</small><strong>{coverageKnown ? `${coverage.availablePeriods.length}/${coverage.expectedPeriods.length}` : 'N/D'}</strong><span>{coverageKnown ? coverage.boundaryContradiction ? 'Límites laborales contradictorios' : coverage.possibleMissingPeriods.length ? `${coverage.possibleMissingPeriods.length} posible${coverage.possibleMissingPeriods.length === 1 ? '' : 's'} faltante${coverage.possibleMissingPeriods.length === 1 ? '' : 's'}` : coverage.basis === 'OBSERVED' ? 'Rango basado en períodos observados' : 'Sin faltantes posibles en el rango' : 'No se puede determinar sin un contexto laboral'}</span></article>
  </section>;
}

function SalaryEvolution({ scope, year = 'all', limit }: { scope: SalaryScopeAnalytics; year?: string; limit?: number }) {
  const filtered = year === 'all' ? scope.evolution : scope.evolution.filter((point) => point.period.startsWith(`${year}-`));
  const points = recentPeriodRange(filtered, limit);
  if (!points.length) return <EmptyState title="Sin evolución para mostrar" body="Elegí otro año o importá recibos con datos comparables." />;
  const visualStep = Math.max(1, Math.ceil(points.length / 60));
  const chartPoints = points.filter((_, index) => index % visualStep === 0 || index === points.length - 1);
  const visualValues = chartPoints.flatMap((point) => [point.comparableSalary, point.totals.netAmount])
    .flatMap((value) => value === null ? [] : [Number(value)])
    .filter((value) => Number.isFinite(value) && value > 0);
  const visualMaximum = Math.max(1, ...visualValues);
  const visualHeight = (value: string) => `${Math.max(2, (Number(value) / visualMaximum) * 100)}%`;
  const currency = scope.currencyCode;
  const exactTable = <div className="table-wrap salary-evolution-table" role="region" aria-label="Tabla desplazable de evolución salarial" tabIndex={0}><table><caption className="sr-only">Valores exactos de la evolución salarial</caption><thead><tr><th>Período</th><th>Básico comparable</th><th>Bruto total</th><th>Neto total</th><th>Descuentos / créditos</th></tr></thead><tbody>{points.map((point) => <tr key={point.period}><td>{periodLabel(point.period)}</td><td>{salaryMoney(point.comparableSalary, currency)}</td><td>{salaryMoney(point.totals.grossAmount, currency)}</td><td>{salaryMoney(point.totals.netAmount, currency)}</td><td>{deductionOrCredit(point.totals.deductionsAmount, currency)}</td></tr>)}</tbody></table></div>;
  return <div className="salary-evolution">
    <div className="legend"><span className="comparable">Básico comparable</span><span className="net">Neto total</span></div>
    <div className="bar-chart salary-chart" role="img" aria-label="Gráfico de básico comparable y neto por período">{chartPoints.map((point) => <div className="bar-group" key={point.period} title={`${periodLabel(point.period)}: básico comparable ${salaryMoney(point.comparableSalary, currency)}, neto ${salaryMoney(point.totals.netAmount, currency)}`}><div className="bars">{point.comparableSalary !== null && <i className="bar comparable" style={{ height: visualHeight(point.comparableSalary) }} />}{point.totals.netAmount !== null && <i className="bar net" style={{ height: visualHeight(point.totals.netAmount) }} />}</div><small>{periodLabel(point.period)}</small></div>)}</div>
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

function ComparisonResult({ comparison }: { comparison: PeriodComparison }) {
  const currency = comparison.currencyCode;
  return <div className="comparison-result" aria-live="polite">
    <p className="comparison-conclusion">{comparison.conclusionCode ? comparisonConclusionLabels[comparison.conclusionCode] : 'Comparación calculada con los importes disponibles.'}</p>
    <div className="table-wrap" role="region" aria-label="Tabla desplazable de comparación de períodos" tabIndex={0}><table><caption className="sr-only">Comparación exacta de períodos</caption><thead><tr><th>Importe</th><th>{periodLabel(comparison.fromPeriod)}</th><th>{periodLabel(comparison.toPeriod)}</th><th>Diferencia</th><th>Variación</th></tr></thead><tbody>{comparisonAmountLabels.map(([key, label]) => {
      const change = comparison.changes[key];
      const renderAmount = key === 'deductionsAmount' ? deductionOrCredit : salaryMoney;
      return <tr key={key}><th scope="row">{label}</th><td>{change ? renderAmount(change.fromAmount, currency) : 'N/D'}</td><td>{change ? renderAmount(change.toAmount, currency) : 'N/D'}</td><td>{change ? salaryMoney(change.deltaAmount, currency) : 'N/D'}</td><td>{salaryPercentage(change?.percentage)}</td></tr>;
    })}</tbody></table></div>
    {comparison.drivers && comparison.drivers.length > 0 && <div className="comparison-drivers"><h4>Qué cambió</h4><ul>{comparison.drivers.map((driver) => <li key={`${driver.type}-${driver.code}`}><span>{driver.type === 'DEDUCTIONS' ? 'Descuentos / créditos' : categoryLabels[driver.category as SalaryCategory] ?? earningLabels[driver.code] ?? 'Ingreso extraordinario'}</span><strong>{salaryMoney(driver.change.deltaAmount, currency)}</strong></li>)}</ul></div>}
    {comparison.driversComplete === false && <p className="coverage-note">Explicación parcial: algún recibo no tiene todos sus conceptos normalizados.</p>}
    {comparison.earnings && comparison.earnings.length > 0 && <details><summary>Ver conceptos normalizados</summary><div className="table-wrap" role="region" aria-label="Tabla desplazable de conceptos comparados" tabIndex={0}><table><thead><tr><th>Concepto</th><th>Antes</th><th>Después</th><th>Diferencia</th></tr></thead><tbody>{comparison.earnings.map(({ code, change }) => <tr key={code}><td>{earningLabels[code] ?? 'Otro concepto'}</td><td>{salaryMoney(change.fromAmount, currency)}</td><td>{salaryMoney(change.toAmount, currency)}</td><td>{salaryMoney(change.deltaAmount, currency)}</td></tr>)}</tbody></table></div></details>}
  </div>;
}

function AnnualHistory({ rows, scope, category }: { rows: AnnualSalarySummary[]; scope: SalaryScopeAnalytics; category: 'all' | SalaryCategory }) {
  if (!rows.length) return <EmptyState title="Sin datos para ese año" body="Elegí otro año o importá recibos de ese período." />;
  const categories = category === 'all' ? salaryCategories : [category];
  return <div className="annual-list">{rows.map((annual) => {
    const yearCoverage = scope.coverage?.byYear.find((item) => item.year === annual.year);
    return <details className="panel annual-card" key={annual.year}><summary><span><strong>{annual.year}</strong><small>{annual.periodCount} período{annual.periodCount === 1 ? '' : 's'} · {annual.documentCount} documento{annual.documentCount === 1 ? '' : 's'}</small></span><strong>{salaryMoney(annual.totals.netAmount, scope.currencyCode)}</strong></summary><div className="annual-body">
      <dl className="annual-kpis"><div><dt>Neto total</dt><dd>{salaryMoney(annual.totals.netAmount, scope.currencyCode)}</dd></div><div><dt>Neto promedio</dt><dd>{salaryMoney(annual.averages.netAmount, scope.currencyCode)}</dd></div><div><dt>Bruto total</dt><dd>{salaryMoney(annual.totals.grossAmount, scope.currencyCode)}</dd></div><div><dt>Cambio comparable</dt><dd>{salaryPercentage(annual.comparableChange?.percentage)}</dd></div></dl>
      {yearCoverage && <p className="coverage-note">Cobertura {yearCoverage.availablePeriods.length}/{yearCoverage.expectedPeriods.length}{yearCoverage.possibleMissingPeriods.length ? ` · posibles faltantes: ${yearCoverage.possibleMissingPeriods.map(periodLabel).join(', ')}` : ' · sin faltantes posibles'}</p>}
      <div className="table-wrap" role="region" aria-label={`Tabla desplazable del resumen ${annual.year}`} tabIndex={0}><table><thead><tr><th>Categoría</th><th>Liquidaciones</th><th>Bruto</th><th>Neto</th><th>Conceptos normalizados</th></tr></thead><tbody>{categories.map((item) => {
        const summary = annual.byCategory[item];
        return <tr key={item}><td>{categoryLabels[item]}</td><td>{summary.settlementCount}</td><td>{salaryMoney(summary.totals.grossAmount, scope.currencyCode)}</td><td>{salaryMoney(summary.totals.netAmount, scope.currencyCode)}</td><td>{salaryMoney(annual.normalizedEarningsByCategory?.[item], scope.currencyCode)}</td></tr>;
      })}</tbody></table></div>
    </div></details>;
  })}</div>;
}

function Summary({ user, onNavigate }: { user: User; onNavigate: (section: Section) => void }) {
  const [history, setHistory] = useState<SalaryHistory | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedScopeKey, setSelectedScopeKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [salaryHistory, recent] = await Promise.all([
        api<SalaryHistory>('/salary-history'),
        api<DocumentItem[]>('/documents?limit=5'),
      ]);
      setHistory(salaryHistory); setDocuments(recent);
      setSelectedScopeKey((current) => retainedSalaryScopeKey(current, salaryHistory));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar el resumen.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const selectedScopeIndex = history?.contexts.findIndex((context) => salaryScopeKey(context) === selectedScopeKey) ?? -1;
  const context = history?.contexts[selectedScopeIndex < 0 ? 0 : selectedScopeIndex];
  const scope = history?.analytics.scopes[selectedScopeIndex < 0 ? 0 : selectedScopeIndex];

  return (
    <div className="page" aria-busy={loading}>
      <PageHeader eyebrow="Resumen personal" title={`Hola, ${user.displayName?.split(' ')[0] || 'bienvenido'}`} action={<button className="button primary" onClick={() => onNavigate('import')}>Importar recibos</button>} />
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Reintentando…' : 'Reintentar'}</button></p>}
      {loading && !history && <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando tu historial salarial…</p></div>}
      {history && context && scope ? <>
        <SalaryScopeControl history={history} selectedKey={selectedScopeKey} onChange={setSelectedScopeKey} id="summary-salary-scope" />
        <SalaryContextNotice context={context} />
        <SalaryMetricGrid scope={scope} context={context} />
        <div className="dashboard-grid">
          <section className="panel chart-panel"><div className="panel-heading"><div><p className="eyebrow">Evolución</p><h2>Comparable y neto reciente</h2></div><button className="text-button" onClick={() => onNavigate('history')}>Analizar historial</button></div><SalaryEvolution scope={scope} limit={12} /></section>
          <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">Actividad</p><h2>Documentos recientes</h2></div><button className="text-button" onClick={() => onNavigate('history')}>Ver todos</button></div><p className="coverage-note">{history.coverage.documents} documentos · {history.coverage.pendingReviewDocuments} para revisar · {history.coverage.activeEmployments} empleos activos</p>{documents.length ? <ul className="recent-list">{documents.map((document) => <li key={document.id}><span className="file-icon">PDF</span><span><strong>{documentName(document)}</strong><small>{document.payrollPeriod ? periodLabel(document.payrollPeriod) : shortDate(document.createdAt)}</small></span><Status value={document.processingStatus} /></li>)}</ul> : <EmptyState title="Sin documentos" body="Tus recibos importados aparecerán acá." />}</section>
        </div>
      </> : history && !loading && <EmptyState title="Todavía no hay datos salariales" body="Importá un recibo soportado y completá su revisión para construir el historial." action={<button className="button primary" onClick={() => onNavigate('import')}>Importar recibos</button>} />}
    </div>
  );
}

function Status({ value }: { value: string }) {
  const risky = /FAILED|QUARANTINED|REJECTED|CANCELLED/.test(value);
  const pending = /UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION|NEEDS_REVIEW|NEEDS_TYPE_CONFIRMATION/.test(value);
  return <span className={`status ${risky ? 'danger' : pending ? 'pending' : 'ready'}`}>{statusLabels[value] ?? value}</span>;
}

function Employments({ onChanged, runSensitive }: { onChanged: () => void; runSensitive: RunSensitive }) {
  const [items, setItems] = useState<Employment[]>([]);
  const [detections, setDetections] = useState<EmploymentDetection[]>([]);
  const [editing, setEditing] = useState<Employment | null | 'new'>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<EmploymentDetection | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState('');
  const load = useCallback(async () => {
    setError(''); setLoading(true);
    try {
      const [employments, detected] = await Promise.all([
        api<Employment[]>('/employments'),
        api<EmploymentDetection[]>('/employment-detections'),
      ]);
      setItems(employments); setDetections(detected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar tus empleos.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!editing) return;
    const currentEmployment = editing;
    const form = new FormData(event.currentTarget);
    const employerName = String(form.get('employerName') ?? '');
    try {
      const employerId = currentEmployment === 'new'
        ? (await api<{ id: string }>('/employers', {
            method: 'POST', body: JSON.stringify({ name: employerName, countryCode: 'AR' }),
          })).id
        : currentEmployment.employerId;
      if (currentEmployment !== 'new' && employerName !== currentEmployment.employerName) {
        await api(`/employers/${currentEmployment.employerId}`, {
          method: 'PATCH', body: JSON.stringify({ name: employerName }),
        });
      }
      const payload = {
        employerId, role: form.get('role') || null,
        startDate: form.get('startDate'), endDate: form.get('endDate') || null,
        countryCode: 'AR', currencyCode: form.get('currencyCode') || 'ARS',
      };
      const path = currentEmployment === 'new' ? '/employments' : `/employments/${currentEmployment.id}`;
      await api(path, { method: currentEmployment === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(payload) });
      setEditing(null); await load(); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos guardar el empleo.'); }
  }

  async function remove(item: Employment) {
    if (!confirm(`¿Eliminar el empleo en ${item.employerName}? Las liquidaciones no se borrarán.`)) return;
    try {
      await runSensitive(async () => {
        await api(`/employments/${item.id}`, { method: 'DELETE', body: '{}' });
        await api(`/employers/${item.employerId}`, { method: 'DELETE', body: '{}' }).catch(() => undefined);
        await load(); onChanged();
      });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos eliminarlo.'); }
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
          employerName: detection.employerName,
          currencyCode: detection.currencyCode,
          ...(employmentId && employmentId !== 'new'
            ? { employmentId }
            : { startDate: form.get('startDate'), endDate: form.get('endDate') || null }),
        }),
      });
      setConfirmation(null);
      await load(); onChanged();
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
      && normalizedEmployerName(item.employerName) === normalizedEmployerName(confirmation.employerName))
    : [];

  return (
    <div className="page" aria-busy={loading || confirming}>
      <PageHeader eyebrow="Trayectoria" title="Empleos" action={<button className="button primary" onClick={() => setEditing('new')}>Agregar empleo</button>} />
      <p className="page-intro">Usalos para agrupar recibos y entender cada etapa de tu carrera.</p>
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Recargando…' : 'Recargar'}</button></p>}
      <div className="stack-form">
        {loading && !items.length && !detections.length && <div className="empty-state" role="status" aria-live="polite"><div className="loader" aria-hidden="true" /><p>Cargando empleos…</p></div>}
        {detections.length > 0 && <section className="panel" aria-labelledby="detected-employments-title">
          <div className="panel-heading"><div><p className="eyebrow">Pendientes de confirmación</p><h2 id="detected-employments-title">Empleos detectados</h2></div></div>
          <div className="employment-grid">{detections.map((detection) => {
            const key = JSON.stringify([detection.employerName, detection.currencyCode]);
            const hasMatch = items.some((item) => item.currencyCode === detection.currencyCode && normalizedEmployerName(item.employerName) === normalizedEmployerName(detection.employerName));
            return <article className="employment-card" key={key}><div className="employer-avatar">{detection.employerName.slice(0, 2).toUpperCase()}</div><div className="employment-main"><div><h2>{detection.employerName}</h2><p>{detection.documentCount} recibo{detection.documentCount === 1 ? '' : 's'} sin asociar</p></div><span className="status pending">{hasMatch ? 'Sin asociar' : 'Detectado'}</span><dl><div><dt>Primer recibo</dt><dd>{periodLabel(detection.firstPeriod)}</dd></div><div><dt>Último recibo</dt><dd>{periodLabel(detection.lastPeriod)}</dd></div><div><dt>Moneda</dt><dd>{detection.currencyCode}</dd></div></dl><div className="card-actions"><button type="button" className="button compact" disabled={confirming} onClick={() => { setConfirmationError(''); setConfirmation(detection); }}>{hasMatch ? 'Asociar recibos' : 'Confirmar empleo'}</button></div></div></article>;
          })}</div>
        </section>}
        <section aria-label="Empleos confirmados">
          {detections.length > 0 && <div className="panel-heading"><div><p className="eyebrow">Trayectoria confirmada</p><h2>Empleos confirmados</h2></div></div>}
          {items.length ? <div className="employment-grid">{items.map((item) => <article className="employment-card" key={item.id}><div className="employer-avatar">{item.employerName.slice(0, 2).toUpperCase()}</div><div className="employment-main"><div><h2>{item.employerName}</h2><p>{item.role || 'Puesto sin especificar'}</p></div><span className={`status ${item.status === 'ACTIVE' ? 'ready' : ''}`}>{item.status === 'ACTIVE' ? 'Activo' : 'Finalizado'}</span><dl><div><dt>Desde</dt><dd>{shortDate(item.startDate)}</dd></div><div><dt>Hasta</dt><dd>{shortDate(item.endDate)}</dd></div><div><dt>Moneda</dt><dd>{item.currencyCode}</dd></div></dl><div className="card-actions"><button className="text-button" onClick={() => setEditing(item)}>Editar</button><button className="text-button danger-text" onClick={() => remove(item)}>Eliminar</button></div></div></article>)}</div> : !loading && !error && <EmptyState title={detections.length ? 'Todavía no confirmaste empleos' : 'Sumá tu primer empleo'} body={detections.length ? 'Confirmá una detección o agregá un empleo manualmente.' : 'Podés empezar por tu trabajo actual y completar el resto después.'} action={<button className="button primary" onClick={() => setEditing('new')}>Agregar empleo</button>} />}
        </section>
      </div>
      {editing && <div className="modal-layer" role="presentation" onMouseDown={() => setEditing(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="employment-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, () => setEditing(null))} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2 id="employment-title">{editing === 'new' ? 'Nuevo empleo' : 'Editar empleo'}</h2><button className="icon-button" onClick={() => setEditing(null)} aria-label="Cerrar">×</button></div><form className="stack-form" onSubmit={save}><label>Empresa<input name="employerName" defaultValue={editing === 'new' ? '' : editing.employerName} minLength={2} maxLength={160} required /></label><label>Puesto<input name="role" defaultValue={editing === 'new' ? '' : editing.role ?? ''} maxLength={120} /></label><div className="field-row"><label>Inicio<input name="startDate" type="date" defaultValue={editing === 'new' ? '' : editing.startDate.slice(0, 10)} required /></label><label>Fin<input name="endDate" type="date" defaultValue={editing === 'new' ? '' : editing.endDate?.slice(0, 10) ?? ''} /></label></div><label>Moneda<select name="currencyCode" defaultValue={editing === 'new' ? 'ARS' : editing.currencyCode}><option value="ARS">ARS — Peso argentino</option><option value="USD">USD — Dólar</option><option value="EUR">EUR — Euro</option></select></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>Cancelar</button><button className="button primary">Guardar</button></div></form></section></div>}
      {confirmation && <div className="modal-layer" role="presentation" onMouseDown={closeConfirmation}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="employment-confirmation-title" aria-describedby="employment-confirmation-description" tabIndex={-1} onKeyDown={(event) => handleDialogKey(event, closeConfirmation)} onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-head"><div><p className="eyebrow">Empleo detectado</p><h2 id="employment-confirmation-title">Confirmar empleo</h2></div><button type="button" className="icon-button" disabled={confirming} onClick={closeConfirmation} aria-label="Cerrar">×</button></div>
          <form className="stack-form" onSubmit={confirmDetection}>
            <label>Empresa<input value={confirmation.employerName} readOnly /></label>
            <div className="field-row"><label>Moneda<input value={confirmation.currencyCode} readOnly /></label><label>Documentos detectados<input value={confirmation.documentCount} readOnly /></label></div>
            <p id="employment-confirmation-description">Detectamos recibos entre {periodLabel(confirmation.firstPeriod)} y {periodLabel(confirmation.lastPeriod)}. El último recibo no implica que el empleo haya finalizado.</p>
            {matchingEmployments.length > 0 && <label>Asociar a<select name="employmentId" defaultValue={matchingEmployments.length === 1 ? matchingEmployments[0]!.id : ''} required autoFocus><option value="" disabled>Elegí un empleo</option>{matchingEmployments.map((item) => <option key={item.id} value={item.id}>{item.employerName}{item.role ? ` · ${item.role}` : ''} · desde {shortDate(item.startDate)}</option>)}<option value="new">Crear otro empleo</option></select><small>Al elegir uno existente se conservan sus fechas y datos.</small></label>}
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
      <label className="import-employment">Asociar todo el lote a<select value={employmentId} disabled={hasActiveBatch || busy} onChange={(event) => setEmploymentId(event.target.value)}><option value="">Sin asociar · detectar empresa</option>{employments.map((employment) => <option key={employment.id} value={employment.id}>{employment.employerName}{employment.role ? ` · ${employment.role}` : ''}</option>)}</select><small>Si mezclás empresas, dejalo sin asociar y usá los checkboxes del historial después.</small></label>
      <label className={`drop-zone${hasActiveBatch || busy ? ' disabled' : ''}`} aria-disabled={hasActiveBatch || busy} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files); }}><input type="file" accept="application/pdf,.pdf" multiple disabled={hasActiveBatch || busy} onChange={(event) => choose(event.target.files)} /><span className="upload-mark">↑</span><strong>{hasActiveBatch ? 'Hay un lote en curso' : 'Arrastrá tus recibos acá'}</strong><span>{hasActiveBatch ? 'Cuando termine vas a poder iniciar otro' : 'o hacé clic para elegir PDFs'}</span><small>El servidor limita archivos, tamaño total, espacio por cuenta y trabajo simultáneo.</small></label>
      {error && <p className="message error" role="alert">{error}</p>}
      {progress.length > 0 && <section className="panel upload-list" aria-live="polite"><div className="panel-heading"><div><p className="eyebrow">Lote</p><h2>{progress.length} archivo{progress.length === 1 ? '' : 's'}</h2></div>{batch && <span className="batch-id">Lote {batch.id.slice(0, 8)}</span>}</div>{batch && <div className="upload-summary"><progress max={batch.progress.total} value={batch.progress.resolved} aria-label="Progreso del lote" /><strong>{batch.progress.resolved} de {batch.progress.total} resueltos · {batch.progress.percentage}%</strong><small>{batch.totals.PROCESSING ?? 0} procesando · {(batch.totals.UPLOADED ?? 0) + (batch.totals.PENDING_UPLOAD ?? 0)} pendientes · {batch.totals.NEEDS_REVIEW ?? 0} para revisar · {(batch.totals.REJECTED ?? 0) + (batch.totals.FAILED ?? 0)} no procesados</small></div>}<ul>{progress.map((item) => <li key={item.key}><span className="file-icon">PDF</span><span className="upload-name"><strong>{item.name}</strong><small>{item.message ?? (item.status === 'PENDIENTE' ? 'Listo para subir' : 'Enviando…')} · {item.uploadPercentage}% cargado</small><progress max="100" value={item.uploadPercentage} aria-label={`Carga de ${item.name}`} /></span><span className={`upload-state ${item.status.toLowerCase()}`}>{item.status.replace('_', ' ')}</span></li>)}</ul><div className="upload-footer"><p>{hasActiveBatch && !busy && progress.some((item) => item.status === 'PENDIENTE') ? 'La carga se interrumpió. Cancelá los pendientes y volvé a seleccionarlos.' : 'Los errores de un archivo no detienen el resto del lote.'}</p>{hasActiveBatch ? (batch.totals.PENDING_UPLOAD ?? 0) > 0 && <button className="button secondary" disabled={busy} onClick={cancelPending}>Cancelar pendientes</button> : <button className="button primary" disabled={busy || !files.length} onClick={start}>{busy ? 'Subiendo…' : 'Iniciar importación'}</button>}</div></section>}
      <aside className="privacy-note"><span aria-hidden="true">◇</span><div><strong>Privado por diseño</strong><p>Los PDFs se guardan con claves opacas. Antes de extraer datos pasan por validación de formato y malware.</p></div></aside>
    </div>
  );
}

function History({ runSensitive }: { runSensitive: RunSensitive }) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [history, setHistory] = useState<SalaryHistory | null>(null);
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<string[]>([]);
  const [employmentChoice, setEmploymentChoice] = useState('');
  const [associating, setAssociating] = useState(false);
  const [selected, setSelected] = useState<DocumentItem | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [tab, setTab] = useState<'summary' | 'evolution' | 'annual' | 'concepts' | 'documents'>('summary');
  const [selectedScopeKey, setSelectedScopeKey] = useState('');
  const [yearFilter, setYearFilter] = useState('all');
  const [evolutionRange, setEvolutionRange] = useState<(typeof evolutionRanges)[number][0]>('12');
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
  const [documentKind, setDocumentKind] = useState<'PAYROLL' | 'UNSUPPORTED'>('PAYROLL');
  const [documentSearchDraft, setDocumentSearchDraft] = useState('');
  const [documentSearch, setDocumentSearch] = useState('');
  const [documentYearDraft, setDocumentYearDraft] = useState('');
  const [documentYear, setDocumentYear] = useState('all');
  const [documentStatus, setDocumentStatus] = useState('all');
  const [documentSettlementType, setDocumentSettlementType] = useState('all');
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [loadingMoreDocuments, setLoadingMoreDocuments] = useState(false);
  const [hasMoreDocuments, setHasMoreDocuments] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [preview, setPreview] = useState<{ documentId: string; expiresAt?: string; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequested = useRef(false);
  const previewGeneration = useRef(0);
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

  const invalidatePreview = useCallback(() => {
    previewGeneration.current += 1;
    previewRequested.current = false;
    setPreview(null);
    setPreviewBusy(false);
    setPreviewError('');
  }, []);
  useEffect(() => { activeDocumentId.current = selectedId; }, [selectedId]);
  useEffect(() => {
    if (selected) return;
    opener.current?.focus();
    opener.current = null;
  }, [selected]);

  const authorizePreview = useCallback(() => {
    if (!selectedId) return;
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
  }, [runSensitive, selectedId]);

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
  const fetchDocumentPage = useCallback((cursor?: DocumentItem, limit = 100) => {
    const query = new URLSearchParams({ limit: String(limit), documentType: documentKind });
    if (documentSearch) query.set('search', documentSearch);
    if (documentYear !== 'all' && documentKind === 'PAYROLL') query.set('year', documentYear);
    if (documentStatus !== 'all') query.set('processingStatus', documentStatus);
    if (documentSettlementType !== 'all' && documentKind === 'PAYROLL') query.set('settlementType', documentSettlementType);
    if (cursor) { query.set('before', cursor.createdAt); query.set('beforeId', cursor.id); }
    return api<DocumentItem[]>(`/documents?${query}`);
  }, [documentKind, documentSearch, documentYear, documentStatus, documentSettlementType]);
  const reloadDocuments = useCallback(async (silent = false) => {
    if (!silent) setDocumentsLoading(true);
    setDocumentError('');
    try {
      const docs = await fetchDocumentPage();
      applyDocuments(docs); setHasMoreDocuments(docs.length === 100);
    } catch (caught) {
      setDocumentError(caught instanceof Error ? caught.message : 'No pudimos cargar los documentos.');
    } finally { if (!silent) setDocumentsLoading(false); }
  }, [applyDocuments, fetchDocumentPage]);
  const loadSalary = useCallback(async () => {
    const next = await api<SalaryHistory>('/salary-history');
    setHistory(next);
    setSelectedScopeKey((current) => retainedSalaryScopeKey(current, next));
    setComparison(null); setComparisonLoaded(false);
    return next;
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextHistory, jobs] = await Promise.all([
        api<SalaryHistory>('/salary-history'),
        api<Employment[]>('/employments'),
      ]);
      setHistory(nextHistory); setEmployments(jobs);
      setSelectedScopeKey((current) => retainedSalaryScopeKey(current, nextHistory));
      setComparison(null); setComparisonLoaded(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar el historial.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { void Promise.resolve().then(() => reloadDocuments()); }, [reloadDocuments]);
  useEffect(() => {
    if (!documents.some((document) => processingDocumentPattern.test(document.processingStatus))) return;
    const timer = window.setTimeout(async () => {
      try {
        const docs: DocumentItem[] = [];
        const targetCount = Math.max(100, documents.length);
        let cursor: DocumentItem | undefined;
        while (docs.length < targetCount) {
          const pageLimit = Math.min(500, targetCount - docs.length);
          const page = await fetchDocumentPage(cursor, pageLimit);
          docs.push(...page);
          cursor = page.at(-1);
          if (!cursor || page.length < pageLimit) break;
        }
        const refreshedIds = new Set(docs.map(({ id }) => id));
        const visible = [...docs, ...documents.filter(({ id }) => !refreshedIds.has(id))];
        applyDocuments(visible);
        if (!visible.some((document) => processingDocumentPattern.test(document.processingStatus))) await loadSalary();
      } catch (caught) { setDocumentError(caught instanceof Error ? caught.message : 'No pudimos actualizar el procesamiento.'); }
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [documents, applyDocuments, fetchDocumentPage, loadSalary]);
  useEffect(() => {
    if (!selectedId) return;
    const documentId = selectedId;
    let stopped = false;
    api<DocumentDetail>(`/documents/${documentId}`)
      .then((nextDetail) => {
        if (stopped || activeDocumentId.current !== documentId) return;
        setDetailError('');
        setDetail(nextDetail);
        if (nextDetail.originalAvailable && nextDetail.securityStatus === 'CLEAN' && !previewRequested.current) authorizePreview();
      })
      .catch(async (caught: unknown) => {
        if (stopped || activeDocumentId.current !== documentId) return;
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
        if (!stopped && activeDocumentId.current === documentId) setDetailError(caught instanceof Error ? caught.message : 'No pudimos abrir el detalle.');
      });
    return () => { stopped = true; };
  }, [authorizePreview, detailReload, selectedId, selectedStatus]);

  const refreshDetail = useCallback(async () => {
    if (!selectedId) return;
    const documentId = selectedId;
    const nextDetail = await api<DocumentDetail>(`/documents/${documentId}`);
    if (activeDocumentId.current === documentId) setDetail(nextDetail);
  }, [selectedId]);

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
      if (location?.documentId !== selectedId) {
        invalidatePreview();
        setDetail(null);
        setDetailError('');
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
  }, [documents, invalidatePreview, reviewBusy, reviewDirty, selectedId]);

  function openDocument(document: DocumentItem, trigger: HTMLButtonElement) {
    if (selectedId === document.id) {
      if (!detail) { setDetailError(''); setDetailReload((value) => value + 1); }
      return;
    }
    invalidatePreview();
    opener.current = trigger;
    activeDocumentId.current = document.id;
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
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
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
    if (openedFromList && readDocumentLocation(window.location.search)?.documentId === selectedId) {
      allowNextPop.current = true;
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
    activeDocumentId.current = undefined;
    setSelected(null); setDetail(null); setDetailError('');
  }

  function closeDetailState() {
    if (reviewBusy || (reviewDirty && !window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?'))) return;
    closeDocument();
  }

  function navigateDocument(direction: -1 | 1) {
    if (!selectedId) return;
    const index = documents.findIndex(({ id }) => id === selectedId);
    if (index < 0) return;
    const next = documents[index + direction];
    if (!next) return;
    invalidatePreview();
    activeDocumentId.current = next.id;
    setSelected(next); setDetail(null); setDetailError(''); setLocationSeed({});
    reviewUrl.current = `${window.location.pathname}${writeDocumentLocation(window.location.search, { documentId: next.id })}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', reviewUrl.current);
  }

  async function reprocessDocument() {
    if (!selected || !confirm('¿Reprocesar este PDF con la versión actual? Tus correcciones se conservarán.')) return;
    invalidatePreview();
    await api(`/documents/${selected.id}/reprocess`, {
      method: 'POST',
      body: '{}',
      headers: { 'Idempotency-Key': browserOpaqueToken() },
    });
    await reloadDocuments(true);
    await refreshDetail();
  }
  async function associateDocuments() {
    if (!checkedDocumentIds.length || !employmentChoice || associating) return;
    setAssociating(true); setError('');
    try {
      await api('/documents/employment', {
        method: 'PATCH',
        body: JSON.stringify({
          documentIds: checkedDocumentIds,
          employmentId: employmentChoice === 'none' ? null : employmentChoice,
        }),
      });
      setCheckedDocumentIds([]); setEmploymentChoice(''); await Promise.all([loadSalary(), reloadDocuments(true)]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos asociar los documentos.'); }
    finally { setAssociating(false); }
  }

  const selectedScopeIndex = history?.contexts.findIndex((item) => salaryScopeKey(item) === selectedScopeKey) ?? -1;
  const context = history?.contexts[selectedScopeIndex < 0 ? 0 : selectedScopeIndex];
  const scope = history?.analytics.scopes[selectedScopeIndex < 0 ? 0 : selectedScopeIndex];
  const years = scope?.annual.map(({ year }) => year) ?? [];
  const selectedYear = yearFilter === 'all' || years.includes(yearFilter) ? yearFilter : 'all';
  const periods = scope?.evolution.map(({ period }) => period) ?? [];
  const selectedFromPeriod = periods.includes(fromPeriod) ? fromPeriod : periods[0] ?? '';
  const selectedToPeriod = periods.includes(toPeriod) ? toPeriod : periods.at(-1) ?? '';
  const annualRows = scope?.annual.filter(({ year }) => selectedYear === 'all' || year === selectedYear) ?? [];
  const latestEvents = scope?.events?.slice(-6).reverse() ?? [];
  const possibleDuplicates = context
    ? history?.analytics.possibleDuplicates.filter((duplicate) => duplicate.employmentContext === context.employmentContext && duplicate.currencyCode === context.currencyCode) ?? []
    : [];
  const conceptEmploymentContext = context?.employmentContext ?? '';
  const conceptCurrency = context?.currencyCode ?? '';
  const conceptEmployerName = context?.state === 'DETECTED' ? context.employerName ?? '' : '';
  const buildConceptQuery = useCallback((cursor?: string) => {
    if (!conceptEmploymentContext || !conceptCurrency || (conceptEmploymentContext.startsWith('detected:') && !conceptEmployerName)) return null;
    const query = new URLSearchParams({
      employmentContext: conceptEmploymentContext,
      currencyCode: conceptCurrency,
      limit: '100',
    });
    if (conceptEmployerName) query.set('employerName', conceptEmployerName);
    if (selectedYear !== 'all') query.set('year', selectedYear);
    if (categoryFilter !== 'all') query.set('category', categoryFilter);
    if (cursor) query.set('cursor', cursor);
    return `/salary-history/concepts?${query}`;
  }, [categoryFilter, conceptCurrency, conceptEmployerName, conceptEmploymentContext, selectedYear]);
  useEffect(() => {
    const path = tab === 'concepts' ? buildConceptQuery() : null;
    if (!path) return;
    let stopped = false;
    void Promise.resolve().then(async () => {
      setConceptLoading(true); setConcepts([]); setConceptCursor(null); setConceptError('');
      try {
        const page = await api<SalaryConceptPage>(path);
        if (!stopped) { setConcepts(page.items); setConceptCursor(page.nextCursor); }
      } catch (caught) {
        if (!stopped) setConceptError(caught instanceof Error ? caught.message : 'No pudimos cargar los conceptos.');
      } finally { if (!stopped) setConceptLoading(false); }
    });
    return () => { stopped = true; };
  }, [buildConceptQuery, conceptReloadKey, history, tab]);

  function selectScope(key: string) {
    setSelectedScopeKey(key); setYearFilter('all'); setCategoryFilter('all');
    setEvolutionRange('12');
    setConcepts([]); setConceptCursor(null); setConceptError('');
    setFromPeriod(''); setToPeriod(''); setComparison(null); setComparisonLoaded(false);
  }

  function moveHistoryTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = historyTabs.length - 1;
    const nextIndex = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = historyTabs[nextIndex]![0];
    setTab(next);
    document.getElementById(`history-tab-${next}`)?.focus();
  }

  async function loadMoreConcepts() {
    const path = conceptCursor ? buildConceptQuery(conceptCursor) : null;
    if (!path || conceptLoadingMore) return;
    setConceptLoadingMore(true); setConceptError('');
    try {
      const page = await api<SalaryConceptPage>(path);
      setConcepts((current) => [...current, ...page.items]);
      setConceptCursor(page.nextCursor);
    } catch (caught) {
      setConceptError(caught instanceof Error ? caught.message : 'No pudimos cargar más conceptos.');
    } finally { setConceptLoadingMore(false); }
  }

  async function comparePeriods() {
    if (!context || !selectedFromPeriod || !selectedToPeriod || selectedFromPeriod === selectedToPeriod) return;
    setComparisonLoading(true); setComparisonLoaded(false); setError('');
    try {
      const query = new URLSearchParams({
        employmentContext: context.employmentContext,
        currencyCode: context.currencyCode,
        fromPeriod: selectedFromPeriod,
        toPeriod: selectedToPeriod,
      });
      setComparison(await api<PeriodComparison | null>(`/salary-history/comparison?${query}`));
      setComparisonLoaded(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos comparar los períodos.'); }
    finally { setComparisonLoading(false); }
  }

  async function loadMoreDocuments() {
    const cursor = documents.at(-1);
    if (!cursor || loadingMoreDocuments) return;
    setLoadingMoreDocuments(true); setDocumentError('');
    try {
      const next = await fetchDocumentPage(cursor);
      setDocuments((current) => [...current, ...next.filter((item) => !current.some(({ id }) => id === item.id))]);
      setHasMoreDocuments(next.length === 100);
    } catch (caught) { setDocumentError(caught instanceof Error ? caught.message : 'No pudimos cargar más documentos.'); }
    finally { setLoadingMoreDocuments(false); }
  }

  const assignableDocuments = documents.filter((document) => associationReadyStatuses.has(document.processingStatus));
  const allAssignableSelected = assignableDocuments.length > 0
    && assignableDocuments.every((document) => checkedDocumentIds.includes(document.id));
  const documentGroups = useMemo(() => {
    const grouped = new Map<string, DocumentItem[]>();
    for (const document of documents) {
      const year = document.payrollPeriod?.slice(0, 4) || document.createdAt.slice(0, 4) || 'Sin año';
      grouped.set(year, [...(grouped.get(year) ?? []), document]);
    }
    return [...grouped].sort(([left], [right]) => left === 'Sin año' ? 1 : right === 'Sin año' ? -1 : right.localeCompare(left));
  }, [documents]);

  function documentRow(document: DocumentItem) {
    const assignable = documentKind === 'PAYROLL' && associationReadyStatuses.has(document.processingStatus);
    return <div className={`document-entry${documentKind === 'PAYROLL' ? '' : ' no-check'}`} key={document.id}>{documentKind === 'PAYROLL' && <label className="document-check" title={assignable ? 'Seleccionar documento' : 'Disponible cuando termine el procesamiento'}><input type="checkbox" aria-label={`Seleccionar ${documentName(document)}`} disabled={!assignable} checked={checkedDocumentIds.includes(document.id)} onChange={(event) => setCheckedDocumentIds((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} /></label>}<button type="button" className="document-row" onClick={(event) => openDocument(document, event.currentTarget)}><span className="file-icon">PDF</span><span><strong>{documentName(document)}</strong><small>{document.employerName || 'Sin empresa asociada'} · {document.payrollPeriod ? periodLabel(document.payrollPeriod) : shortDate(document.createdAt)}{document.settlementType ? ` · ${settlementTypeLabel(document.settlementType)}` : ''}{document.errorCode ? ` · ${importErrorLabels[document.errorCode] ?? 'No procesado'}` : ''}</small></span><Status value={document.processingStatus} /><span aria-hidden="true">›</span></button></div>;
  }
  const selectedDocumentIndex = documents.findIndex(({ id }) => id === selected?.id);

  return (
    <div className="page" aria-busy={loading || documentsLoading || comparisonLoading || conceptLoading || conceptLoadingMore}>
      <PageHeader eyebrow="Datos estructurados" title="Historial salarial" />
      <div className="tabs history-tabs" role="tablist" aria-label="Secciones del historial">{historyTabs.map(([value, label], index) => <button type="button" id={`history-tab-${value}`} role="tab" aria-controls={`history-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={tab === value ? 'active' : ''} onKeyDown={(event) => moveHistoryTab(event, index)} onClick={() => setTab(value)} key={value}>{label}</button>)}</div>
      {error && <p className="message error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{loading ? 'Reintentando…' : 'Reintentar'}</button></p>}
      {loading && !history && <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando el historial salarial…</p></div>}

      {tab !== 'documents' && history && context && scope && <>
        <SalaryScopeControl history={history} selectedKey={selectedScopeKey} onChange={selectScope} id="history-salary-scope" />
        <SalaryContextNotice context={context} />
        {(tab === 'evolution' || tab === 'annual' || tab === 'concepts') && <div className="history-filters">{tab === 'evolution' ? <label>Rango<select value={evolutionRange} onChange={(event) => setEvolutionRange(event.target.value as (typeof evolutionRanges)[number][0])}>{evolutionRanges.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : <><label>Año<select value={selectedYear} onChange={(event) => setYearFilter(event.target.value)}><option value="all">Todos</option>{years.map((year) => <option value={year} key={year}>{year}</option>)}</select></label><label>Categoría<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | SalaryCategory)}><option value="all">Todas</option>{salaryCategories.map((item) => <option value={item} key={item}>{categoryLabels[item]}</option>)}</select></label></>}</div>}
      </>}

      {tab === 'summary' && <section id="history-panel-summary" role="tabpanel" aria-labelledby="history-tab-summary" tabIndex={0}>{history && context && scope ? <>
        <SalaryMetricGrid scope={scope} context={context} />
        <div className="history-summary-grid">
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Últimos cambios</p><h2>Eventos informados</h2></div></div>{latestEvents.length ? <ul className="event-list">{latestEvents.map((event) => <li key={`${event.type}-${event.period}-${event.type === 'EXTRAORDINARY' ? event.settlementId : event.change.toPeriod}`}><span><strong>{event.type === 'COMPARABLE_INCREASE' ? 'Aumento comparable' : categoryLabels[event.category]}</strong><small>{periodLabel(event.period)}</small></span><strong>{event.type === 'COMPARABLE_INCREASE' ? salaryPercentage(event.change.percentage) : salaryMoney(event.amount, scope.currencyCode)}</strong></li>)}</ul> : <EmptyState title="Sin cambios informados" body="Hacen falta más períodos comparables o liquidaciones extraordinarias." />}</section>
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Calidad del historial</p><h2>Cobertura</h2></div></div>{scope.coverage && scope.coverage.basis !== 'INDETERMINATE_CONTEXT' ? <><p className="coverage-total"><strong>{scope.coverage.availablePeriods.length}/{scope.coverage.expectedPeriods.length}</strong> períodos disponibles</p><p>{scope.coverage.possibleMissingPeriods.length ? `Posibles faltantes: ${scope.coverage.possibleMissingPeriods.map(periodLabel).join(', ')}.` : scope.coverage.basis === 'OBSERVED' ? 'Sin faltantes dentro del rango observado; no implica una relación laboral completa.' : 'No se detectaron posibles faltantes dentro del rango laboral.'}</p>{scope.coverage.boundaryContradiction && <p className="message warning" role="status">Las fechas del empleo contradicen períodos observados; se amplió el rango para no ocultarlos.</p>}</> : <p>N/D: sin contexto laboral suficiente para determinar períodos esperados.</p>}{possibleDuplicates.length > 0 && <p className="message warning" role="status">Hay {possibleDuplicates.length} período{possibleDuplicates.length === 1 ? '' : 's'} con posibles recibos duplicados para revisar.</p>}</section>
        </div>
        <section className="panel comparison-panel"><div className="panel-heading"><div><p className="eyebrow">Comparación exacta</p><h2>Dos períodos</h2></div></div>{periods.length > 1 ? <><div className="comparison-controls"><label>Desde<select value={selectedFromPeriod} onChange={(event) => { setFromPeriod(event.target.value); setComparisonLoaded(false); }} >{periods.map((period) => <option value={period} key={period}>{periodLabel(period)}</option>)}</select></label><label>Hasta<select value={selectedToPeriod} onChange={(event) => { setToPeriod(event.target.value); setComparisonLoaded(false); }}>{periods.map((period) => <option value={period} key={period}>{periodLabel(period)}</option>)}</select></label><button type="button" className="button primary" disabled={comparisonLoading || selectedFromPeriod === selectedToPeriod} onClick={() => void comparePeriods()}>{comparisonLoading ? 'Comparando…' : 'Comparar'}</button></div>{comparison && <ComparisonResult comparison={comparison} />}{comparisonLoaded && !comparison && <EmptyState title="No se pueden comparar" body="No hay datos suficientes en uno de los períodos elegidos." />}</> : <EmptyState title="Falta otro período" body="La comparación necesita al menos dos períodos del mismo empleo y moneda." />}</section>
      </> : history && !loading ? <EmptyState title="Todavía no hay datos salariales" body="Importá recibos soportados y completá su revisión para construir el historial." /> : null}</section>}

      {tab === 'evolution' && <section id="history-panel-evolution" role="tabpanel" aria-labelledby="history-tab-evolution" tabIndex={0}>{scope ? <section className="panel chart-panel"><div className="panel-heading"><div><p className="eyebrow">Evolución</p><h2>Comparable y neto</h2></div></div><SalaryEvolution scope={scope} limit={evolutionRanges.find(([value]) => value === evolutionRange)?.[2]} /></section> : history && !loading ? <EmptyState title="Sin evolución" body="Todavía no hay liquidaciones analizadas." /> : null}</section>}

      {tab === 'annual' && <section id="history-panel-annual" role="tabpanel" aria-labelledby="history-tab-annual" tabIndex={0}>{scope ? <AnnualHistory rows={annualRows} scope={scope} category={categoryFilter} /> : history && !loading ? <EmptyState title="Sin resumen anual" body="Todavía no hay liquidaciones analizadas." /> : null}</section>}

      {tab === 'concepts' && <section id="history-panel-concepts" role="tabpanel" aria-labelledby="history-tab-concepts" tabIndex={0} aria-busy={conceptLoading || conceptLoadingMore}>
        {conceptError && <p className="message error" role="alert">{conceptError} <button type="button" className="text-button" disabled={conceptLoading} onClick={() => setConceptReloadKey((current) => current + 1)}>Reintentar</button></p>}
        {conceptLoading ? <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando conceptos…</p></div> : scope && concepts.length ? <><div className="table-wrap" role="region" aria-label="Tabla desplazable de conceptos salariales" tabIndex={0}><table><caption className="sr-only">Conceptos normalizados paginados por el servidor</caption><thead><tr><th>Período</th><th>Liquidación</th><th>Categoría</th><th>Concepto</th><th>Recurrencia</th><th>Importe</th></tr></thead><tbody>{concepts.map((row) => <tr key={`${row.settlementId}-${row.earningIndex}`}><td>{periodLabel(row.period)}</td><td>{settlementTypeLabel(row.settlementType)}</td><td>{categoryLabels[row.category]}</td><td>{earningLabels[row.code] ?? 'Otro concepto'}</td><td>{row.isRecurring === true ? 'Recurrente' : row.isRecurring === false ? 'No recurrente' : 'N/D'}</td><td>{salaryMoney(row.amount, scope.currencyCode)}</td></tr>)}</tbody></table></div>{conceptCursor && <div className="load-more"><button type="button" className="button secondary" disabled={conceptLoadingMore} onClick={() => void loadMoreConcepts()}>{conceptLoadingMore ? 'Cargando…' : 'Cargar más'}</button></div>}</> : scope ? <EmptyState title="Sin conceptos para esos filtros" body="Sólo se muestran conceptos ya normalizados por el servidor." /> : history && !loading ? <EmptyState title="Sin conceptos" body="Todavía no hay liquidaciones analizadas." /> : null}
      </section>}

      {tab === 'documents' && <section id="history-panel-documents" role="tabpanel" aria-labelledby="history-tab-documents" tabIndex={0}>
        <div className="document-kind" role="group" aria-label="Clase de documento"><button type="button" className={documentKind === 'PAYROLL' ? 'active' : ''} aria-pressed={documentKind === 'PAYROLL'} onClick={() => { setDocumentKind('PAYROLL'); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentSettlementType('all'); setCheckedDocumentIds([]); setSelected(null); }}>Recibos salariales</button><button type="button" className={documentKind === 'UNSUPPORTED' ? 'active' : ''} aria-pressed={documentKind === 'UNSUPPORTED'} onClick={() => { setDocumentKind('UNSUPPORTED'); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentSettlementType('all'); setCheckedDocumentIds([]); setSelected(null); }}>No soportados / descartados</button></div>
        <form className="document-filters" role="search" onSubmit={(event) => { event.preventDefault(); setDocumentSearch(documentSearchDraft.trim()); setDocumentYear(documentYearDraft || 'all'); }}><label>Buscar<input type="search" value={documentSearchDraft} maxLength={100} placeholder="Archivo o empresa" onChange={(event) => setDocumentSearchDraft(event.target.value)} /></label>{documentKind === 'PAYROLL' && <label>Año<input type="text" inputMode="numeric" pattern="20[0-9]{2}" maxLength={4} value={documentYearDraft} placeholder="Todos" title="Ingresá un año entre 2000 y 2099" onChange={(event) => setDocumentYearDraft(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>}<label>Estado<select value={documentStatus} onChange={(event) => setDocumentStatus(event.target.value)}><option value="all">Todos</option>{documentFilterStatuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{documentKind === 'PAYROLL' && <label>Tipo de liquidación<select value={documentSettlementType} onChange={(event) => setDocumentSettlementType(event.target.value)}><option value="all">Todos</option>{settlementTypeOptions.map((value) => <option value={value} key={value}>{settlementTypeLabel(value)}</option>)}</select></label>}<button type="submit" className="button secondary compact">Buscar</button>{(documentSearch || documentYear !== 'all' || documentStatus !== 'all' || documentSettlementType !== 'all') && <button type="button" className="text-button" onClick={() => { setDocumentSearchDraft(''); setDocumentSearch(''); setDocumentYearDraft(''); setDocumentYear('all'); setDocumentStatus('all'); setDocumentSettlementType('all'); }}>Limpiar filtros</button>}</form>
        {documentError && <p className="message error" role="alert">{documentError} <button type="button" className="text-button" disabled={documentsLoading} onClick={() => void reloadDocuments()}>{documentsLoading ? 'Reintentando…' : 'Reintentar'}</button></p>}
        {documentKind === 'PAYROLL' && documents.length > 0 && <div className="bulk-association"><label><input type="checkbox" checked={allAssignableSelected} onChange={(event) => setCheckedDocumentIds(event.target.checked ? assignableDocuments.map(({ id }) => id) : [])} />Seleccionar todos</label><span>{checkedDocumentIds.length} seleccionado{checkedDocumentIds.length === 1 ? '' : 's'}</span><select aria-label="Empleo para asociar" value={employmentChoice} onChange={(event) => setEmploymentChoice(event.target.value)}><option value="">Elegí un empleo</option>{employments.map((employment) => <option key={employment.id} value={employment.id}>{employment.employerName}{employment.role ? ` · ${employment.role}` : ''}</option>)}<option value="none">Quitar asociación</option></select><button type="button" className="button primary compact" disabled={!checkedDocumentIds.length || !employmentChoice || associating} onClick={() => void associateDocuments()}>{associating ? 'Guardando…' : 'Aplicar'}</button></div>}
        {documentsLoading ? <div className="empty-state" role="status"><div className="loader" aria-hidden="true" /><p>Cargando documentos…</p></div> : documents.length ? <><div className="document-groups">{documentGroups.map(([year, items]) => <details className="document-year" key={year}><summary><strong>{year}</strong><span>{items.length} documento{items.length === 1 ? '' : 's'} cargado{items.length === 1 ? '' : 's'}</span></summary><div className="document-list">{items.map(documentRow)}</div></details>)}</div>{hasMoreDocuments && <div className="load-more"><button type="button" className="button secondary" disabled={loadingMoreDocuments} onClick={() => void loadMoreDocuments()}>{loadingMoreDocuments ? 'Cargando…' : 'Cargar más'}</button></div>}</> : <EmptyState title={documentKind === 'PAYROLL' ? 'No hay recibos para estos filtros' : 'No hay documentos no soportados'} body={documentKind === 'PAYROLL' ? 'Importá PDFs o limpiá los filtros para ver su estado.' : 'Los PDFs descartados o confirmados como no salariales aparecen separados acá.'} />}
      </section>}

      {selected && (!detail || detailError) && <div className="modal-layer" role="presentation" onMouseDown={closeDetailState}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="document-loading-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, closeDetailState)} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p className="eyebrow">Documento privado</p><h2 id="document-loading-title">{documentName(selected)}</h2></div><button className="icon-button" disabled={reviewBusy} onClick={closeDetailState} aria-label="Cerrar">×</button></div>{detailError ? <><p className="message error" role="alert">{detailError}</p><div className="modal-actions"><button type="button" className="button secondary" disabled={reviewBusy} onClick={closeDetailState}>Cerrar</button><button type="button" className="button primary" disabled={reviewBusy} onClick={() => setDetailReload((value) => value + 1)}>Reintentar</button></div></> : <p aria-live="polite">Cargando metadatos y datos extraídos…</p>}</section></div>}
      {selected && detail && <DocumentReview
        key={selected.id}
        detail={detail}
        initialEvidenceId={locationSeed.evidenceId}
        initialPage={locationSeed.page}
        position={{ current: selectedDocumentIndex < 0 ? null : selectedDocumentIndex + 1, total: Math.max(1, documents.length) }}
        settlement={detail.reviewSettlement ?? undefined}
        source={preview?.documentId === selected.id ? preview : null}
        sourceBusy={previewBusy}
        sourceError={previewError}
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
        onSave={saveCorrections}
      />}
    </div>
  );
}

function MfaSettings({ onUserChanged, runSensitive }: { onUserChanged: (user: User) => void; runSensitive: RunSensitive }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [nextStatus, nextUser] = await Promise.all([api<MfaStatus>('/auth/mfa'), api<User>('/auth/me')]);
    setStatus(nextStatus);
    onUserChanged(nextUser);
  }, [onUserChanged]);

  useEffect(() => {
    api<MfaStatus>('/auth/mfa').then(setStatus).catch((caught) => setError(caught instanceof Error ? caught.message : 'No pudimos consultar el segundo factor.'));
  }, []);

  async function regenerateRecoveryCodes() {
    setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST', body: '{}' });
        setRecoveryCodes(result.recoveryCodes);
        setStatus((current) => current ? { ...current, recoveryCodesRemaining: result.recoveryCodes.length } : current);
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos renovar los códigos.'); }
  }

  async function disable() {
    if (!confirm('¿Desactivar el segundo factor? Tu cuenta quedará protegida sólo por tu acceso principal.')) return;
    setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        await api('/auth/mfa', { method: 'DELETE' });
        setRecoveryCodes(null);
        await refresh();
        setMessage('Segundo factor desactivado.');
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos desactivar el segundo factor.'); }
  }

  return (
    <section className="settings-card"><div className="setting-icon">2</div><div><h2>Segundo factor</h2>
      {!status && !error && <p>Cargando estado…</p>}
      {error && <p className="message error" role="alert">{error}</p>}
      {message && <p className="message success" aria-live="polite">{message}</p>}
      {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} /> : status?.enabled ? <>
        <p>Activo. Además de tu acceso principal, Salarivo pedirá un código para ingresar y proteger acciones sensibles.</p>
        <p>Te quedan <strong>{status.recoveryCodesRemaining}</strong> códigos de recuperación.</p>
        <div className="setting-actions"><button className="button secondary" onClick={regenerateRecoveryCodes}>Generar códigos nuevos</button><button className="button danger-button" onClick={disable}>Desactivar</button></div>
      </> : status ? <><p>Si no activás TOTP, las acciones sensibles te pedirán volver a confirmar tu cuenta de Google.</p><MfaEnrollment pending={status.pendingEnrollment} onComplete={refresh} /></> : null}
    </div></section>
  );
}

function Privacy({ user, onUserChanged, runSensitive, onDeletionRequested }: {
  user: User;
  onUserChanged: (user: User) => void;
  runSensitive: RunSensitive;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [exportJob, setExportJob] = useState<{ id: string; status: string; downloadUrl?: string | null } | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function requestExport() {
    setError(''); setMessage('');
    try { await runSensitive(async () => {
      const next = await api<{ id: string; status: string; downloadUrl?: string | null }>('/privacy/exports', { method: 'POST', body: '{}' });
      setExportJob(next);
      setMessage(next.status === 'READY'
        ? 'Tu exportación quedó lista para descargar.'
        : next.status === 'RUNNING'
          ? 'Tu exportación se está descargando en otra sesión.'
          : 'Tu exportación se está preparando.');
    }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la exportación.'); }
  }
  async function refreshExport() {
    if (!exportJob) return;
    setError('');
    try { setExportJob(await api(`/privacy/exports/${exportJob.id}`)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos consultar la exportación.'); }
  }
  async function deleteAccount() {
    if (confirmation !== 'ELIMINAR') return;
    setError('');
    const receiptToken = browserOpaqueToken();
    try {
      await runSensitive(async () => {
        try {
          await api('/privacy/account', {
            method: 'DELETE', body: JSON.stringify({ confirmation, receiptToken }),
          });
          onDeletionRequested(receiptToken, 'accepted');
        } catch (caught) {
          if (!(caught instanceof ApiError) || caught.status >= 500) onDeletionRequested(receiptToken, 'ambiguous');
          else throw caught;
        }
      });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos solicitar la baja.'); }
  }

  async function downloadExport() {
    if (!exportJob?.downloadUrl) return;
    setError(''); setMessage('');
    try { await runSensitive(async () => {
      await downloadApiFile(exportJob.downloadUrl!, 'salarivo-export.json');
      setExportJob(null);
      setMessage('La exportación se descargó. Podés solicitar una nueva.');
    }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos descargar la exportación.'); }
  }

  async function revokeOtherSessions() {
    setError(''); setMessage('');
    try {
      await runSensitive(async () => {
        const result = await api<{ revokedSessions: number }>('/auth/sessions/revoke-others', { method: 'POST', body: '{}' });
        setMessage(result.revokedSessions === 0
          ? 'No había otras sesiones activas.'
          : `Cerramos ${result.revokedSessions} ${result.revokedSessions === 1 ? 'sesión' : 'sesiones'} en otros dispositivos.`);
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos cerrar las otras sesiones.'); }
  }

  return (
    <div className="page narrow-page">
      <PageHeader eyebrow="Tus datos" title="Privacidad y seguridad" />
      {error && <p className="message error" role="alert">{error}</p>}{message && <p className="message success" aria-live="polite">{message} <button type="button" className="text-button" onClick={() => setMessage('')}>Cerrar</button></p>}
      <MfaSettings key={String(user.mfaEnabled)} onUserChanged={onUserChanged} runSensitive={runSensitive} />
      <section className="settings-card"><div className="setting-icon">↪</div><div><h2>Sesiones activas</h2><p>Cerrá las sesiones abiertas en otros navegadores o dispositivos. Esta sesión seguirá activa.</p></div><div className="setting-actions"><button className="button secondary" onClick={revokeOtherSessions}>Cerrar otras sesiones</button></div></section>
      <section className="settings-card"><div className="setting-icon">⇩</div><div><h2>Exportar mis datos</h2><p>Generá un JSON legible con tu cuenta, empleos, importaciones, documentos, liquidaciones, conceptos, correcciones, accesos y solicitudes de privacidad. No incluye IDs internos, datos técnicos del procesamiento, PDFs ni secretos.</p>{exportJob && <p className="job-status">Estado: <strong>{exportJob.status}</strong></p>}</div><div className="setting-actions">{exportJob?.downloadUrl ? <button className="button primary" onClick={downloadExport}>Descargar</button> : exportJob && !['COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED'].includes(exportJob.status) ? <button className="button secondary" onClick={refreshExport}>Actualizar estado</button> : <button className="button secondary" onClick={requestExport}>Solicitar exportación</button>}</div></section>
      <section className="settings-card"><div className="setting-icon">◇</div><div><h2>Originales y datos estructurados</h2><p>Desde Historial podés borrar un PDF y conservar la liquidación revisada. Cada lifecycle es independiente.</p></div></section>
      <section className="settings-card"><div className="setting-icon">§</div><div><h2>Documentos legales</h2><p>Consultá la versión vigente de los <a className="inline-link" href="/terms" target="_blank" rel="noreferrer">Términos de uso</a> y el <a className="inline-link" href="/privacy" target="_blank" rel="noreferrer">Aviso de privacidad</a>.</p></div></section>
      {user.role === 'ADMIN'
        ? <section className="settings-card"><div className="setting-icon">!</div><div><h2>Baja de una cuenta administrativa</h2><p>Para preservar el último acceso de gobierno, otra persona con permiso debe retirar primero tu rol administrativo. Después podés solicitar la eliminación como usuario.</p></div></section>
        : <section className="settings-card danger-zone"><div className="setting-icon">!</div><div><h2>Eliminar mi cuenta</h2><p>Inicia el borrado irreversible de documentos, datos estructurados, sesiones y exportaciones.</p><label>Escribí <strong>ELIMINAR</strong> para confirmar<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></div><div className="setting-actions"><button className="button danger-button" disabled={confirmation !== 'ELIMINAR'} onClick={deleteAccount}>Eliminar cuenta</button></div></section>}
    </div>
  );
}
