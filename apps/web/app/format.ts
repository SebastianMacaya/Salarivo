export function money(value?: string | null, currency = 'ARS') {
  if (!value) return '—';
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match?.[2]) return `${currency} ${value}`;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${currency} ${match[1]}${grouped},${(match[3] ?? '00').padEnd(2, '0')}`;
}

export function percentage(value?: string | null) {
  if (!value) return '—';
  const match = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(value);
  return match ? `${match[1]},${(match[2] ?? '00').padEnd(2, '0')}%` : `${value}%`;
}

function decimalHundredths(value?: string | null) {
  const match = /^(-?)(\d+)$/.exec(value ?? '');
  if (!match?.[2]) return null;
  const digits = match[2].replace(/^0+(?=\d)/, '').padStart(3, '0');
  const sign = match[1] && /[1-9]/.test(digits) ? '-' : '';
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function amountFromCents(value?: string | null) {
  return decimalHundredths(value);
}

export function percentageFromBasisPoints(value?: string | null) {
  return decimalHundredths(value);
}

const periodFormatter = new Intl.DateTimeFormat('es-AR', { month: 'long', timeZone: 'UTC' });
const dateFormatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeZone: 'UTC' });
const timestampFormatter = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
  timeZone: 'America/Argentina/Buenos_Aires',
});

export function periodLabel(value?: string | null) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(\d{2}))?$/.exec(value ?? '');
  if (!match?.[1] || !match[2]) return '—';
  const isoDate = `${match[1]}-${match[2]}-${match[3] ?? '01'}`;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) return '—';
  const month = periodFormatter.format(date);
  return `${month.charAt(0).toLocaleUpperCase('es-AR')}${month.slice(1)} ${match[1]}`;
}

export function dateLabel(value?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return '—';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? '—'
    : dateFormatter.format(date);
}

export function employmentOptionLabel(employment: {
  employerName: string;
  role?: string | null;
  startDate: string;
  endDate?: string | null;
  status: string;
  currencyCode?: string | null;
}) {
  const status = employment.status === 'ACTIVE'
    ? 'Activo'
    : employment.status === 'ENDED' ? 'Finalizado' : employment.status;
  const range = `${dateLabel(employment.startDate)} a ${employment.endDate ? dateLabel(employment.endDate) : 'actualidad'}`;
  return [
    employment.employerName,
    employment.role || 'Puesto sin especificar',
    status,
    range,
    employment.currencyCode,
  ].filter(Boolean).join(' · ');
}

export function salaryContextOptionLabel(context: {
  employerName?: string | null;
  state: 'CONFIRMED' | 'DETECTED' | 'UNCONFIRMED';
  currencyCode: string;
  employmentStatus?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  firstPeriod?: string | null;
  lastPeriod?: string | null;
}) {
  const state = context.state === 'CONFIRMED'
    ? 'Confirmado'
    : context.state === 'DETECTED' ? 'Recibos sin asociar' : 'Sin confirmar';
  const employmentStatus = context.employmentStatus === 'ACTIVE'
    ? 'Activo'
    : context.employmentStatus === 'ENDED' ? 'Finalizado' : context.employmentStatus;
  const employmentRange = context.startDate
    ? `${dateLabel(context.startDate)} a ${context.endDate ? dateLabel(context.endDate) : 'actualidad'}`
    : null;
  const observedRange = context.firstPeriod && context.lastPeriod
    ? context.firstPeriod === context.lastPeriod
      ? periodLabel(context.firstPeriod)
      : `${periodLabel(context.firstPeriod)} a ${periodLabel(context.lastPeriod)}`
    : context.firstPeriod || context.lastPeriod
      ? periodLabel(context.firstPeriod ?? context.lastPeriod)
      : null;
  return [
    context.employerName || 'Empleo sin confirmar',
    state,
    context.state === 'CONFIRMED' ? employmentStatus : null,
    employmentRange ?? observedRange ?? 'Período no disponible',
    context.currencyCode,
  ].filter(Boolean).join(' · ');
}

export function salaryContextMatches(
  context: Parameters<typeof salaryContextOptionLabel>[0],
  query: string,
  employment?: { role?: string | null } | null,
) {
  const normalizedQuery = query.normalize('NFKD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = `${salaryContextOptionLabel(context)} ${employment?.role ?? ''} ${periodLabel(context.firstPeriod)} ${periodLabel(context.lastPeriod)}`
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return normalizedQuery.split(/\s+/).every((term) => haystack.includes(term));
}

export function salaryContextIdentityMatches(
  context: { employmentContext: string; employmentId?: string | null; currencyCode: string },
  requested: { employmentContext?: string | null; employmentId?: string | null; currencyCode?: string | null },
) {
  if (requested.employmentId) {
    return context.employmentId === requested.employmentId
      && (!requested.employmentContext || context.employmentContext === requested.employmentContext)
      && (!requested.currencyCode || context.currencyCode === requested.currencyCode);
  }
  return Boolean(requested.employmentContext)
    && context.employmentContext === requested.employmentContext
    && (!requested.currencyCode || context.currencyCode === requested.currencyCode);
}

export function timestampLabel(value?: string | null) {
  if (!value || !value.includes('T')) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : timestampFormatter.format(date);
}

const documentStatusLabels: Record<string, string> = {
  CREATED: 'Preparando',
  UPLOADED: 'Recibido',
  SECURITY_VALIDATION: 'Validando seguridad',
  DOCUMENT_CLASSIFICATION: 'Clasificando',
  TEXT_EXTRACTION: 'Extrayendo texto',
  OCR: 'Leyendo imagen',
  PARSING: 'Interpretando',
  DOCUMENT_PIPELINE_V2: 'Procesamiento versionado',
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

export function documentStatusLabel(value?: string | null) {
  return value ? documentStatusLabels[value] ?? 'Estado desconocido' : '—';
}

export function recentPeriodRange<T extends { period: string }>(items: T[], months?: number) {
  if (!months || !items.length) return items;
  const index = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
  const first = index(items.at(-1)!.period) - months + 1;
  return items.filter(({ period }) => index(period) >= first);
}

export function relevantEvolutionRanges(periods: string[]) {
  if (!periods.length) return ['all'] as const;
  const index = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
  const span = index(periods.at(-1)!) - index(periods[0]!) + 1;
  return [...([6, 12, 24, 60] as const).filter((months) => span > months), 'all'] as const;
}

export const salaryCategories = [
  'NORMAL', 'SAC', 'BONO', 'RETROACTIVO', 'VACACIONES', 'HORAS_EXTRA', 'AJUSTE',
  'REINTEGRO', 'COMISION', 'LIQUIDACION_FINAL', 'INDEMNIZACION', 'OTRO',
] as const;

export type SalaryCategory = (typeof salaryCategories)[number];

const settlementTypeLabels: Record<string, string> = {
  NORMAL: 'Liquidación normal',
  SAC: 'Aguinaldo',
  VACACIONES: 'Vacaciones',
  BONO: 'Bono',
  RETROACTIVO: 'Retroactivo',
  COMISION: 'Comisión',
  HORAS_EXTRA: 'Horas extra',
  LIQUIDACION_FINAL: 'Liquidación final',
  INDEMNIZACION: 'Indemnización',
  AJUSTE: 'Ajuste',
  REINTEGRO: 'Reintegro',
  OTRO_LABORAL: 'Otra liquidación',
};

export function settlementTypeLabel(value?: string | null) {
  return value ? settlementTypeLabels[value] ?? '—' : '—';
}

const extractionSourceLabels: Record<string, string> = {
  PDF_TEXT: 'Texto del PDF',
  OCR: 'Lectura de imagen',
  RULE: 'Regla automática',
  TEMPLATE: 'Plantilla',
  AI_FALLBACK: 'Asistencia con IA',
  MANUAL_REQUIRED: 'Revisión manual necesaria',
};

export function extractionSourceLabel(value?: string | null) {
  return value ? extractionSourceLabels[value] ?? '—' : '—';
}
