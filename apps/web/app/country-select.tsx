'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { COUNTRIES, countryName, getCountry } from '@salarivo/jurisdictions';

export type CountryProfile = {
  primaryCountryCode: string | null;
  primaryCountryConfirmedAt: string | null;
  suggestion: { countryCode: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; source: string } | null;
};
export type PrivateApi = <T>(path: string, init?: RequestInit) => Promise<T>;

// A filter and a native select retain platform keyboard/touch behavior and submit only catalog codes.
export function CountrySelect({ name = 'countryCode', label = 'País', initialValue = '', required = false, disabled = false, onChange }: {
  name?: string; label?: string; initialValue?: string; required?: boolean; disabled?: boolean; onChange?: (code: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [value, setValue] = useState(initialValue);
  const normalize = (text: string) => text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
  const filtered = COUNTRIES.filter((country) => country.code === value || normalize(`${country.code} ${countryName(country.code)}`).includes(normalize(query)));
  return <div className="country-select">
    <label htmlFor={`${id}-search`}>Buscar {label.toLocaleLowerCase('es')}<input id={`${id}-search`} type="search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} aria-controls={`${id}-select`} /></label>
    <label htmlFor={`${id}-select`}>{label}<select id={`${id}-select`} name={name} value={value} required={required} disabled={disabled} onChange={(event) => { setValue(event.target.value); onChange?.(event.target.value); }}>
      <option value="">Elegí un país</option>{filtered.map(({ code }) => <option key={code} value={code}>{countryName(code)} · {code}</option>)}
    </select></label>
    {query && <small role="status">{filtered.length} opciones. Seleccioná un país de la lista.</small>}
  </div>;
}

export function CountrySettings({ api, onConfirmed, dismissible = false, onDismiss }: {
  api: PrivateApi; onConfirmed: (profile: CountryProfile) => void; dismissible?: boolean; onDismiss?: () => void;
}) {
  const [profile, setProfile] = useState<CountryProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ browserLocale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    api<CountryProfile>(`/profile/country?${params}`).then((data) => { if (active) setProfile(data); }).catch(() => { if (active) setError('No pudimos cargar la configuración regional.'); });
    return () => { active = false; };
  }, [api, retry]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const code = String(new FormData(event.currentTarget).get('primaryCountryCode') ?? '');
    if (!getCountry(code)) return;
    setBusy(true); setError('');
    try {
      const next = await api<CountryProfile>('/profile/country', { method: 'PATCH', body: JSON.stringify({ primaryCountryCode: code }) });
      setProfile(next); onConfirmed(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos confirmar el país.'); }
    finally { setBusy(false); }
  }
  return <section className="panel country-settings" aria-labelledby="primary-country-title" aria-busy={busy}>
    <div className="panel-heading"><div><p className="eyebrow">Configuración regional</p><h2 id="primary-country-title">País principal</h2></div>{dismissible && <button type="button" className="text-button" disabled={busy} onClick={onDismiss}>Más tarde</button>}</div>
    <p>Elegí el país para los valores iniciales y las herramientas sugeridas. Cada empleo conserva su propia jurisdicción.</p>
    {profile ? <form className="stack-form" onSubmit={save}>
      {!profile.primaryCountryConfirmedAt && profile.suggestion && <p>Parece que tu país principal es {countryName(profile.suggestion.countryCode)}. Confirmalo o elegí otro; es sólo una sugerencia.</p>}
      {!profile.primaryCountryConfirmedAt && profile.suggestion && <details><summary>Origen de la sugerencia</summary><p>{({ CONFIRMED: 'País previamente confirmado', DOCUMENT: 'Empleos o documentos disponibles', GOOGLE_LOCALE: 'Configuración regional informada por Google', BROWSER_LOCALE: 'Configuración regional del navegador', TIMEZONE: 'Zona horaria del navegador', CURRENCY: 'Moneda disponible', LANGUAGE: 'Idioma' } as Record<string, string>)[profile.suggestion.source] ?? 'Configuración regional disponible'} · confianza {({ HIGH: 'alta', MEDIUM: 'media', LOW: 'baja' })[profile.suggestion.confidence]}. Esta señal no determina la jurisdicción legal de tus empleos.</p></details>}
      <CountrySelect name="primaryCountryCode" label="País principal" initialValue={profile.primaryCountryCode ?? profile.suggestion?.countryCode ?? ''} required disabled={busy} />
      {profile.primaryCountryConfirmedAt && <p className="message success" role="status">País confirmado. Cambiarlo no modifica empleos ni documentos existentes.</p>}
      <div><button className="button primary" disabled={busy}>{busy ? 'Guardando…' : 'Confirmar país'}</button></div>
    </form> : !error && <p role="status">Cargando país…</p>}
    {error && <p className="message error" role="alert">{error} {!profile && <button type="button" className="text-button" onClick={() => { setError(''); setRetry((value) => value + 1); }}>Reintentar</button>}</p>}
  </section>;
}

export function EmploymentJurisdictionFields({ initial, primaryCountryCode, detectedCurrencyCode }: {
  initial?: { countryCode: string | null; subdivisionCode?: string | null; legalRegimeCode?: string | null; currencyCode: string; status: string; employmentType?: string | null };
  primaryCountryCode?: string | null;
  detectedCurrencyCode?: string;
}) {
  const [country, setCountry] = useState(initial?.countryCode ?? primaryCountryCode ?? '');
  const [currency, setCurrency] = useState(initial?.currencyCode ?? detectedCurrencyCode ?? getCountry(country)?.currencyCode ?? '');
  return <>
    <CountrySelect label="País de este empleo" initialValue={country} required onChange={(code) => { setCountry(code); if (!initial && !detectedCurrencyCode) setCurrency(getCountry(code)?.currencyCode ?? ''); }} />
    <small>Al guardar confirmás este país para el empleo. Revisalo aunque coincida con tu país principal.</small>
    <div className="field-row"><label>Jurisdicción provincial/estatal (opcional)<input name="subdivisionCode" defaultValue={initial?.subdivisionCode ?? ''} placeholder={country ? `${country}-…` : 'Código ISO de subdivisión'} pattern={country ? `${country}-[A-Z0-9]{1,3}` : '[A-Z]{2}-[A-Z0-9]{1,3}'} maxLength={6} /></label>
      <label>Régimen laboral<select name="legalRegimeCode" key={country} defaultValue={initial?.countryCode === country ? initial.legalRegimeCode ?? '' : ''}><option value="">Sin confirmar</option>{country === 'AR' && <option value="AR_LCT_GENERAL">Ley de Contrato de Trabajo · régimen general</option>}{initial?.countryCode === country && initial.legalRegimeCode && initial.legalRegimeCode !== 'AR_LCT_GENERAL' && <option value={initial.legalRegimeCode}>Régimen registrado · {initial.legalRegimeCode}</option>}</select><small>Confirmá el régimen sólo si corresponde a tu relación laboral.</small></label></div>
    <div className="field-row"><label>Estado del empleo<select name="status" defaultValue={initial?.status ?? 'UNKNOWN'}><option value="UNKNOWN">No confirmado</option><option value="ACTIVE">Sigo trabajando aquí</option><option value="ENDED">Finalizó</option></select></label><label>Tipo de relación<select name="employmentType" defaultValue={initial?.employmentType ?? 'UNKNOWN'}><option value="UNKNOWN">Sin confirmar</option><option value="DEPENDENT">Relación de dependencia</option><option value="INDEPENDENT">Independiente</option></select></label></div>
    {!detectedCurrencyCode && <label>Moneda<select name="currencyCode" value={currency} required onChange={(event) => setCurrency(event.target.value)}><option value="">Elegí una moneda</option>{[...new Set([...Intl.supportedValuesOf('currency'), ...(currency ? [currency] : [])])].sort().map((code) => <option value={code} key={code}>{code}</option>)}</select></label>}
  </>;
}
