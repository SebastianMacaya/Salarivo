'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  PRIVACY_MODE_STORAGE_KEY,
  privateMoney,
  privatePercentage,
  privateText,
  readPrivacyMode,
  writePrivacyMode,
  type MoneyValueKind,
} from './privacy-mode-state';
import styles from './privacy-mode.module.css';

export type PrivacyModeValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
};

const PrivacyModeContext = createContext<PrivacyModeValue | null>(null);
export const PRIVACY_MODE_EVENT = 'salarivo:privacy-mode';
let clientPreference: boolean | undefined;

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function privacySnapshot() {
  return clientPreference ?? readPrivacyMode(browserStorage());
}

export function subscribePrivacyMode(onChange: () => void) {
  const sync = (event: StorageEvent) => {
    if (event.key !== PRIVACY_MODE_STORAGE_KEY) return;
    clientPreference = event.newValue === 'enabled';
    onChange();
  };
  window.addEventListener('storage', sync);
  window.addEventListener(PRIVACY_MODE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', sync);
    window.removeEventListener(PRIVACY_MODE_EVENT, onChange);
  };
}

export function PrivacyModeProvider({ children }: { children: ReactNode }) {
  // The server snapshot stays hidden so hydration cannot flash a salary.
  const enabled = useSyncExternalStore(subscribePrivacyMode, privacySnapshot, () => true);

  const setEnabled = useCallback((next: boolean) => {
    if (typeof window === 'undefined') return;
    clientPreference = next;
    writePrivacyMode(browserStorage(), next);
    window.dispatchEvent(new Event(PRIVACY_MODE_EVENT));
  }, []);
  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);
  const value = useMemo(() => ({ enabled, setEnabled, toggle }), [enabled, setEnabled, toggle]);

  return <PrivacyModeContext.Provider value={value}>{children}</PrivacyModeContext.Provider>;
}

export function usePrivacyMode() {
  const value = useContext(PrivacyModeContext);
  if (!value) throw new Error('usePrivacyMode debe usarse dentro de PrivacyModeProvider.');
  return value;
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.7" />
    {hidden && <path d="m4 4 16 16" />}
  </svg>;
}

export type PrivacyToggleProps = { className?: string };

export function PrivacyToggle({ className = '' }: PrivacyToggleProps) {
  const { enabled, toggle } = usePrivacyMode();
  const label = enabled ? 'Mostrar importes' : 'Ocultar importes';
  return <button
    type="button"
    className={`${styles.toggle}${className ? ` ${className}` : ''}`}
    aria-label={label}
    title={label}
    onClick={toggle}
  >
    <EyeIcon hidden={enabled} />
    <span>{label}</span>
  </button>;
}

export type MoneyValueProps = {
  className?: string;
  creditAware?: boolean;
  currency?: string;
  kind?: MoneyValueKind;
  value?: string | null;
};

export function MoneyValue({
  className,
  creditAware = false,
  currency = 'ARS',
  kind = 'default',
  value,
}: MoneyValueProps) {
  const { enabled } = usePrivacyMode();
  const rendered = privateMoney(value, currency, enabled, kind, creditAware);
  if (!enabled || !value) return <span className={className}>{rendered}</span>;
  return <span className={className}>
    <span aria-hidden="true">{rendered}</span>
    <span className={styles.srOnly}>{creditAware && value.startsWith('-') ? 'Crédito oculto por modo privacidad' : 'Importe oculto por modo privacidad'}</span>
  </span>;
}

export type PercentageValueProps = { className?: string; sensitive?: boolean; value?: string | null };

export function PercentageValue({ className, sensitive = true, value }: PercentageValueProps) {
  const { enabled } = usePrivacyMode();
  const hidden = enabled && sensitive;
  const rendered = privatePercentage(value, hidden);
  if (!hidden || !value) return <span className={className}>{rendered}</span>;
  return <span className={className}>
    <span aria-hidden="true">{rendered}</span>
    <span className={styles.srOnly}>Porcentaje oculto por modo privacidad</span>
  </span>;
}

export type SensitiveValueProps = {
  className?: string;
  mask?: string;
  missing?: string;
  value?: string | null;
};

export function SensitiveValue({
  className,
  mask,
  missing,
  value,
}: SensitiveValueProps) {
  const { enabled } = usePrivacyMode();
  const rendered = privateText(value, enabled, mask, missing);
  if (!enabled || !value) return <span className={className}>{rendered}</span>;
  return <span className={className}>
    <span aria-hidden="true">{rendered}</span>
    <span className={styles.srOnly}>Dato salarial oculto por modo privacidad</span>
  </span>;
}
