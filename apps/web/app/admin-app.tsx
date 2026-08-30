'use client';

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const API_ROOT = process.env.NEXT_PUBLIC_API_BASE_URL
  ?? (process.env.NODE_ENV === 'production' ? '/api/v1' : 'http://localhost:3001/api/v1');

type AdminRole = 'SUPER_ADMIN' | 'OPERATIONS' | 'SUPPORT' | 'SECURITY' | 'FINANCE' | 'READ_ONLY';
type Permission =
  | 'dashboard.read' | 'users.read_metadata' | 'users.read_contact' | 'users.status.update'
  | 'sessions.revoke' | 'documents.read_metadata' | 'documents.quarantine'
  | 'employers.read_metadata' | 'processing.read' | 'processing.retry' | 'processing.cancel'
  | 'storage.read' | 'privacy.read' | 'security.read' | 'audit.read' | 'settings.read'
  | 'system.health.read' | 'roles.manage';
type SessionUser = {
  id: string;
  displayName: string | null;
  email: string;
  role: 'USER' | 'ADMIN';
  adminRole: AdminRole | null;
  permissions: Permission[];
};
type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };
type Overview = {
  range: 'TODAY' | '7D' | '30D';
  metrics: {
    totalUsers: number; activeUsers: number; totalDocuments: number; pendingReview: number;
    activeImports: number; failedDocuments: number;
  };
  activity: {
    newUsers: number; documentsCreated: number; completedDocuments: number; failedJobs: number;
    retryableJobs: number; quarantinedDocuments: number; pendingPrivacyOperations: number;
  };
};
type AdminUser = {
  id: string; maskedEmail: string; status: string; role: 'USER' | 'ADMIN'; adminRole: AdminRole | null;
  mfaEnabled: boolean; activeSessions: number; documentCount: number; employerCount?: number;
  storageBytes?: number; createdAt: string; lastLoginAt?: string | null;
};
type UserDetail = {
  user: AdminUser;
  employments: Array<{ id: string; employerId: string; employerName: string; status: string; startDate: string; endDate: string | null; countryCode: string }>;
  recentDocuments: Array<{ id: string; documentType: string | null; processingStatus: string; securityStatus: string; sizeBytes: number; createdAt: string }>;
};
type AdminDocument = {
  id: string; userId: string; maskedEmail: string; documentType: string | null; processingStatus: string; securityStatus: string;
  classificationStatus: string; sizeBytes: number; pageCount: number | null; retentionPolicy: string;
  originalAvailable: boolean; createdAt: string; processedAt: string | null;
};
type AdminJob = {
  id: string; documentId: string; userId: string; stage: string; state: string; attempt: number; maxAttempts: number;
  errorCode: string | null; processingVersion: number; availableAt: string; createdAt: string; updatedAt: string;
  startedAt: string | null; completedAt: string | null;
};
type DocumentDetail = {
  document: AdminDocument;
  employmentId: string | null;
  importBatchId: string;
  recentJobs: Array<Pick<AdminJob, 'id' | 'stage' | 'processingVersion' | 'state' | 'attempt' | 'maxAttempts' | 'errorCode' | 'updatedAt'>>;
};
type AdminEmployer = {
  id: string; userId: string; name: string; countryCode: string; employmentCount: number;
  activeEmploymentCount: number; createdAt: string; updatedAt: string;
};
type StorageData = {
  summary: { totalOriginalBytes: number; documentCount: number; usersWithOriginals: number; pendingDeletions: number; quotaBytesPerUser: number };
  items: Array<{ userId: string; originalBytes: number; documentCount: number; largestDocumentBytes: number; quotaBytes: number; usagePercent: number; anomalyFlags: string[] }>;
  page: number; pageSize: number; total: number;
};
type PrivacyOperation = { id: string; userId: string; maskedEmail: string; operationType: string; status: string; hasOutput: boolean; outputExpiresAt: string | null; errorCode: string | null; createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null };
type SecurityData = { activeSessions: number; recentlyRevokedSessions: number; adminsWithoutMfa: number; suspendedUsers: number; blockedUsers: number; quarantinedDocuments: number; securityErrors: number; adminMutations24h: number };
type AuditEvent = { id: string; actorUserId: string; actorAdminRole: AdminRole; action: string; resourceType: string; resourceId: string | null; result: string; reasonCode: string | null; reference: string | null; createdAt: string };
type RoleDefinition = { role: AdminRole; permissions: Permission[] };
type SettingsData = { environment: string; authentication: Record<string, unknown>; limits: Record<string, unknown>; storage: Record<string, unknown>; features: Record<string, unknown> };
type HealthData = { overall: 'HEALTHY' | 'DEGRADED'; components: Record<string, 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'>; checkedAt: string };

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiError(body.error?.message ?? 'No pudimos completar la operación.', response.status, body.error?.code ?? 'REQUEST_FAILED');
  return body.data as T;
}

