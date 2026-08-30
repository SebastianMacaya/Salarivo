'use client';

import { FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { money, percentage } from './format';
import { mfaQrDataUrl } from './mfa-qr';
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
type DocumentItem = {
  id: string;
  employmentId?: string | null;
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
type ExtractedField = {
  id: string | null;
  fieldPath: string;
  interpretedValue: string | null;
  correctedValue?: string | null;
  confidence: string;
  source: string;
  missingReason?: 'LABEL_OR_LAYOUT_NOT_RECOGNIZED' | 'VALUE_NOT_INTERPRETABLE';
};
type Settlement = {
  id: string;
  payrollPeriod: string;
  employerName?: string | null;
  settlementType: string;
  currencyCode: string;
  grossAmount?: string | null;
  netAmount?: string | null;
  deductionsAmount?: string | null;
  deductionsPercentage?: string | null;
  totalsBalance?: boolean;
  deductionsMatchTotal?: boolean;
  deductionsDifferenceAmount?: string | null;
  deductionsDifferenceKind?: 'MATCHED' | 'TOTAL_MISSING' | 'MISSING_ITEMS' | 'ITEMS_EXCEED_TOTAL';
  deductions?: Array<{
    normalizedConceptCode?: string | null;
    rawDescription: string;
    amount: string;
    grossPercentage?: string | null;
    confidence?: string | null;
  }>;
  confidence?: string | null;
  documentId?: string | null;
};
type Dashboard = {
  activeEmployments: number;
  documents: number;
  pendingReview: number;
  latestNetAmount?: string | null;
  currencyCode?: string | null;
  evolution: Array<{ period: string; gross: string | null; net: string | null }>;
};
type ImportProgress = {
  key: string;
  name: string;
  status: 'PENDIENTE' | 'SUBIENDO' | 'EN_COLA' | 'LISTO' | 'REVISAR' | 'ERROR';
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

const deductionLabels: Record<string, string> = {
  RETIREMENT: 'Jubilación',
  HEALTH_INSURANCE: 'Obra social',
  PAMI: 'PAMI / Ley 19.032',
  INCOME_TAX: 'Ganancias / Ingresos personales',
  UNION_DUES: 'Cuota sindical',
};
const reviewFieldLabels: Record<string, string> = {
  'employer.name': 'Empresa detectada',
  'settlement.type': 'Tipo de liquidación',
  'settlement.payrollPeriod': 'Período',
  'settlement.basicAmount': 'Sueldo básico',
  'settlement.grossAmount': 'Bruto',
  'settlement.deductionsAmount': 'Descuentos',
  'settlement.netAmount': 'Neto',
};
const missingReasonMessages: Record<NonNullable<ExtractedField['missingReason']>, string> = {
  LABEL_OR_LAYOUT_NOT_RECOGNIZED: 'No reconocimos la etiqueta o la ubicación del dato.',
  VALUE_NOT_INTERPRETABLE: 'Reconocimos el campo, pero no pudimos interpretar el valor.',
};
const editableCorrectionPaths = new Set([
  'settlement.type', 'settlement.payrollPeriod', 'settlement.basicAmount',
  'settlement.grossAmount', 'settlement.deductionsAmount', 'settlement.netAmount',
]);
const settlementTypeOptions = [
  'NORMAL', 'SAC', 'VACACIONES', 'BONO', 'RETROACTIVO', 'COMISION', 'HORAS_EXTRA',
  'LIQUIDACION_FINAL', 'INDEMNIZACION', 'AJUSTE', 'OTRO_LABORAL',
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
  const base = { key: server.clientItemKey, name: server.originalFilename };
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

function PrivateApp({ user, authNotice, onUserChanged, onLogout, onDeletionRequested }: {
  user: User;
  authNotice: string;
  onUserChanged: (user: User) => void;
  onLogout: () => void;
  onDeletionRequested: (token: string, source: 'accepted' | 'ambiguous') => void;
}) {
  const [section, setSection] = useState<Section>('summary');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<(() => Promise<void>) | null>(null);
  const [logoutError, setLogoutError] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const visibleSections = sections;

  const runSensitive = useCallback<RunSensitive>(async (action) => {
    try { await action(); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === 'STEP_UP_REQUIRED') {
        setPendingSensitiveAction(() => action);
        return;
      }
      throw caught;
    }
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
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú">×</button></div>
        <nav aria-label="Navegación principal">
          {visibleSections.map((item) => <button key={item.id} className={section === item.id ? 'nav-item active' : 'nav-item'} onClick={() => { setSection(item.id); setMenuOpen(false); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
          {user.role === 'ADMIN' && <Link className="nav-item" href="/admin"><span aria-hidden="true">⚙</span>Administración</Link>}
        </nav>
        {logoutError && <p className="message error" role="alert">{logoutError}</p>}
        <div className="sidebar-user">
          <span className="avatar">{(user.displayName || user.email).slice(0, 1).toUpperCase()}</span>
          <span><strong>{user.displayName || 'Mi cuenta'}</strong><small>{user.email}</small></span>
          <button className="icon-button" disabled={logoutBusy} onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">{logoutBusy ? '…' : '↪'}</button>
        </div>
      </aside>
      {menuOpen && <button className="backdrop" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} />}
      <main className="content">
        <header className="mobile-header"><button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menú">☰</button><Brand /></header>
        {authNotice && <p className="message success" aria-live="polite">{authNotice}</p>}
        {section === 'summary' && <Summary key={refreshKey} user={user} onNavigate={setSection} />}
        {section === 'jobs' && <Employments key={refreshKey} onChanged={() => setRefreshKey((n) => n + 1)} runSensitive={runSensitive} />}
        {section === 'import' && <Importer onDone={() => setRefreshKey((n) => n + 1)} />}
        {section === 'history' && <History key={refreshKey} runSensitive={runSensitive} />}
        {section === 'privacy' && <Privacy user={user} onUserChanged={onUserChanged} runSensitive={runSensitive} onDeletionRequested={onDeletionRequested} />}
      </main>
      {pendingSensitiveAction && <StepUpDialog mfaEnabled={Boolean(user.mfaEnabled)} action={pendingSensitiveAction} onClose={() => setPendingSensitiveAction(null)} />}
    </div>
  );
}

function StepUpDialog({ mfaEnabled, action, onClose }: { mfaEnabled: boolean; action: () => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const value = form.get('credential');
    try {
      await api('/auth/step-up', {
        method: 'POST', body: JSON.stringify({ code: value }),
      });
      await action();
      onClose();
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
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="step-up-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, onClose)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">Acción sensible</p><h2 id="step-up-title">Confirmá tu identidad</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar">×</button></div>
        {!mfaEnabled ? <div className="stack-form">
          <p>Volvé a confirmar tu cuenta de Google para continuar.</p>
          {error && <p className="message error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button type="button" className="button primary google-button" disabled={busy} onClick={startGoogleStepUp}><GoogleIcon />{busy ? 'Abriendo Google…' : 'Continuar con Google'}</button></div>
        </div> : <form className="stack-form" onSubmit={submit}>
          <label>Código de la app o de recuperación<input name="credential" type="text" autoComplete="one-time-code" maxLength={39} required autoFocus /></label>
          {error && <p className="message error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Confirmando…' : 'Continuar'}</button></div>
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

function Summary({ user, onNavigate }: { user: User; onNavigate: (section: Section) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<Dashboard>('/dashboard'), api<DocumentItem[]>('/documents?limit=5')])
      .then(([summary, recent]) => { setDashboard(summary); setDocuments(recent); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'No pudimos cargar el resumen.'));
  }, []);

  const maxValue = useMemo(() => Math.max(1, ...(dashboard?.evolution.flatMap((point) => [Number(point.gross ?? 0), Number(point.net ?? 0)]) ?? [])), [dashboard]);

  return (
    <div className="page">
      <PageHeader eyebrow="Resumen personal" title={`Hola, ${user.displayName?.split(' ')[0] || 'bienvenido'}`} action={<button className="button primary" onClick={() => onNavigate('import')}>Importar recibos</button>} />
      {error && <p className="message error" role="alert">{error}</p>}
      <section className="metric-grid" aria-label="Indicadores">
        <article className="metric"><small>Último neto</small><strong>{money(dashboard?.latestNetAmount, dashboard?.currencyCode ?? 'ARS')}</strong><span>Dato estructurado más reciente</span></article>
        <article className="metric"><small>Empleos activos</small><strong>{dashboard?.activeEmployments ?? '—'}</strong><span>Relaciones laborales abiertas</span></article>
        <article className="metric accent"><small>Para revisar</small><strong>{dashboard?.pendingReview ?? '—'}</strong><button onClick={() => onNavigate('history')}>Ver pendientes →</button></article>
        <article className="metric"><small>Documentos</small><strong>{dashboard?.documents ?? '—'}</strong><span>Recibos en tu espacio</span></article>
      </section>
      <div className="dashboard-grid">
        <section className="panel chart-panel">
          <div className="panel-heading"><div><p className="eyebrow">Evolución</p><h2>Bruto y neto por período</h2></div><div className="legend"><span className="gross">Bruto</span><span className="net">Neto</span></div></div>
          {dashboard?.evolution.length ? <div className="bar-chart" role="img" aria-label="Evolución de salario bruto y neto">{dashboard.evolution.map((point) => <div className="bar-group" key={point.period} title={`${point.period}: bruto ${money(point.gross)}, neto ${money(point.net)}`}><div className="bars"><i className="bar gross" style={{ height: `${(Number(point.gross ?? 0) / maxValue) * 100}%` }} /><i className="bar net" style={{ height: `${(Number(point.net ?? 0) / maxValue) * 100}%` }} /></div><small>{point.period.slice(0, 7)}</small></div>)}</div> : <EmptyState title="Todavía no hay evolución" body="Importá tu primer recibo para empezar a construirla." action={<button className="button secondary" onClick={() => onNavigate('import')}>Importar ahora</button>} />}
        </section>
        <section className="panel recent-panel">
          <div className="panel-heading"><div><p className="eyebrow">Actividad</p><h2>Documentos recientes</h2></div><button className="text-button" onClick={() => onNavigate('history')}>Ver todos</button></div>
          {documents.length ? <ul className="recent-list">{documents.map((document) => <li key={document.id}><span className="file-icon">PDF</span><span><strong>{documentName(document)}</strong><small>{shortDate(document.createdAt)}</small></span><Status value={document.processingStatus} /></li>)}</ul> : <EmptyState title="Sin documentos" body="Tus recibos importados aparecerán acá." />}
        </section>
      </div>
    </div>
  );
}

function Status({ value }: { value: string }) {
  const risky = /FAILED|QUARANTINED|REJECTED|CANCELLED/.test(value);
  const pending = /UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION|NEEDS_REVIEW|NEEDS_TYPE_CONFIRMATION/.test(value);
  return <span className={`status ${risky ? 'danger' : pending ? 'pending' : 'ready'}`}>{statusLabels[value] ?? value}</span>;
}

function DeductionBreakdown({ settlement }: { settlement: Settlement }) {
  const items = settlement.deductions ?? [];
  const difference = money(settlement.deductionsDifferenceAmount, settlement.currencyCode);
  const mismatch = settlement.deductionsDifferenceKind === 'TOTAL_MISSING'
    ? `Se detectaron conceptos por ${difference}, pero no el total.`
    : settlement.deductionsDifferenceKind === 'MISSING_ITEMS'
      ? `Falta identificar ${difference} del total.`
      : settlement.deductionsDifferenceKind === 'ITEMS_EXCEED_TOTAL'
        ? `Los conceptos superan el total por ${difference}.`
        : null;
  return <div className="deduction-cell"><strong>{money(settlement.deductionsAmount, settlement.currencyCode)}</strong>{settlement.deductionsPercentage && <small>{percentage(settlement.deductionsPercentage)} del bruto</small>}{mismatch && <small className="deduction-warning">{mismatch}</small>}{items.length > 0 && <details><summary>Ver desglose ({items.length})</summary><ul>{items.map((item, index) => <li key={`${item.normalizedConceptCode ?? 'OTHER'}-${index}`}><span>{item.normalizedConceptCode ? deductionLabels[item.normalizedConceptCode] ?? item.rawDescription : item.rawDescription}{item.grossPercentage && <small>{percentage(item.grossPercentage)} del bruto</small>}</span><strong>{money(item.amount, settlement.currencyCode)}</strong></li>)}</ul></details>}</div>;
}

function Employments({ onChanged, runSensitive }: { onChanged: () => void; runSensitive: RunSensitive }) {
  const [items, setItems] = useState<Employment[]>([]);
  const [editing, setEditing] = useState<Employment | null | 'new'>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Employment[]>('/employments').then(setItems).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'No pudimos cargar tus empleos.')), []);
  useEffect(() => { void load(); }, [load]);

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

  return (
    <div className="page">
      <PageHeader eyebrow="Trayectoria" title="Empleos" action={<button className="button primary" onClick={() => setEditing('new')}>Agregar empleo</button>} />
      <p className="page-intro">Usalos para agrupar recibos y entender cada etapa de tu carrera.</p>
      {error && <p className="message error" role="alert">{error}</p>}
      {items.length ? <div className="employment-grid">{items.map((item) => <article className="employment-card" key={item.id}><div className="employer-avatar">{item.employerName.slice(0, 2).toUpperCase()}</div><div className="employment-main"><div><h2>{item.employerName}</h2><p>{item.role || 'Puesto sin especificar'}</p></div><span className={`status ${item.status === 'ACTIVE' ? 'ready' : ''}`}>{item.status === 'ACTIVE' ? 'Activo' : 'Finalizado'}</span><dl><div><dt>Desde</dt><dd>{shortDate(item.startDate)}</dd></div><div><dt>Hasta</dt><dd>{shortDate(item.endDate)}</dd></div><div><dt>Moneda</dt><dd>{item.currencyCode}</dd></div></dl><div className="card-actions"><button className="text-button" onClick={() => setEditing(item)}>Editar</button><button className="text-button danger-text" onClick={() => remove(item)}>Eliminar</button></div></div></article>)}</div> : <EmptyState title="Sumá tu primer empleo" body="Podés empezar por tu trabajo actual y completar el resto después." action={<button className="button primary" onClick={() => setEditing('new')}>Agregar empleo</button>} />}
      {editing && <div className="modal-layer" role="presentation" onMouseDown={() => setEditing(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="employment-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, () => setEditing(null))} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2 id="employment-title">{editing === 'new' ? 'Nuevo empleo' : 'Editar empleo'}</h2><button className="icon-button" onClick={() => setEditing(null)} aria-label="Cerrar">×</button></div><form className="stack-form" onSubmit={save}><label>Empresa<input name="employerName" defaultValue={editing === 'new' ? '' : editing.employerName} minLength={2} maxLength={160} required /></label><label>Puesto<input name="role" defaultValue={editing === 'new' ? '' : editing.role ?? ''} maxLength={120} /></label><div className="field-row"><label>Inicio<input name="startDate" type="date" defaultValue={editing === 'new' ? '' : editing.startDate.slice(0, 10)} required /></label><label>Fin<input name="endDate" type="date" defaultValue={editing === 'new' ? '' : editing.endDate?.slice(0, 10) ?? ''} /></label></div><label>Moneda<select name="currencyCode" defaultValue={editing === 'new' ? 'ARS' : editing.currencyCode}><option value="ARS">ARS — Peso argentino</option><option value="USD">USD — Dólar</option><option value="EUR">EUR — Euro</option></select></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>Cancelar</button><button className="button primary">Guardar</button></div></form></section></div>}
    </div>
  );
}

function Importer({ onDone }: { onDone: () => void }) {
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
    if (!list || hasActiveBatch) return;
    const selected = Array.from(list);
    const valid = selected.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    setFiles(valid);
    setBatch(null);
    setProgress(valid.map((file) => ({ key: crypto.randomUUID(), name: file.name, status: 'PENDIENTE' })));
    setError(valid.length !== selected.length ? 'Omitimos archivos que no parecen ser PDF.' : '');
  }

  function update(index: number, patch: Partial<ImportProgress>) {
    setProgress((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  }

  async function start() {
    if (!files.length || busy) return;
    setBusy(true); setError('');
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
        update(index, { status: 'SUBIENDO', message: undefined });
        try {
          const upload = await api<{ id: string } & AuthorizedUpload>('/upload-sessions', { method: 'POST', body: JSON.stringify({ itemId: item.id }) });
          const uploaded = await uploadFile(upload, file);
          if (!uploaded.ok) throw new Error(`El almacenamiento rechazó el archivo (${uploaded.status}).`);
          await api(`/upload-sessions/${upload.id}/complete`, { method: 'POST', body: '{}' });
          update(index, { status: 'EN_COLA', message: 'Validación de seguridad en curso' });
        } catch (caught) {
          uploadFailed = true;
          update(index, { status: 'ERROR', message: caught instanceof Error ? caught.message : 'No se pudo subir.' });
        }
      }
      if (uploadFailed) applyBatch(await api<ImportBatch>(`/imports/${batch.id}/cancel`, { method: 'POST', body: '{}' }));
      setFiles([]);
      onDone();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la importación.'); }
    finally { setBusy(false); }
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
      <label className={`drop-zone${hasActiveBatch ? ' disabled' : ''}`} aria-disabled={hasActiveBatch} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files); }}><input type="file" accept="application/pdf,.pdf" multiple disabled={hasActiveBatch} onChange={(event) => choose(event.target.files)} /><span className="upload-mark">↑</span><strong>{hasActiveBatch ? 'Hay un lote en curso' : 'Arrastrá tus recibos acá'}</strong><span>{hasActiveBatch ? 'Cuando termine vas a poder iniciar otro' : 'o hacé clic para elegir PDFs'}</span><small>El servidor limita archivos, tamaño total, espacio por cuenta y trabajo simultáneo.</small></label>
      {error && <p className="message error" role="alert">{error}</p>}
      {progress.length > 0 && <section className="panel upload-list" aria-live="polite"><div className="panel-heading"><div><p className="eyebrow">Lote</p><h2>{progress.length} archivo{progress.length === 1 ? '' : 's'}</h2></div>{batch && <span className="batch-id">Lote {batch.id.slice(0, 8)}</span>}</div>{batch && <div className="upload-summary"><progress max={batch.progress.total} value={batch.progress.resolved} aria-label="Progreso del lote" /><strong>{batch.progress.resolved} de {batch.progress.total} resueltos · {batch.progress.percentage}%</strong><small>{batch.totals.PROCESSING ?? 0} procesando · {(batch.totals.UPLOADED ?? 0) + (batch.totals.PENDING_UPLOAD ?? 0)} pendientes · {batch.totals.NEEDS_REVIEW ?? 0} para revisar · {(batch.totals.REJECTED ?? 0) + (batch.totals.FAILED ?? 0)} no procesados</small></div>}<ul>{progress.map((item) => <li key={item.key}><span className="file-icon">PDF</span><span className="upload-name"><strong>{item.name}</strong><small>{item.message ?? (item.status === 'PENDIENTE' ? 'Listo para subir' : 'Enviando…')}</small></span><span className={`upload-state ${item.status.toLowerCase()}`}>{item.status.replace('_', ' ')}</span></li>)}</ul><div className="upload-footer"><p>Los errores de un archivo no detienen el resto del lote.</p>{hasActiveBatch ? (batch.totals.PENDING_UPLOAD ?? 0) > 0 && <button className="button secondary" disabled={busy} onClick={cancelPending}>Cancelar pendientes</button> : <button className="button primary" disabled={busy || !files.length} onClick={start}>{busy ? 'Subiendo…' : 'Iniciar importación'}</button>}</div></section>}
      <aside className="privacy-note"><span aria-hidden="true">◇</span><div><strong>Privado por diseño</strong><p>Los PDFs se guardan con claves opacas. Antes de extraer datos pasan por validación de formato y malware.</p></div></aside>
    </div>
  );
}

function History({ runSensitive }: { runSensitive: RunSensitive }) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<string[]>([]);
  const [employmentChoice, setEmploymentChoice] = useState('');
  const [associating, setAssociating] = useState(false);
  const [selected, setSelected] = useState<DocumentItem | null>(null);
  const [fields, setFields] = useState<ExtractedField[]>([]);
  const [acceptDeductionsMismatch, setAcceptDeductionsMismatch] = useState(false);
  const [tab, setTab] = useState<'settlements' | 'documents'>('settlements');
  const [error, setError] = useState('');
  const selectedId = selected?.id;
  const selectedStatus = selected?.processingStatus;
  const load = useCallback(() => Promise.all([api<DocumentItem[]>('/documents'), api<Settlement[]>('/settlements'), api<Employment[]>('/employments')]).then(([docs, rows, jobs]) => {
    setDocuments(docs);
    setSettlements(rows);
    setEmployments(jobs);
    setCheckedDocumentIds((current) => current.filter((id) => docs.some((document) => document.id === id && associationReadyStatuses.has(document.processingStatus))));
    setSelected((current) => current ? docs.find((document) => document.id === current.id) ?? current : null);
  }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'No pudimos cargar el historial.')), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!documents.some((document) => /UPLOADED|VALIDATION|PROCESSING|RETRY|CLASSIFICATION|EXTRACTION|OCR|PARSING|NORMALIZATION/.test(document.processingStatus))) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [documents, load]);
  useEffect(() => {
    if (!selectedId) return;
    let stopped = false;
    api<{ extractedFields: ExtractedField[] }>(`/documents/${selectedId}`)
      .then((detail) => { if (!stopped) setFields(detail.extractedFields ?? []); })
      .catch((caught: unknown) => { if (!stopped) setError(caught instanceof Error ? caught.message : 'No pudimos abrir el detalle.'); });
    return () => { stopped = true; };
  }, [selectedId, selectedStatus]);

  function openDocument(document: DocumentItem) {
    setSelected(document); setFields([]); setAcceptDeductionsMismatch(false); setError('');
  }
  async function correct(field: ExtractedField, value: string) {
    try {
      await api(`/documents/${selected?.id}/corrections`, {
        method: 'POST',
        body: JSON.stringify({ ...(field.id ? { extractedFieldId: field.id } : { fieldPath: field.fieldPath }), correctedValue: value }),
      });
      setFields((current) => current.map((item) => item.fieldPath === field.fieldPath ? { ...item, correctedValue: value } : item));
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos guardar la corrección.'); }
  }
  async function deleteOriginal() {
    if (!selected || !confirm('¿Eliminar el PDF original? Los datos estructurados se conservarán.')) return;
    try { await runSensitive(async () => { await api(`/documents/${selected.id}/original`, { method: 'DELETE', body: '{}' }); setSelected({ ...selected, originalAvailable: false }); await load(); }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos eliminar el original.'); }
  }
  async function downloadOriginal() {
    if (!selected) return;
    try {
      await runSensitive(async () => {
        const download = await api<{ url: string }>(`/documents/${selected.id}/original`);
        const anchor = document.createElement('a');
        anchor.href = download.url;
        anchor.rel = 'noreferrer';
        anchor.click();
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos descargar el original.'); }
  }
  async function deleteDocument() {
    if (!selected || !confirm('¿Eliminar el PDF y todos sus datos extraídos? Esta acción no se puede deshacer.')) return;
    try { await runSensitive(async () => { await api(`/documents/${selected.id}`, { method: 'DELETE', body: '{}' }); setSelected(null); await load(); }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos eliminar el documento.'); }
  }
  async function confirmType(documentType: 'PAYROLL' | 'UNSUPPORTED') {
    if (!selected) return;
    try {
      const result = await api<{ processingStatus: string }>(`/documents/${selected.id}/type-confirmation`, {
        method: 'POST', body: JSON.stringify({ documentType }),
      });
      setSelected({ ...selected, processingStatus: result.processingStatus });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos guardar la confirmación.'); }
  }
  async function completeReview() {
    if (!selected) return;
    try {
      const result = await api<{ processingStatus: string }>(`/documents/${selected.id}/review-complete`, {
        method: 'POST',
        body: JSON.stringify({ acceptDeductionsMismatch }),
      });
      setSelected({ ...selected, processingStatus: result.processingStatus });
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos finalizar la revisión.'); }
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
      setCheckedDocumentIds([]); setEmploymentChoice(''); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos asociar los documentos.'); }
    finally { setAssociating(false); }
  }

  const assignableDocuments = documents.filter((document) => associationReadyStatuses.has(document.processingStatus));
  const allAssignableSelected = assignableDocuments.length > 0
    && assignableDocuments.every((document) => checkedDocumentIds.includes(document.id));
  const missingReviewFields = fields.filter((field) => field.source === 'MANUAL_REQUIRED' && !field.correctedValue);
  const selectedSettlement = settlements.find((settlement) => settlement.documentId === selected?.id);

  return (
    <div className="page">
      <PageHeader eyebrow="Datos estructurados" title="Historial salarial" />
      <div className="tabs" role="tablist"><button role="tab" aria-selected={tab === 'settlements'} className={tab === 'settlements' ? 'active' : ''} onClick={() => setTab('settlements')}>Liquidaciones</button><button role="tab" aria-selected={tab === 'documents'} className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documentos</button></div>
      {error && <p className="message error" role="alert">{error}</p>}
      {tab === 'documents' && documents.length > 0 && <div className="bulk-association"><label><input type="checkbox" checked={allAssignableSelected} onChange={(event) => setCheckedDocumentIds(event.target.checked ? assignableDocuments.map(({ id }) => id) : [])} />Seleccionar todos</label><span>{checkedDocumentIds.length} seleccionado{checkedDocumentIds.length === 1 ? '' : 's'}</span><select aria-label="Empleo para asociar" value={employmentChoice} onChange={(event) => setEmploymentChoice(event.target.value)}><option value="">Elegí un empleo</option>{employments.map((employment) => <option key={employment.id} value={employment.id}>{employment.employerName}{employment.role ? ` · ${employment.role}` : ''}</option>)}<option value="none">Quitar asociación</option></select><button className="button primary compact" disabled={!checkedDocumentIds.length || !employmentChoice || associating} onClick={associateDocuments}>{associating ? 'Guardando…' : 'Aplicar'}</button></div>}
      {tab === 'settlements' ? (settlements.length ? <div className="table-wrap"><table><thead><tr><th>Período</th><th>Empresa</th><th>Tipo</th><th>Bruto</th><th>Descuentos</th><th>Neto</th></tr></thead><tbody>{settlements.map((row) => <tr key={row.id}><td>{row.payrollPeriod.slice(0, 7)}</td><td>{row.employerName || 'Sin asociar'}</td><td>{row.settlementType}</td><td>{money(row.grossAmount, row.currencyCode)}</td><td><DeductionBreakdown settlement={row} /></td><td><strong>{money(row.netAmount, row.currencyCode)}</strong></td></tr>)}</tbody></table></div> : <EmptyState title="Todavía no hay liquidaciones" body="Cuando el worker termine de analizar tus recibos, aparecerán acá." />) : (documents.length ? <div className="document-list">{documents.map((document) => { const assignable = associationReadyStatuses.has(document.processingStatus); return <div className="document-entry" key={document.id}><label className="document-check" title={assignable ? 'Seleccionar documento' : 'Disponible cuando termine el procesamiento'}><input type="checkbox" aria-label={`Seleccionar ${documentName(document)}`} disabled={!assignable} checked={checkedDocumentIds.includes(document.id)} onChange={(event) => setCheckedDocumentIds((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} /></label><button className="document-row" onClick={() => openDocument(document)}><span className="file-icon">PDF</span><span><strong>{documentName(document)}</strong><small>{shortDate(document.createdAt)} · {document.documentType || 'Clasificando'}{document.errorCode ? ` · ${importErrorLabels[document.errorCode] ?? document.errorCode}` : ''}</small></span><Status value={document.processingStatus} /><span aria-hidden="true">›</span></button></div>; })}</div> : <EmptyState title="No hay documentos" body="Importá PDFs para ver su estado y revisar los campos extraídos." />)}
      {selected && <div className="modal-layer" role="presentation" onMouseDown={() => setSelected(null)}><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="review-title" tabIndex={-1} autoFocus onKeyDown={(event) => handleDialogKey(event, () => setSelected(null))} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p className="eyebrow">Revisión humana</p><h2 id="review-title">{documentName(selected)}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Cerrar">×</button></div><div className="review-summary"><Status value={selected.processingStatus} /><span>{selected.errorCode ? importErrorLabels[selected.errorCode] ?? selected.errorCode : missingReviewFields.length ? `Falta completar: ${missingReviewFields.map((field) => reviewFieldLabels[field.fieldPath] ?? field.fieldPath).join(', ')}.` : selectedSettlement?.totalsBalance === false ? 'Bruto menos descuentos no coincide con neto; corregí uno de los importes.' : selectedSettlement?.deductionsMatchTotal === false ? 'El desglose no coincide con el total; revisá los valores y confirmá la diferencia.' : 'Tus correcciones quedan guardadas en esta extracción.'}</span></div>{selected.processingStatus === 'NEEDS_TYPE_CONFIRMATION' ? <div className="type-confirmation"><h3>¿Este PDF es un recibo de sueldo?</h3><p>La clasificación automática no fue concluyente. Confirmalo para continuar con la extracción.</p><div><button className="button primary" onClick={() => confirmType('PAYROLL')}>Sí, es un recibo</button><button className="button secondary" onClick={() => confirmType('UNSUPPORTED')}>No corresponde</button></div></div> : fields.length ? <div className="field-list">{fields.map((field) => <FieldEditor key={field.fieldPath} field={field} onSave={(value) => correct(field, value)} />)}</div> : <EmptyState title="Sin campos disponibles" body="El documento todavía está procesándose o no produjo datos utilizables." />}{selected.processingStatus === 'NEEDS_REVIEW' && selectedSettlement?.deductionsMatchTotal === false && <label className="review-acceptance"><input type="checkbox" checked={acceptDeductionsMismatch} onChange={(event) => setAcceptDeductionsMismatch(event.target.checked)} />Revisé los conceptos y acepto esta diferencia.</label>}<div className="modal-actions">{selected.processingStatus === 'NEEDS_REVIEW' && <button className="button primary" disabled={missingReviewFields.length > 0 || selectedSettlement?.totalsBalance === false || (selectedSettlement?.deductionsMatchTotal === false && !acceptDeductionsMismatch)} onClick={completeReview}>Finalizar revisión</button>}<button className="button secondary" disabled={selected.originalAvailable === false} onClick={downloadOriginal}>Descargar PDF</button><button className="button danger-button" disabled={selected.originalAvailable === false || !associationReadyStatuses.has(selected.processingStatus)} onClick={deleteOriginal}>{selected.originalAvailable === false ? 'Original eliminado' : 'Eliminar sólo el PDF'}</button><button className="button danger-button" onClick={deleteDocument}>Eliminar PDF y datos</button><button className="button secondary" onClick={() => setSelected(null)}>Cerrar</button></div></section></div>}
    </div>
  );
}

function FieldEditor({ field, onSave }: { field: ExtractedField; onSave: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(field.correctedValue ?? field.interpretedValue ?? '');
  const [busy, setBusy] = useState(false);
  const confidence = Math.round(Number(field.confidence) * 100);
  const editable = editableCorrectionPaths.has(field.fieldPath);
  const missingReasonMessage = field.missingReason ? missingReasonMessages[field.missingReason] : null;
  const editor = field.fieldPath === 'settlement.type'
    ? <select value={value} onChange={(event) => setValue(event.target.value)}>{settlementTypeOptions.map((type) => <option key={type}>{type}</option>)}</select>
    : <input disabled={!editable} type={field.fieldPath === 'settlement.payrollPeriod' ? 'month' : 'text'} inputMode={field.fieldPath.includes('Amount') ? 'decimal' : undefined} value={value} onChange={(event) => setValue(event.target.value)} />;
  return <div className="field-editor"><label><span>{reviewFieldLabels[field.fieldPath] ?? field.fieldPath}</span>{editor}</label><span className={`confidence ${confidence < 70 ? 'low' : ''}`}>{field.source === 'MANUAL_REQUIRED' ? field.correctedValue ? 'Manual' : 'Falta' : Number.isFinite(confidence) ? `${confidence}%` : '—'}</span><small>{field.correctedValue ? 'Corregido por vos' : missingReasonMessage ?? (!editable ? 'Sólo lectura' : field.source === 'MANUAL_REQUIRED' ? 'Completalo manualmente' : field.source)}</small>{editable && <button className="button compact" disabled={busy || !value.trim() || value === (field.correctedValue ?? field.interpretedValue ?? '')} onClick={async () => { setBusy(true); await onSave(value); setBusy(false); }}>Guardar</button>}</div>;
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
      </> : status ? <><p>Usá una app autenticadora compatible con códigos TOTP.</p><MfaEnrollment pending={status.pendingEnrollment} onComplete={refresh} /></> : null}
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
    setError('');
    try { await runSensitive(async () => { setExportJob(await api('/privacy/exports', { method: 'POST', body: '{}' })); setMessage('Tu exportación quedó lista para descargar.'); }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos iniciar la exportación.'); }
  }
  async function refreshExport() {
    if (!exportJob) return;
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
    setError('');
    try { await runSensitive(() => downloadApiFile(exportJob.downloadUrl!, 'salarivo-export.json')); }
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
      {error && <p className="message error" role="alert">{error}</p>}{message && <p className="message success" aria-live="polite">{message}</p>}
      <MfaSettings key={String(user.mfaEnabled)} onUserChanged={onUserChanged} runSensitive={runSensitive} />
      <section className="settings-card"><div className="setting-icon">↪</div><div><h2>Sesiones activas</h2><p>Cerrá las sesiones abiertas en otros navegadores o dispositivos. Esta sesión seguirá activa.</p></div><div className="setting-actions"><button className="button secondary" onClick={revokeOtherSessions}>Cerrar otras sesiones</button></div></section>
      <section className="settings-card"><div className="setting-icon">⇩</div><div><h2>Exportar mis datos</h2><p>Generá un JSON con tu cuenta, empleos, importaciones, documentos, extracciones, liquidaciones, correcciones y constancias de privacidad. Los PDFs y secretos no se incluyen.</p>{exportJob && <p className="job-status">Estado: <strong>{exportJob.status}</strong></p>}</div><div className="setting-actions">{exportJob?.downloadUrl ? <button className="button primary" onClick={downloadExport}>Descargar</button> : exportJob ? <button className="button secondary" onClick={refreshExport}>Actualizar estado</button> : <button className="button secondary" onClick={requestExport}>Solicitar exportación</button>}</div></section>
      <section className="settings-card"><div className="setting-icon">◇</div><div><h2>Originales y datos estructurados</h2><p>Desde Historial podés borrar un PDF y conservar la liquidación revisada. Cada lifecycle es independiente.</p></div></section>
      <section className="settings-card"><div className="setting-icon">§</div><div><h2>Documentos legales</h2><p>Consultá la versión vigente de los <a className="inline-link" href="/terms" target="_blank" rel="noreferrer">Términos de uso</a> y el <a className="inline-link" href="/privacy" target="_blank" rel="noreferrer">Aviso de privacidad</a>.</p></div></section>
      {user.role === 'ADMIN'
        ? <section className="settings-card"><div className="setting-icon">!</div><div><h2>Baja de una cuenta administrativa</h2><p>Para preservar el último acceso de gobierno, otra persona con permiso debe retirar primero tu rol administrativo. Después podés solicitar la eliminación como usuario.</p></div></section>
        : <section className="settings-card danger-zone"><div className="setting-icon">!</div><div><h2>Eliminar mi cuenta</h2><p>Inicia el borrado irreversible de documentos, datos estructurados, sesiones y exportaciones.</p><label>Escribí <strong>ELIMINAR</strong> para confirmar<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label></div><div className="setting-actions"><button className="button danger-button" disabled={confirmation !== 'ELIMINAR'} onClick={deleteAccount}>Eliminar cuenta</button></div></section>}
    </div>
  );
}
