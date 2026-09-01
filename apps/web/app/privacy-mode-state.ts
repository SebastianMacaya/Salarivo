import { money, percentage } from './format.ts';

export const PRIVACY_MODE_STORAGE_KEY = 'salarivo.privacy-mode';
export const MONEY_MASK = '••••••••';
export const PERCENTAGE_MASK = '••,••%';

export type PrivacyStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type MoneyValueKind = 'default' | 'salary';

export function readPrivacyMode(storage?: PrivacyStorage | null) {
  try {
    return storage?.getItem(PRIVACY_MODE_STORAGE_KEY) === 'enabled';
  } catch {
    return false;
  }
}

export function writePrivacyMode(storage: PrivacyStorage | null | undefined, enabled: boolean) {
  try {
    storage?.setItem(PRIVACY_MODE_STORAGE_KEY, enabled ? 'enabled' : 'disabled');
  } catch {
    // Privacy mode is a client preference; blocked storage must not break the UI.
  }
}

export function privateMoney(
  value: string | null | undefined,
  currency = 'ARS',
  enabled = false,
  kind: MoneyValueKind = 'default',
  creditAware = false,
) {
  if (!value) return kind === 'salary' ? 'N/D' : '—';
  const credit = creditAware && value.startsWith('-');
  const amount = credit ? value.slice(1) : value;
  const rendered = enabled ? `${currency} ${MONEY_MASK}` : money(amount, currency);
  return credit ? `Crédito ${rendered}` : rendered;
}

export function privatePercentage(value: string | null | undefined, enabled = false) {
  if (!value) return 'N/D';
  return enabled ? PERCENTAGE_MASK : percentage(value);
}

export function privateText(
  value: string | null | undefined,
  enabled = false,
  mask = MONEY_MASK,
  missing = '—',
) {
  if (!value) return missing;
  return enabled ? mask : value;
}

export function isMonetaryField(fieldPath: string) {
  return /amount$/i.test(fieldPath);
}

export function isSalaryPercentageField(fieldPath: string) {
  return /(?:percentage|percent|rate)$/i.test(fieldPath);
}

type DecimalParts = { fraction: string; sign: -1 | 0 | 1; whole: string };

function decimalParts(value: string): DecimalParts | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match?.[2]) return null;
  const whole = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const zero = whole === '0' && fraction === '';
  return { fraction, sign: zero ? 0 : match[1] ? -1 : 1, whole };
}

function compareMagnitude(left: DecimalParts, right: DecimalParts) {
  if (left.whole.length !== right.whole.length) return left.whole.length - right.whole.length;
  if (left.whole !== right.whole) return left.whole < right.whole ? -1 : 1;
  const length = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(length, '0');
  const rightFraction = right.fraction.padEnd(length, '0');
  return leftFraction === rightFraction ? 0 : leftFraction < rightFraction ? -1 : 1;
}

function compareDecimals(left: DecimalParts, right: DecimalParts) {
  if (left.sign !== right.sign) return left.sign - right.sign;
  if (left.sign === 0) return 0;
  const magnitude = compareMagnitude(left, right);
  return left.sign === -1 ? -magnitude : magnitude;
}

/** Coarse rank buckets preserve a trend without exposing proportional salary geometry. */
export function privacyChartHeights(values: Array<string | null>): string[] {
  const parsed = values.map((value) => value === null ? null : decimalParts(value));
  const distinct = parsed
    .flatMap((value) => value === null ? [] : [value])
    .sort(compareDecimals)
    .filter((value, index, items) => index === 0 || compareDecimals(items[index - 1]!, value) !== 0);
  const heights = ['30%', '52%', '74%', '96%'];

  return parsed.map((value) => {
    if (value === null) return '0%';
    const rank = distinct.findIndex((candidate) => compareDecimals(candidate, value) === 0);
    const bucket = distinct.length < 2 ? 2 : Math.round((rank * (heights.length - 1)) / (distinct.length - 1));
    return heights[bucket]!;
  });
}
