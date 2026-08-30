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

const periodFormatter = new Intl.DateTimeFormat('es-AR', { month: 'long', timeZone: 'UTC' });

export function periodLabel(value?: string | null) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(\d{2}))?$/.exec(value ?? '');
  if (!match?.[1] || !match[2]) return '—';
  const isoDate = `${match[1]}-${match[2]}-${match[3] ?? '01'}`;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) return '—';
  const month = periodFormatter.format(date);
  return `${month.charAt(0).toLocaleUpperCase('es-AR')}${month.slice(1)} ${match[1]}`;
}

export function recentPeriodRange<T extends { period: string }>(items: T[], months?: number) {
  if (!months || !items.length) return items;
  const index = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
  const first = index(items.at(-1)!.period) - months + 1;
  return items.filter(({ period }) => index(period) >= first);
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
