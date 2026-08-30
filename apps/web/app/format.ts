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