function useRemote<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    api<T>(path).then((result) => { if (active) setData(result); }).catch((caught) => {
      if (active) setError(caught instanceof ApiError && caught.status === 403
        ? 'No tenés permiso para ver esta sección con tu rol actual.'
        : caught instanceof Error ? caught.message : 'No pudimos cargar esta sección.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, version]);
  return { data, error, loading, reload: () => { setError(''); setLoading(true); setVersion((current) => current + 1); } };
}

const dateFormatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' });
const numberFormatter = new Intl.NumberFormat('es-AR');
function date(value: string | null | undefined) { return value ? dateFormatter.format(new Date(value)) : 'Sin registro'; }
function bytes(value: number | null | undefined) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${units[unit]}`;
}
function shortId(value: string) { return `${value.slice(0, 8)}…`; }
function tone(status: string) {
  if (['ACTIVE', 'READY', 'SUCCEEDED', 'PROCESSED', 'COMPLETED', 'HEALTHY', 'SUCCESS', 'CLEAN'].includes(status)) return 'ready';
  if (['FAILED', 'FAILED_PERMANENT', 'ERROR', 'REJECTED', 'REJECTED_UNSUPPORTED', 'BLOCKED', 'DOWN', 'UNAVAILABLE', 'QUARANTINED', 'OVER_QUOTA', 'CANCELLED'].includes(status)) return 'danger';
  if (['PENDING', 'PUBLISHED', 'PROCESSING', 'RUNNING', 'RETRYABLE', 'FAILED_RETRYABLE', 'RETRY_SCHEDULED', 'DEGRADED', 'SUSPENDED', 'NEAR_QUOTA'].includes(status)) return 'pending';
  return '';
}

const navigation: Array<{ label: string; href: string; permission: Permission; mark: string }> = [
  { label: 'Panel', href: '/admin', permission: 'dashboard.read', mark: '01' },
  { label: 'Usuarios', href: '/admin/users', permission: 'users.read_metadata', mark: '02' },
  { label: 'Documentos', href: '/admin/documents', permission: 'documents.read_metadata', mark: '03' },
  { label: 'Empleadores', href: '/admin/employers', permission: 'employers.read_metadata', mark: '04' },
  { label: 'Procesamiento', href: '/admin/processing', permission: 'processing.read', mark: '05' },
  { label: 'Storage', href: '/admin/storage', permission: 'storage.read', mark: '06' },
  { label: 'Privacidad', href: '/admin/privacy', permission: 'privacy.read', mark: '07' },
  { label: 'Seguridad', href: '/admin/security', permission: 'security.read', mark: '08' },
  { label: 'Auditoría', href: '/admin/audit', permission: 'audit.read', mark: '09' },
  { label: 'Accesos', href: '/admin/access', permission: 'roles.manage', mark: '10' },
  { label: 'Sistema', href: '/admin/system', permission: 'system.health.read', mark: '11' },
];

function StatusBadge({ value }: { value: string }) { return <span className={`status ${tone(value)}`}>{value.replaceAll('_', ' ')}</span>; }
function LoadingState() { return <div className="admin-loading" role="status"><span className="loader" />Cargando datos operativos…</div>; }
function ErrorState({ message, retry }: { message: string; retry?: () => void }) { const denied = message.startsWith('No tenés permiso'); return <div className="message error" role="alert"><strong>{denied ? 'Acceso denegado.' : 'No pudimos mostrar esta sección.'}</strong><br />{message}{retry && !denied && <><br /><button className="text-button danger-text" onClick={retry}>Reintentar</button></>}</div>; }
function EmptyState({ children }: { children: ReactNode }) { return <div className="admin-empty"><span aria-hidden="true">✓</span><strong>{children}</strong><small>No hay trabajo operativo para mostrar con estos filtros.</small></div>; }
function PageHeader({ eyebrow, title, description, actions, crumbs }: { eyebrow: string; title: string; description: string; actions?: ReactNode; crumbs?: Array<[string, string?]> }) {
  return <div className="admin-page-head"><div>{crumbs && <nav className="breadcrumbs" aria-label="Ruta">{crumbs.map(([label, href], index) => <span key={`${label}-${index}`}>{href ? <a href={href}>{label}</a> : label}</span>)}</nav>}<p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions && <div className="admin-head-actions">{actions}</div>}</div>;
}

function QueryFilters({ action, search, children }: { action: string; search: URLSearchParams; children?: ReactNode }) {
  return <form className="admin-filters" action={action} method="get" role="search" onSubmit={(event) => {
    for (const field of Array.from(event.currentTarget.elements)) {
      if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement) && field.value === '') field.disabled = true;
    }
  }}>
    <label>Buscar<input name="search" defaultValue={search.get('search') ?? ''} placeholder="UUID exacto" /></label>
    {children}
    <button className="button secondary" type="submit">Aplicar filtros</button>
    {search.size > 0 && <a className="text-button" href={action}>Limpiar</a>}
  </form>;
}
function SelectFilter({ name, label, values, search }: { name: string; label: string; values: string[]; search: URLSearchParams }) {
  return <label>{label}<select name={name} defaultValue={search.get(name) ?? ''}><option value="">Todos</option>{values.map((value) => <option key={value}>{value}</option>)}</select></label>;
}
function Pagination({ result, path, search }: { result: { page: number; pageSize: number; total: number }; path: string; search: URLSearchParams }) {
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  function href(page: number) { const next = new URLSearchParams(search); next.set('page', String(page)); return `${path}?${next}`; }
  return <nav className="admin-pagination" aria-label="Paginación"><span>{numberFormatter.format(result.total)} resultados · página {result.page} de {pages}</span><div>{result.page > 1 && <a className="button secondary compact" href={href(result.page - 1)}>Anterior</a>}{result.page < pages && <a className="button secondary compact" href={href(result.page + 1)}>Siguiente</a>}</div></nav>;
}

const reasons = ['SUPPORT_REQUEST', 'SECURITY_INCIDENT', 'ABUSE_PREVENTION', 'USER_REQUEST', 'OPERATIONAL_RECOVERY', 'ROLE_ADMINISTRATION'] as const;
type AdminAction = { title: string; description: string; button: string; execute: (reasonCode: string, reference: string) => Promise<string> };
function ActionDialog({ action, onClose, onDone }: { action: AdminAction; onClose: () => void; onDone: (message: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [pending, setPending] = useState<{ reasonCode: string; reference: string } | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (stepUp && pending) {
        await api('/auth/step-up', { method: 'POST', body: JSON.stringify({ code: String(form.get('code') ?? '') }) });
        onDone(await action.execute(pending.reasonCode, pending.reference)); return;
      }
      const values = { reasonCode: String(form.get('reasonCode') ?? ''), reference: String(form.get('reference') ?? '') };
      try { onDone(await action.execute(values.reasonCode, values.reference)); }
      catch (caught) {
        if (caught instanceof ApiError && caught.code === 'STEP_UP_REQUIRED') { setPending(values); setStepUp(true); return; }
        throw caught;
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos completar la acción.'); }
    finally { setBusy(false); }
  }
  return <dialog className="admin-dialog" ref={ref} onCancel={onClose} onClose={onClose} aria-labelledby="admin-dialog-title" aria-describedby="admin-dialog-description">
    <form onSubmit={submit}>
      <div className="modal-head"><div><p className="eyebrow">Acción auditada</p><h2 id="admin-dialog-title">{stepUp ? 'Confirmá tu identidad' : action.title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar">×</button></div>
      <p id="admin-dialog-description">{stepUp ? 'Ingresá el código de tu segundo factor para continuar con la misma acción.' : action.description}</p>
      {stepUp ? <label>Código MFA<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus /></label> : <>
        <label>Motivo<select name="reasonCode" required defaultValue=""><option value="" disabled>Seleccionar motivo</option>{reasons.map((reason) => <option key={reason}>{reason}</option>)}</select></label>
        <label>Referencia o ticket<input name="reference" required minLength={3} maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9._:/-]*" placeholder="SUP-1234" /></label>
      </>}
      {error && <p className="message error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Procesando…' : stepUp ? 'Confirmar' : action.button}</button></div>
    </form>
  </dialog>;
}

function DashboardPage({ search }: { search: URLSearchParams }) {
  const range = ['TODAY', '7D', '30D'].includes(search.get('range') ?? '') ? search.get('range')! : '7D';
  const state = useRemote<Overview>(`/admin/overview?range=${range}`);
  if (state.loading) return <><PageHeader eyebrow="Operación segura" title="Estado de la plataforma" description="Métricas accionables sin contenido laboral o salarial." /><LoadingState /></>;
  if (state.error || !state.data) return <><PageHeader eyebrow="Operación segura" title="Estado de la plataforma" description="Métricas accionables sin contenido laboral o salarial." /><ErrorState message={state.error} retry={state.reload} /></>;
  const { metrics, activity } = state.data;
  const cards: Array<[string, string | number, string]> = [
    ['Usuarios activos', metrics.activeUsers, `${metrics.totalUsers} cuentas totales`],
    ['Nuevos registros', activity.newUsers, `rango ${range}`],
    ['Documentos', metrics.totalDocuments, `${activity.documentsCreated} cargados en el rango`],
    ['Procesados', activity.completedDocuments, `${metrics.pendingReview} en revisión`],
    ['Fallos', metrics.failedDocuments, `${activity.failedJobs} jobs fallidos`],
    ['Reintentables', activity.retryableJobs, `${metrics.activeImports} importaciones activas`],
    ['Cuarentena', activity.quarantinedDocuments, 'aislados del pipeline'],
    ['Privacidad', activity.pendingPrivacyOperations, 'operaciones pendientes'],
  ];
  return <><PageHeader eyebrow="Operación segura" title="Estado de la plataforma" description="Métricas accionables sin salarios, PDFs, OCR ni nombres de archivo." actions={<form action="/admin"><label className="compact-field">Rango<select name="range" defaultValue={range} onChange={(event) => event.currentTarget.form?.requestSubmit()}><option value="TODAY">Hoy</option><option value="7D">7 días</option><option value="30D">30 días</option></select></label></form>} />
    <section className="admin-kpi-grid" aria-label="Indicadores administrativos">{cards.map(([label, value, detail]) => <article className="admin-kpi" key={label}><small>{label}</small><strong>{typeof value === 'number' ? numberFormatter.format(value) : value}</strong><span>{detail}</span></article>)}</section>
    <section className="admin-workbench"><div><p className="eyebrow">Prioridad operativa</p><h2>Trabajo que requiere atención</h2><p>Fallos, revisiones y abuso antes que gráficos decorativos.</p></div><Link className="admin-signal" href="/admin/processing?state=RETRYABLE"><span>Procesamiento</span><strong>{activity.failedJobs ? `${activity.failedJobs} jobs para diagnosticar` : 'Sin fallos pendientes'}</strong></Link><Link className="admin-signal" href="/admin/documents?securityStatus=QUARANTINED"><span>Seguridad</span><strong>{activity.quarantinedDocuments ? `${activity.quarantinedDocuments} documentos aislados` : 'Sin cuarentenas activas'}</strong></Link></section>
  </>;
}

function UsersPage({ search }: { search: URLSearchParams }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<AdminUser>>(`/admin/users?${query}`);
  return <><PageHeader eyebrow="Cuentas" title="Usuarios" description="Metadata de cuenta y uso. El email completo requiere acceso excepcional auditado." />
    <QueryFilters action="/admin/users" search={search}><SelectFilter name="status" label="Estado" values={['ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETION_PENDING', 'DELETED']} search={search} /><SelectFilter name="role" label="Acceso" values={['USER', 'ADMIN']} search={search} /><SelectFilter name="sort" label="Orden" values={['createdAt', 'status', 'documents', 'lastLoginAt']} search={search} /><SelectFilter name="direction" label="Dirección" values={['desc', 'asc']} search={search} /></QueryFilters>
    {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No encontramos usuarios.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Cuenta</th><th>Estado</th><th>Acceso</th><th>MFA</th><th>Sesiones</th><th>Documentos</th><th>Alta</th><th><span className="sr-only">Acción</span></th></tr></thead><tbody>{state.data.items.map((user) => <tr key={user.id}><td data-label="Cuenta"><a className="entity-link" href={`/admin/users/${user.id}`}><strong>{user.maskedEmail}</strong><small>{shortId(user.id)}</small></a></td><td data-label="Estado"><StatusBadge value={user.status} /></td><td data-label="Acceso">{user.adminRole ?? user.role}</td><td data-label="MFA">{user.mfaEnabled ? 'Activo' : 'No activo'}</td><td data-label="Sesiones">{user.activeSessions}</td><td data-label="Documentos">{user.documentCount}</td><td data-label="Alta">{date(user.createdAt)}</td><td data-label="Acción"><a className="button compact secondary" href={`/admin/users/${user.id}`}>Ver</a></td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/users" search={search} /></>}
  </>;
}

function UserPage({ id, search, permissions, currentUserId }: { id: string; search: URLSearchParams; permissions: Permission[]; currentUserId: string }) {
  const state = useRemote<UserDetail>(`/admin/users/${id}`);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [notice, setNotice] = useState('');
  const [contact, setContact] = useState('');
  const [roleChoice, setRoleChoice] = useState('');
  const requestedTab = ['account', 'employments', 'documents', 'security'].includes(search.get('tab') ?? '') ? search.get('tab')! : 'account';
  const tab = requestedTab === 'employments' && !permissions.includes('employers.read_metadata') ? 'account' : requestedTab;
  function mutation(title: string, description: string, button: string, path: string, method: string, extra: Record<string, string>) {
    setAction({ title, description, button, execute: async (reasonCode, reference) => { await api(path, { method, body: JSON.stringify({ ...extra, reasonCode, reference }) }); return `${title}: acción completada y auditada.`; } });
  }
  function finished(message: string) { setAction(null); setNotice(message); state.reload(); }
  if (state.loading) return <><PageHeader eyebrow="Usuarios" title="Detalle de cuenta" description="Cargando metadata autorizada…" crumbs={[["Admin", "/admin"], ["Usuarios", "/admin/users"], [shortId(id)]]} /><LoadingState /></>;
  if (state.error || !state.data) return <><PageHeader eyebrow="Usuarios" title="Detalle de cuenta" description="No se pudo recuperar la cuenta." crumbs={[["Admin", "/admin"], ["Usuarios", "/admin/users"], [shortId(id)]]} /><ErrorState message={state.error} retry={state.reload} /></>;
  const { user } = state.data;
  return <><PageHeader eyebrow="Usuarios" title={user.maskedEmail} description={`Cuenta ${shortId(user.id)} · creada ${date(user.createdAt)}`} crumbs={[["Admin", "/admin"], ["Usuarios", "/admin/users"], [shortId(id)]]} actions={<StatusBadge value={user.status} />} />
    {notice && <p className="message success" aria-live="polite">{notice}</p>}
    <nav className="admin-tabs" aria-label="Secciones del usuario">{[['account', 'Cuenta'], ['employments', 'Empleos'], ['documents', 'Documentos'], ['security', 'Seguridad']].filter(([key]) => key !== 'employments' || permissions.includes('employers.read_metadata')).map(([key, label]) => <a key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} href={`/admin/users/${id}?tab=${key}`}>{label}</a>)}</nav>
    {tab === 'account' && <div className="admin-detail-grid"><section className="admin-card"><h2>Cuenta</h2><dl className="admin-definition"><div><dt>ID</dt><dd>{user.id}</dd></div><div><dt>Email</dt><dd>{contact || user.maskedEmail}</dd></div><div><dt>Estado</dt><dd><StatusBadge value={user.status} /></dd></div><div><dt>Acceso</dt><dd>{user.adminRole ?? user.role}</dd></div><div><dt>Documentos</dt><dd>{user.documentCount}</dd></div><div><dt>Último acceso</dt><dd>{date(user.lastLoginAt)}</dd></div></dl>{permissions.includes('users.read_contact') && id !== currentUserId && !contact && <button className="button secondary" onClick={() => setAction({ title: 'Acceder al email completo', description: 'Este acceso excepcional revela un dato de contacto y queda auditado.', button: 'Revelar email', execute: async (reasonCode, reference) => { const result = await api<{ email: string }>(`/admin/users/${id}/contact?reasonCode=${encodeURIComponent(reasonCode)}&reference=${encodeURIComponent(reference)}`); setContact(result.email); return 'Email revelado para esta vista y acceso auditado.'; } })}>Revelar email con motivo</button>}</section>
      <section className="admin-card"><h2>Acciones permitidas</h2><p>Las acciones críticas exigen motivo, referencia y validación server-side.</p><div className="admin-action-list">{permissions.includes('users.status.update') && id !== currentUserId && user.status === 'ACTIVE' && <><button className="button secondary" onClick={() => mutation('Suspender cuenta', 'Impide nuevos accesos sin iniciar una eliminación de privacidad.', 'Suspender', `/admin/users/${id}/status`, 'POST', { status: 'SUSPENDED' })}>Suspender</button><button className="button danger-button" onClick={() => mutation('Bloquear cuenta', 'Bloquea la cuenta por una causa de seguridad o abuso.', 'Bloquear', `/admin/users/${id}/status`, 'POST', { status: 'BLOCKED' })}>Bloquear</button></>}{permissions.includes('users.status.update') && id !== currentUserId && ['SUSPENDED', 'BLOCKED'].includes(user.status) && <button className="button primary" onClick={() => mutation('Reactivar cuenta', 'Restablece el acceso de esta cuenta.', 'Reactivar', `/admin/users/${id}/status`, 'POST', { status: 'ACTIVE' })}>Reactivar</button>}{permissions.includes('sessions.revoke') && id !== currentUserId && <button className="button secondary" onClick={() => mutation('Cerrar sesiones', 'Revoca todas las sesiones activas de esta cuenta.', 'Cerrar sesiones', `/admin/users/${id}/revoke-sessions`, 'POST', {})}>Cerrar sesiones</button>} {!permissions.includes('users.status.update') && !permissions.includes('sessions.revoke') && <small>Tu rol es de consulta para esta cuenta.</small>}</div>{permissions.includes('roles.manage') && id !== currentUserId && <div className="admin-role-control"><label>Acceso<select value={roleChoice || user.adminRole || user.role} onChange={(event) => setRoleChoice(event.target.value)}><option value="USER">USER</option>{(['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'SECURITY', 'FINANCE', 'READ_ONLY'] as AdminRole[]).map((role) => <option key={role}>{role}</option>)}</select></label><button className="button secondary" disabled={(roleChoice || user.adminRole || user.role) === (user.adminRole || user.role)} onClick={() => { const selected = roleChoice || user.adminRole || user.role; setAction({ title: 'Cambiar rol de acceso', description: 'Revoca todas las sesiones del usuario. Para ser administrador la cuenta debe estar activa y tener MFA.', button: 'Cambiar rol', execute: async (reasonCode, reference) => { await api(`/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: selected === 'USER' ? 'USER' : 'ADMIN', adminRole: selected === 'USER' ? null : selected, reasonCode, reference }) }); return 'Rol actualizado; las sesiones anteriores fueron revocadas.'; } }); }}>Aplicar rol</button></div>}</section></div>}
    {tab === 'employments' && (!state.data.employments.length ? <EmptyState>Este usuario no tiene empleos registrados.</EmptyState> : <div className="admin-card-grid">{state.data.employments.map((employment) => <article className="admin-card" key={employment.id}><StatusBadge value={employment.status} /><h2>{employment.employerName}</h2><p>{employment.startDate} — {employment.endDate ?? 'Actualidad'}</p><small>{employment.countryCode} · empleador {shortId(employment.employerId)}</small></article>)}</div>)}
    {tab === 'documents' && (!state.data.recentDocuments.length ? <EmptyState>No hay documentos recientes.</EmptyState> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>ID</th><th>Tipo</th><th>Procesamiento</th><th>Seguridad</th><th>Tamaño</th><th>Carga</th></tr></thead><tbody>{state.data.recentDocuments.map((document) => <tr key={document.id}><td data-label="ID"><a className="entity-link" href={`/admin/documents/${document.id}`}>{shortId(document.id)}</a></td><td data-label="Tipo">{document.documentType ?? 'Sin confirmar'}</td><td data-label="Procesamiento"><StatusBadge value={document.processingStatus} /></td><td data-label="Seguridad"><StatusBadge value={document.securityStatus} /></td><td data-label="Tamaño">{bytes(document.sizeBytes)}</td><td data-label="Carga">{date(document.createdAt)}</td></tr>)}</tbody></table></div>)}
    {tab === 'security' && <section className="admin-card"><h2>Seguridad de la cuenta</h2><dl className="admin-definition"><div><dt>MFA</dt><dd>{user.mfaEnabled ? 'Activo' : 'No activo'}</dd></div><div><dt>Sesiones activas</dt><dd>{user.activeSessions}</dd></div><div><dt>Último acceso</dt><dd>{date(user.lastLoginAt)}</dd></div></dl><p>No se muestran dispositivos, tokens, hashes ni credenciales.</p></section>}
    {action && <ActionDialog action={action} onClose={() => setAction(null)} onDone={finished} />}
  </>;
}

function DocumentsPage({ search, permissions }: { search: URLSearchParams; permissions: Permission[] }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<AdminDocument>>(`/admin/documents?${query}`);
  return <><PageHeader eyebrow="Pipeline privado" title="Documentos" description="Sólo metadata operativa. Nunca se entregan PDF, filename, OCR, hash, object key ni campos salariales." />
    <QueryFilters action="/admin/documents" search={search}><SelectFilter name="processingStatus" label="Procesamiento" values={['CREATED', 'UPLOADED', 'SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION', 'NEEDS_TYPE_CONFIRMATION', 'TEXT_EXTRACTION', 'OCR', 'PARSING', 'NORMALIZATION', 'VALIDATION', 'COMPLETED', 'NEEDS_REVIEW', 'REJECTED_UNSUPPORTED', 'QUARANTINED', 'FAILED_RETRYABLE', 'RETRY_SCHEDULED', 'FAILED_PERMANENT', 'CANCELLED']} search={search} /><SelectFilter name="securityStatus" label="Seguridad" values={['PENDING', 'CLEAN', 'QUARANTINED', 'REJECTED', 'ERROR']} search={search} /></QueryFilters>
    {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No hay documentos para estos filtros.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Documento</th><th>Usuario</th><th>Tipo</th><th>Procesamiento</th><th>Seguridad</th><th>Tamaño</th><th>Páginas</th><th>Carga</th></tr></thead><tbody>{state.data.items.map((document) => <tr key={document.id}><td data-label="Documento"><a className="entity-link" href={`/admin/documents/${document.id}`}><strong>{shortId(document.id)}</strong><small>{document.classificationStatus}</small></a></td><td data-label="Usuario"><a href={`/admin/users/${document.userId}`}>{document.maskedEmail}</a></td><td data-label="Tipo">{document.documentType ?? 'Sin confirmar'}</td><td data-label="Procesamiento"><StatusBadge value={document.processingStatus} /></td><td data-label="Seguridad"><StatusBadge value={document.securityStatus} /></td><td data-label="Tamaño">{bytes(document.sizeBytes)}</td><td data-label="Páginas">{document.pageCount ?? '—'}</td><td data-label="Carga">{date(document.createdAt)}</td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/documents" search={search} /></>}
    {!permissions.includes('documents.quarantine') && <p className="admin-footnote">Tu rol permite diagnóstico, no cuarentena.</p>}
  </>;
}

function DocumentPage({ id, permissions }: { id: string; permissions: Permission[] }) {
  const state = useRemote<DocumentDetail>(`/admin/documents/${id}`);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [notice, setNotice] = useState('');
  if (state.loading) return <><PageHeader eyebrow="Documentos" title="Detalle seguro" description="Cargando metadata…" crumbs={[["Admin", "/admin"], ["Documentos", "/admin/documents"], [shortId(id)]]} /><LoadingState /></>;
  if (state.error || !state.data) return <><PageHeader eyebrow="Documentos" title="Detalle seguro" description="No se pudo recuperar la metadata." crumbs={[["Admin", "/admin"], ["Documentos", "/admin/documents"], [shortId(id)]]} /><ErrorState message={state.error} retry={state.reload} /></>;
  const { document, recentJobs, employmentId, importBatchId } = state.data;
  return <><PageHeader eyebrow="Documentos" title={shortId(document.id)} description="Diagnóstico sin exponer el contenido privado." crumbs={[["Admin", "/admin"], ["Documentos", "/admin/documents"], [shortId(id)]]} actions={permissions.includes('documents.quarantine') && document.securityStatus !== 'QUARANTINED' ? <button className="button danger-button" onClick={() => setAction({ title: 'Enviar a cuarentena', description: 'Detiene trabajo no iniciado y aísla el documento. Un job en ejecución no puede cancelarse desde aquí.', button: 'Cuarentenar', execute: async (reasonCode, reference) => { await api(`/admin/documents/${id}/quarantine`, { method: 'POST', body: JSON.stringify({ reasonCode, reference }) }); return 'Documento puesto en cuarentena.'; } })}>Cuarentenar</button> : undefined} />
    {notice && <p className="message success" aria-live="polite">{notice}</p>}<div className="admin-detail-grid"><section className="admin-card"><h2>Metadata</h2><dl className="admin-definition"><div><dt>ID</dt><dd>{document.id}</dd></div><div><dt>Usuario</dt><dd><a href={`/admin/users/${document.userId}`}>{document.maskedEmail}</a></dd></div><div><dt>Tipo</dt><dd>{document.documentType ?? 'Sin confirmar'}</dd></div><div><dt>Tamaño</dt><dd>{bytes(document.sizeBytes)}</dd></div><div><dt>Páginas</dt><dd>{document.pageCount ?? 'Sin dato'}</dd></div><div><dt>Empleo</dt><dd>{employmentId ? shortId(employmentId) : 'Sin asociación'}</dd></div><div><dt>Importación</dt><dd>{shortId(importBatchId)}</dd></div><div><dt>Retención</dt><dd>{document.retentionPolicy}</dd></div></dl></section><section className="admin-card"><h2>Diagnóstico</h2><dl className="admin-definition"><div><dt>Procesamiento</dt><dd><StatusBadge value={document.processingStatus} /></dd></div><div><dt>Seguridad</dt><dd><StatusBadge value={document.securityStatus} /></dd></div><div><dt>Clasificación</dt><dd>{document.classificationStatus}</dd></div><div><dt>Original</dt><dd>{document.originalAvailable ? 'Disponible bajo autorización del usuario' : 'No disponible'}</dd></div><div><dt>Carga</dt><dd>{date(document.createdAt)}</dd></div><div><dt>Procesado</dt><dd>{date(document.processedAt)}</dd></div></dl></section></div>
    <section className="admin-card"><h2>Jobs relacionados</h2>{!permissions.includes('processing.read') ? <p>Tu rol no incluye metadata de procesamiento.</p> : recentJobs.length ? <ul className="admin-event-list">{recentJobs.map((job) => <li key={job.id}><a href={`/admin/processing?search=${job.id}`}>{shortId(job.id)}</a><StatusBadge value={job.state} /><span>{job.stage} · {job.attempt}/{job.maxAttempts} intentos</span></li>)}</ul> : <EmptyState>No hay jobs relacionados.</EmptyState>}</section>
    {action && <ActionDialog action={action} onClose={() => setAction(null)} onDone={(message) => { setAction(null); setNotice(message); state.reload(); }} />}
  </>;
}

function ProcessingPage({ search, permissions }: { search: URLSearchParams; permissions: Permission[] }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<AdminJob>>(`/admin/jobs?${query}`);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [notice, setNotice] = useState('');
  function jobAction(job: AdminJob, kind: 'retry' | 'cancel') {
    const retry = kind === 'retry';
    setAction({ title: retry ? 'Reintentar job' : 'Cancelar job', description: retry ? 'Sólo vuelve a disponibilizar un job RETRYABLE en su misma versión.' : 'Sólo cancela trabajo que todavía no está en ejecución.', button: retry ? 'Reintentar ahora' : 'Cancelar job', execute: async (reasonCode, reference) => { await api(`/admin/jobs/${job.id}/${kind}`, { method: 'POST', body: JSON.stringify({ reasonCode, reference }) }); return retry ? 'Job reintentado en la misma versión.' : 'Job pendiente cancelado.'; } });
  }
  return <><PageHeader eyebrow="OCR y extracción" title="Procesamiento" description="Cola durable, intentos y errores sanitizados. No se muestra texto OCR ni resultados salariales." />
    {notice && <p className="message success" aria-live="polite">{notice}</p>}<QueryFilters action="/admin/processing" search={search}><SelectFilter name="state" label="Estado" values={['PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE', 'COMPLETED', 'FAILED', 'CANCELLED']} search={search} /><SelectFilter name="stage" label="Etapa" values={['SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION', 'TEXT_EXTRACTION', 'OCR', 'PARSING', 'NORMALIZATION', 'VALIDATION', 'CLEANUP']} search={search} /></QueryFilters>
    {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No hay jobs para estos filtros.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Job</th><th>Documento</th><th>Etapa</th><th>Estado</th><th>Intentos</th><th>Versión</th><th>Error</th><th>Disponible</th><th>Acciones</th></tr></thead><tbody>{state.data.items.map((job) => <tr key={job.id}><td data-label="Job">{shortId(job.id)}</td><td data-label="Documento"><a href={`/admin/documents/${job.documentId}`}>{shortId(job.documentId)}</a></td><td data-label="Etapa">{job.stage}</td><td data-label="Estado"><StatusBadge value={job.state} /></td><td data-label="Intentos">{job.attempt}/{job.maxAttempts}</td><td data-label="Versión">{job.processingVersion}</td><td data-label="Error">{job.errorCode ?? '—'}</td><td data-label="Disponible">{date(job.availableAt)}</td><td data-label="Acciones"><div className="row-actions">{permissions.includes('processing.retry') && job.state === 'RETRYABLE' && <button className="button compact secondary" onClick={() => jobAction(job, 'retry')}>Retry</button>}{permissions.includes('processing.cancel') && ['PENDING', 'PUBLISHED', 'RETRYABLE'].includes(job.state) && <button className="button compact danger-button" onClick={() => jobAction(job, 'cancel')}>Cancelar</button>}</div></td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/processing" search={search} /></>}
    {action && <ActionDialog action={action} onClose={() => setAction(null)} onDone={(message) => { setAction(null); setNotice(message); state.reload(); }} />}
  </>;
}

function EmployersPage({ search }: { search: URLSearchParams }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<AdminEmployer>>(`/admin/employers?${query}`);
  return <><PageHeader eyebrow="Relaciones laborales" title="Empleadores" description="Vista por usuario del modelo actual. No hay registro global, CUIT ni merge hasta resolver identidad sin destruir evidencia." /><QueryFilters action="/admin/employers" search={search} />
    {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No hay empleadores para estos filtros.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Empleador</th><th>Usuario</th><th>País</th><th>Empleos</th><th>Activos</th><th>Actualización</th></tr></thead><tbody>{state.data.items.map((employer) => <tr key={employer.id}><td data-label="Empleador"><strong>{employer.name}</strong><small className="cell-note">{shortId(employer.id)}</small></td><td data-label="Usuario"><a href={`/admin/users/${employer.userId}`}>{shortId(employer.userId)}</a></td><td data-label="País">{employer.countryCode}</td><td data-label="Empleos">{employer.employmentCount}</td><td data-label="Activos">{employer.activeEmploymentCount}</td><td data-label="Actualización">{date(employer.updatedAt)}</td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/employers" search={search} /></>}
  </>;
}

function StoragePage({ search }: { search: URLSearchParams }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<StorageData>(`/admin/storage?${query}`);
  return <><PageHeader eyebrow="Capacidad y abuso" title="Storage" description="Consumo agregado y anomalías determinísticas; ningún archivo ni URL de storage se expone." />{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : <><section className="admin-kpi-grid"><article className="admin-kpi"><small>Uso total</small><strong>{bytes(state.data.summary.totalOriginalBytes)}</strong><span>{state.data.summary.documentCount} originales</span></article><article className="admin-kpi"><small>Usuarios</small><strong>{state.data.summary.usersWithOriginals}</strong><span>con originales disponibles</span></article><article className="admin-kpi"><small>Cuota por usuario</small><strong>{bytes(state.data.summary.quotaBytesPerUser)}</strong><span>límite server-side</span></article><article className="admin-kpi"><small>Borrados pendientes</small><strong>{state.data.summary.pendingDeletions}</strong><span>tombstones de storage</span></article></section>{!state.data.items.length ? <EmptyState>No hay consumo registrado.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Usuario</th><th>Storage</th><th>Cuota</th><th>Documentos</th><th>Mayor archivo</th><th>Señal</th></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.userId}><td data-label="Usuario"><a href={`/admin/users/${item.userId}`}>{shortId(item.userId)}</a></td><td data-label="Storage">{bytes(item.originalBytes)}</td><td data-label="Cuota">{item.usagePercent}%</td><td data-label="Documentos">{item.documentCount}</td><td data-label="Mayor archivo">{bytes(item.largestDocumentBytes)}</td><td data-label="Señal">{item.anomalyFlags.length ? item.anomalyFlags.map((flag) => <StatusBadge key={flag} value={flag} />) : 'Normal'}</td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/storage" search={search} /></>}</>}</>;
}

function PrivacyPage({ search }: { search: URLSearchParams }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<PrivacyOperation>>(`/admin/privacy?${query}`);
  return <><PageHeader eyebrow="Derechos y retención" title="Privacidad" description="Seguimiento de exportaciones y eliminaciones. La ejecución sigue en workers durables, no desde el panel." /><QueryFilters action="/admin/privacy" search={search}><SelectFilter name="status" label="Estado" values={['PENDING', 'RUNNING', 'READY', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']} search={search} /><SelectFilter name="operationType" label="Tipo" values={['DATA_EXPORT', 'ACCOUNT_DELETION']} search={search} /></QueryFilters>{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No hay operaciones de privacidad.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Operación</th><th>Usuario</th><th>Tipo</th><th>Estado</th><th>Solicitud</th><th>Finalización</th><th>Salida</th><th>Error</th></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.id}><td data-label="Operación">{shortId(item.id)}</td><td data-label="Usuario"><a href={`/admin/users/${item.userId}`}>{item.maskedEmail}</a></td><td data-label="Tipo">{item.operationType}</td><td data-label="Estado"><StatusBadge value={item.status} /></td><td data-label="Solicitud">{date(item.createdAt)}</td><td data-label="Finalización">{date(item.completedAt)}</td><td data-label="Salida">{item.hasOutput ? `Disponible hasta ${date(item.outputExpiresAt)}` : 'No disponible'}</td><td data-label="Error">{item.errorCode ?? '—'}</td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/privacy" search={search} /></>}</>;
}

function SecurityPage() {
  const state = useRemote<SecurityData>('/admin/security');
  return <><PageHeader eyebrow="Least privilege" title="Seguridad" description="Postura administrativa, sesiones y eventos sanitizados. Sin IPs completas, tokens ni detalles internos." />{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : <><section className="admin-kpi-grid">{[['Sesiones activas', state.data.activeSessions, `${state.data.recentlyRevokedSessions} revocadas en 24 h`], ['Admins sin MFA', state.data.adminsWithoutMfa, 'requieren remediación'], ['Cuentas restringidas', state.data.blockedUsers + state.data.suspendedUsers, `${state.data.blockedUsers} bloqueadas`], ['En cuarentena', state.data.quarantinedDocuments, `${state.data.securityErrors} errores de seguridad`], ['Mutaciones admin', state.data.adminMutations24h, 'últimas 24 horas']].map(([label, value, detail]) => <article className="admin-kpi" key={label}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>)}</section><section className="admin-card"><h2>Lectura operativa</h2><p>Los eventos administrativos detallados están en Auditoría. Esta vista no replica logs, direcciones IP ni identificadores de sesión.</p></section></>}</>;
}

function AuditPage({ search }: { search: URLSearchParams }) {
  const query = new URLSearchParams(search); query.set('pageSize', '25');
  const state = useRemote<Paged<AuditEvent>>(`/admin/audit?${query}`);
  return <><PageHeader eyebrow="Trazabilidad inmutable" title="Auditoría" description="Acciones administrativas append-only con metadata mínima, motivo y referencia." /><QueryFilters action="/admin/audit" search={search}><SelectFilter name="result" label="Resultado" values={['SUCCESS', 'DENIED', 'FAILED']} search={search} /></QueryFilters>{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : !state.data.items.length ? <EmptyState>No hay eventos administrativos.</EmptyState> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Fecha</th><th>Actor</th><th>Rol</th><th>Acción</th><th>Recurso</th><th>Resultado</th><th>Motivo</th><th>Referencia</th></tr></thead><tbody>{state.data.items.map((event) => <tr key={event.id}><td data-label="Fecha">{date(event.createdAt)}</td><td data-label="Actor">{shortId(event.actorUserId)}</td><td data-label="Rol">{event.actorAdminRole}</td><td data-label="Acción">{event.action}</td><td data-label="Recurso">{event.resourceType}{event.resourceId ? ` · ${shortId(event.resourceId)}` : ''}</td><td data-label="Resultado"><StatusBadge value={event.result} /></td><td data-label="Motivo">{event.reasonCode ?? '—'}</td><td data-label="Referencia">{event.reference ?? '—'}</td></tr>)}</tbody></table></div><Pagination result={state.data} path="/admin/audit" search={search} /></>}</>;
}

function AccessPage() {
  const state = useRemote<RoleDefinition[]>('/admin/roles');
  return <><PageHeader eyebrow="RBAC" title="Roles y permisos" description="Matriz fija, revisable y deny-by-default. Los cambios de rol se hacen desde el usuario y revocan sus sesiones." />{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error} retry={state.reload} /> : <div className="admin-card-grid">{state.data.map((definition) => <article className="admin-card role-card" key={definition.role}><p className="eyebrow">Rol administrativo</p><h2>{definition.role}</h2><ul>{definition.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul></article>)}</div>}</>;
}

function SettingsPanel() {
  const settings = useRemote<SettingsData>('/admin/settings');
  return <section className="admin-card"><h2>Configuración efectiva</h2>{settings.loading ? <LoadingState /> : settings.error || !settings.data ? <ErrorState message={settings.error} retry={settings.reload} /> : <div className="admin-card-grid">{[['Entorno', { environment: settings.data.environment }], ['Autenticación', settings.data.authentication], ['Límites', settings.data.limits], ['Storage', settings.data.storage], ['Funciones', settings.data.features]].map(([group, values]) => <article className="settings-summary" key={String(group)}><h3>{String(group)}</h3><dl>{Object.entries(values as Record<string, unknown>).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}</dl></article>)}</div>}<p className="admin-footnote">Cambios dinámicos, flags, credenciales y secretos no están habilitados.</p></section>;
}

function SystemPage({ permissions }: { permissions: Permission[] }) {
  const health = useRemote<HealthData>('/admin/system/health');
  return <><PageHeader eyebrow="Operación" title="Sistema" description="Salud sin detalles internos y configuración efectiva de sólo lectura, sin secretos." />
    <section className="admin-card"><h2>Salud de servicios</h2>{health.loading ? <LoadingState /> : health.error || !health.data ? <ErrorState message={health.error} retry={health.reload} /> : <><div className="system-overall"><span>Estado general</span><StatusBadge value={health.data.overall} /><small>Verificado {date(health.data.checkedAt)}</small></div><ul className="health-grid">{Object.entries(health.data.components).map(([name, status]) => <li key={name}><span>{name}</span><StatusBadge value={status} /></li>)}</ul></>}</section>
    {permissions.includes('settings.read') && <SettingsPanel />}
  </>;
}

function AdminLayout({ user, path, children }: { user: SessionUser; path: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const allowed = navigation.filter((item) => user.permissions.includes(item.permission));
  function closeMenu() { setMenuOpen(false); window.requestAnimationFrame(() => triggerRef.current?.focus()); }
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); window.requestAnimationFrame(() => triggerRef.current?.focus()); } };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);
  return <div className="admin-shell"><aside id="admin-navigation" ref={menuRef} className={menuOpen ? 'admin-sidebar open' : 'admin-sidebar'}><div className="admin-sidebar-head"><Link className="brand" href="/"><span className="brand-mark">S</span>Salarivo</Link><button className="icon-button admin-menu-close" onClick={closeMenu} aria-label="Cerrar menú">×</button></div><div className="admin-context"><small>Consola interna</small><strong>{user.adminRole}</strong></div><nav aria-label="Navegación administrativa">{allowed.map((item) => { const active = item.href === '/admin' ? path === '/admin' : path.startsWith(item.href); return <Link key={item.href} className={active ? 'admin-nav active' : 'admin-nav'} aria-current={active ? 'page' : undefined} href={item.href} onClick={closeMenu}><span aria-hidden="true">{item.mark}</span>{item.label}</Link>; })}</nav><div className="admin-identity"><strong>{user.displayName || 'Administrador'}</strong><small>{user.email}</small><Link href="/">Volver al espacio personal</Link></div></aside>{menuOpen && <button className="admin-backdrop" onClick={closeMenu} aria-label="Cerrar menú" />}<main className="admin-content" inert={menuOpen ? true : undefined}><header className="admin-mobile-header"><button ref={triggerRef} className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menú" aria-expanded={menuOpen} aria-controls="admin-navigation">☰</button><span>Administración · {user.adminRole}</span><Link href="/" aria-label="Volver a Salarivo">S</Link></header>{children}</main></div>;
}

export function AdminApp() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [location, setLocation] = useState<{ path: string; search: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setLocation({ path: window.location.pathname.replace(/\/$/, '') || '/admin', search: window.location.search }));
    api<SessionUser>('/auth/me').then((current) => {
      if (current.role !== 'ADMIN' || !current.adminRole) throw new ApiError('No tenés permisos para acceder al panel de administración.', 403, 'ADMIN_REQUIRED');
      setUser(current);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'No pudimos abrir el panel.'));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  if (error) return <main className="admin-gate"><div><span className="brand"><span className="brand-mark">S</span>Salarivo</span><p className="eyebrow">Acceso administrativo</p><h1>Panel protegido</h1><p>{error}</p><Link className="button primary" href="/">Volver a Salarivo</Link></div></main>;
  if (!user || !location) return <main className="admin-gate"><LoadingState /></main>;
  const search = new URLSearchParams(location.search);
  const segments = location.path.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  const section = segments[0] ?? 'dashboard';
  let page: ReactNode;
  const requiredPermission: Partial<Record<string, Permission>> = {
    dashboard: 'dashboard.read', users: 'users.read_metadata', documents: 'documents.read_metadata',
    employers: 'employers.read_metadata', processing: 'processing.read', storage: 'storage.read',
    privacy: 'privacy.read', security: 'security.read', audit: 'audit.read', access: 'roles.manage',
    system: 'system.health.read',
  };
  if (requiredPermission[section] && !user.permissions.includes(requiredPermission[section]!)) page = <><PageHeader eyebrow="Administración" title="Permiso insuficiente" description="Tu rol no incluye esta capacidad. El servidor también rechazó cualquier acceso directo." /><Link className="button primary" href="/admin">Volver al panel</Link></>;
  else if (section === 'dashboard') page = <DashboardPage search={search} />;
  else if (section === 'users' && segments[1]) page = <UserPage id={segments[1]} search={search} permissions={user.permissions} currentUserId={user.id} />;
  else if (section === 'users') page = <UsersPage search={search} />;
  else if (section === 'documents' && segments[1]) page = <DocumentPage id={segments[1]} permissions={user.permissions} />;
  else if (section === 'documents') page = <DocumentsPage search={search} permissions={user.permissions} />;
  else if (section === 'employers') page = <EmployersPage search={search} />;
  else if (section === 'processing') page = <ProcessingPage search={search} permissions={user.permissions} />;
  else if (section === 'storage') page = <StoragePage search={search} />;
  else if (section === 'privacy') page = <PrivacyPage search={search} />;
  else if (section === 'security') page = <SecurityPage />;
  else if (section === 'audit') page = <AuditPage search={search} />;
  else if (section === 'access') page = <AccessPage />;
  else if (section === 'system') page = <SystemPage permissions={user.permissions} />;
  else page = <><PageHeader eyebrow="Administración" title="Sección no encontrada" description="La ruta solicitada no existe o todavía no está habilitada." /><Link className="button primary" href="/admin">Volver al panel</Link></>;
  return <AdminLayout user={user} path={location.path}>{page}</AdminLayout>;
}
