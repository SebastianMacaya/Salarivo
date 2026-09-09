'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { countryName } from '@salarivo/jurisdictions';
import { CountrySelect, type PrivateApi } from './country-select';
import { dateLabel, earningLabels, employmentOptionLabel, periodLabel, settlementTypeLabel } from './format';
import { normalizeReviewValue, writeDocumentLocation, writeOwnerLocation } from './document-evidence';
import { MoneyValue, PrivacyToggle, SensitiveValue, usePrivacyMode } from './privacy-mode';

type Employment = {
  id: string; employerName: string; countryCode: string | null; currencyCode: string;
  startDate: string; startDateConfirmedAt?: string | null; endDate?: string | null; statusConfirmedAt?: string | null; status: 'ACTIVE' | 'ENDED' | 'UNKNOWN';
  employmentType?: 'DEPENDENT' | 'INDEPENDENT' | 'UNKNOWN'; countryConfirmedAt?: string | null;
  legalRegimeCode?: string | null; subdivisionCode?: string | null;
};
type Estimate = {
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED'; currencyCode: string;
  salaryReference: { amount: string; sourceField: 'remunerativeAmount' | 'grossAmount'; period: string; documentId: string; settlementId: string } | null;
  legalRuleVersion: { code: string; version: string; effectiveFrom: string; effectiveTo: string | null; reviewedAt: string; references: { name: string; url: string }[] } | null;
  calculationVersion: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warnings: string[]; assumptions: string[]; disclaimer: string;
  salaryBase: {
    amount: string | null; currentMonthlyRemuneration: string | null; selectedPeriod: string | null;
    source: 'DOCUMENTS' | 'SIMULATION_OVERRIDE' | 'UNAVAILABLE'; analyzedDocumentIds: string[]; missingPeriods: string[]; unusablePeriods?: string[];
    trace: { documentId: string; settlementId: string; lineItemId?: string; sourceDescription?: string | null; period: string; code: string; amount: string; treatment: 'INCLUDED' | 'EXCLUDED' | 'AVERAGED' | 'REVIEW_REQUIRED'; explanation: string }[];
  };
  scenarios: { code: 'WITH_NOTICE' | 'WITHOUT_NOTICE'; total: string; netEstimate: { total: string; contributionsAmount: string; additionalWithholdingsAmount: string; contributionPercent: string }; notice: { unit: 'MONTHS' | 'DAYS'; value: number }; breakdown: { code: string; name: string; amount: string; explanation: string; ruleOrigin: string }[] }[];
  inputs: {
    employment: Employment; startDate: string | null; startDateSource: 'CONFIRMED' | 'EXTRACTED' | 'UNKNOWN' | 'SIMULATION_OVERRIDE';
    terminationDate: string; isProjection: boolean; salaryMode: 'SIMPLE' | 'DOCUMENTS'; vacationDays: string | null; seniority: { years: number; months: number; days: number; indemnityYears: number } | null;
    probation: { months: number; applies: boolean } | null;
    salaryInputs: { documentId: string; payrollPeriod: string; settlementType: string; remunerativeAmount: string | null }[];
    cappedSalaryBase: string | null;
    collectiveAgreement: { cctCode: string; category?: string | null; capAmount: string; version: string; effectiveFrom: string; effectiveTo: string; sourceUrl: string } | null;
    overrides: Record<string, unknown>;
  };
};
const sourceLabels = { CONFIRMED: 'Dato confirmado', EXTRACTED: 'Dato extraído', UNKNOWN: 'Sin confirmar', SIMULATION_OVERRIDE: 'Dato ingresado para esta simulación', DOCUMENTS: 'Recibos procesados', UNAVAILABLE: 'No disponible' };
const treatmentLabels = { INCLUDED: 'Incluido', EXCLUDED: 'Excluido', AVERAGED: 'Promedio aplicado', REVIEW_REQUIRED: 'Revisar' };
const qualityLabels = { HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja' };
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function TerminationSimulator({ api, selectedEmploymentId, onEmploymentChange, onManageEmployment }: {
  api: PrivateApi; selectedEmploymentId?: string; onEmploymentChange: (id: string) => void; onManageEmployment: () => void;
}) {
  const { enabled: privateMode } = usePrivacyMode();
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [date, setDate] = useState(today);
  const [result, setResult] = useState<Estimate | null>(null);
  const [referenceState, setReferenceState] = useState<{ key: string; estimate: Estimate | null } | null>(null);
  const [salaryMode, setSalaryMode] = useState<'SIMPLE' | 'DOCUMENTS'>('SIMPLE');
  const [salaryInput, setSalaryInput] = useState<string | null>(null);
  const [pendingVacationDays, setPendingVacationDays] = useState('');
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const monthlyRemuneration = useRef<HTMLInputElement>(null);
  const [capOverride, setCapOverride] = useState(false);
  const [confirmCountry, setConfirmCountry] = useState('');
  useEffect(() => {
    if (result) { resultTitle.current?.focus({ preventScroll: true }); resultTitle.current?.scrollIntoView({ block: 'start' }); }
  }, [result]);
  useEffect(() => {
    let active = true;
    api<Employment[]>('/employments').then((items) => {
      if (!active) return;
      setEmployments(items);
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : 'No pudimos cargar los empleos.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, retry]);
  const employment = selectedEmploymentId ? employments.find(({ id }) => id === selectedEmploymentId)
    : [...employments].filter((item) => item.status === 'ACTIVE' && Boolean(item.statusConfirmedAt) && item.employmentType === 'DEPENDENT').sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id))[0];
  const needsConfirmation = employment && (!employment.startDateConfirmedAt || !employment.statusConfirmedAt || !employment.countryConfirmedAt || !employment.legalRegimeCode || employment.employmentType === 'UNKNOWN' || !employment.employmentType);
  const employmentId = employment?.id;
  const referenceKey = JSON.stringify([employmentId, date, employment?.startDate, employment?.legalRegimeCode, employment?.countryCode]);
  const canLoadReference = Boolean(employmentId && /^\d{4}-\d{2}-\d{2}$/.test(date));
  const referenceLoading = canLoadReference && referenceState?.key !== referenceKey;
  const reference = referenceState?.key === referenceKey ? referenceState.estimate : null;
  const referenceError = referenceState?.key === referenceKey && referenceState.estimate === null;
  useEffect(() => {
    let active = true;
    if (!canLoadReference) return;
    api<Estimate>(`/employments/${employmentId}/termination-estimate`, { method: 'POST', body: JSON.stringify({ terminationDate: date, salaryMode: 'DOCUMENTS' }) })
      .then((estimate) => { if (active) setReferenceState({ key: referenceKey, estimate }); })
      .catch(() => { if (active) setReferenceState({ key: referenceKey, estimate: null }); });
    return () => { active = false; };
  }, [api, employmentId, date, canLoadReference, referenceKey]);
  const suggestedSalary = reference?.salaryReference?.amount ?? '';
  async function confirmEmployment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employment || busy) return;
    const form = new FormData(event.currentTarget);
    const patch = {
      startDate: form.get('startDate'), countryCode: form.get('countryCode'), legalRegimeCode: form.get('legalRegimeCode') || null,
      employmentType: form.get('employmentType'),
      ...(form.get('status') ? { status: form.get('status') } : {}),
      ...(form.get('endDate') ? { endDate: form.get('endDate') } : {}),
    };
    setBusy(true); setError(''); setResult(null);
    try {
      const saved = await api<Employment>(`/employments/${employment.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setEmployments((items) => items.map((item) => item.id === saved.id ? saved : item));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos confirmar los datos.'); }
    finally { setBusy(false); }
  }
  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employment || busy) return;
    const form = new FormData(event.currentTarget);
    const overrides: Record<string, unknown> = {};
    for (const key of ['cctCode', 'cctCategory']) if (form.get(key)) overrides[key] = String(form.get(key));
    if (form.get('startDate') !== employment.startDate) overrides.startDate = String(form.get('startDate'));
    for (const key of ['monthlyRemuneration', 'pendingVacationDays', 'vacationDaysTaken', 'priorVacationDays', 'sacAlreadyPaid', 'deductionRatePercent', 'additionalWithholdings']) {
      if (form.get(key)) overrides[key] = normalizeReviewValue('settlement.grossAmount', String(form.get(key)));
    }
    if (capOverride) overrides.cctCapVersion = {
      version: `manual-${form.get('capEffectiveFrom')}`, cctCode: form.get('cctCode'), category: form.get('cctCategory') || null,
      capAmount: normalizeReviewValue('settlement.grossAmount', String(form.get('capAmount'))),
      effectiveFrom: form.get('capEffectiveFrom'), effectiveTo: form.get('capEffectiveTo'), sourceUrl: form.get('capSourceUrl'),
    };
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await api<Estimate>(`/employments/${employment.id}/termination-estimate`, { method: 'POST', body: JSON.stringify({ terminationDate: date, terminationType: 'DISMISSAL_WITHOUT_CAUSE', salaryMode, overrides }) }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos calcular la estimación. Revisá los datos e intentá de nuevo.'); }
    finally { setBusy(false); }
  }
  const inputType = privateMode ? 'password' : 'text';
  const documentsHref = employment ? `/${writeOwnerLocation('', { section: 'history', tab: 'documents', employmentId: employment.id, currencyCode: employment.currencyCode })}` : '/?section=history&tab=documents';
  const missingSalary = result?.status === 'UNAVAILABLE' && result.inputs.probation !== null && result.salaryBase.amount === null;
  const enterSalary = () => {
    setSalaryMode('SIMPLE'); setResult(null);
    requestAnimationFrame(() => { monthlyRemuneration.current?.focus(); monthlyRemuneration.current?.scrollIntoView({ block: 'center' }); });
  };
  return <div className="page termination-page" aria-busy={loading || busy}>
    <div className="page-header"><div><p className="eyebrow">Tu relación laboral</p><h1>Indemnización estimada</h1></div><PrivacyToggle /></div>
    <p className="page-intro">Estimá cuánto cobrarías ante un despido sin causa, con y sin preaviso. Partimos de los datos de tu empleo y tus recibos; podés ajustarlos acá.</p>
    {error && <p className="message error" role="alert">{error} {!employments.length && <button type="button" className="text-button" disabled={loading} onClick={() => { setLoading(true); setError(''); setRetry((value) => value + 1); }}>Reintentar</button>}</p>}
    {loading && <section className="panel" role="status"><div className="loader" aria-hidden="true" /><p>Cargando empleos…</p></section>}
    {!loading && !employments.length && !error && <section className="empty-state"><h2>Primero, registrá tu empleo</h2><p>Podés usar recibos procesados o completar los datos manualmente.</p><button type="button" className="button primary" onClick={onManageEmployment}>Ir a empleos</button></section>}
    {employments.length > 0 && <section className="panel stack-form"><label>Empleo para simular<select aria-label="Empleo para simular" value={employment?.id ?? ''} disabled={busy} onChange={(event) => onEmploymentChange(event.target.value)}><option value="">Elegí un empleo</option>{employments.map((item) => <option key={item.id} value={item.id}>{employmentOptionLabel(item)}</option>)}</select></label>
      {!employment && <p>{selectedEmploymentId ? 'No encontramos ese empleo en tu cuenta. Elegí otro.' : 'No hay un empleo actual en relación de dependencia confirmado. Elegí uno y revisá sus datos; un recibo no confirma la continuidad laboral.'}</p>}
      {employment && <p>{employment.countryCode ? countryName(employment.countryCode) : 'País pendiente'} · {employment.status === 'ACTIVE' && employment.statusConfirmedAt ? 'Continuidad confirmada' : employment.status === 'ENDED' ? 'Empleo finalizado' : 'Continuidad pendiente de confirmar'}</p>}
    </section>}
    {employment && (needsConfirmation || employment.status === 'UNKNOWN') && <section className="panel stack-form"><h2>Revisá los datos del empleo</h2>
      <p>Esta confirmación se guarda en el empleo. Los cambios de remuneración y fecha de ingreso que hagas más abajo se usan sólo en la simulación.</p>
      <form className="stack-form" onSubmit={confirmEmployment}>
        <CountrySelect label="País laboral" initialValue={employment.countryCode ?? ''} required disabled={busy} onChange={setConfirmCountry} />
        <label>Fecha de ingreso<input name="startDate" type="date" defaultValue={employment.startDate} required disabled={busy} /></label>
        <label>Régimen laboral<select name="legalRegimeCode" defaultValue={employment.legalRegimeCode ?? ''} disabled={busy}><option value="">Sin confirmar / otro régimen</option>{(confirmCountry || employment.countryCode) === 'AR' && <option value="AR_LCT_GENERAL">Ley de Contrato de Trabajo · régimen general</option>}</select></label>
        <label>Tipo de relación<select name="employmentType" defaultValue={employment.employmentType ?? 'UNKNOWN'} disabled={busy}><option value="UNKNOWN">Sin confirmar</option><option value="DEPENDENT">Relación de dependencia</option><option value="INDEPENDENT">Independiente</option></select></label>
        {(employment.status === 'UNKNOWN' || !employment.statusConfirmedAt) && <label>¿Actualmente seguís trabajando en {employment.employerName}?<select name="status" defaultValue={employment.status === 'ENDED' ? 'ENDED' : 'UNKNOWN'} disabled={busy}><option value="UNKNOWN">Prefiero dejarlo pendiente</option><option value="ACTIVE">Sí, sigo trabajando aquí</option><option value="ENDED">No, finalizó</option></select></label>}
        {(employment.status === 'UNKNOWN' || !employment.statusConfirmedAt) && <label>Fecha de finalización (si finalizó)<input name="endDate" type="date" disabled={busy} /></label>}
        <div><button className="button secondary" disabled={busy}>{busy ? 'Guardando…' : 'Confirmar datos del empleo'}</button></div>
      </form>
    </section>}
    {employment && <form className="panel stack-form termination-form" onSubmit={calculate} onChange={() => setResult(null)}>
      <div className="panel-heading"><div><p className="eyebrow">Despido sin causa</p><h2>Calculá con tus datos</h2></div><a className="inline-link" href={documentsHref}>Ver recibos</a></div>
      <div className="field-row"><label>Fecha de ingreso<input name="startDate" type="date" defaultValue={employment.startDate} max={date || undefined} required disabled={busy} /></label><label>Fecha de finalización<input name="terminationDate" type="date" value={date} onChange={(event) => setDate(event.target.value)} required disabled={busy} /></label></div>
      <div className="field-row"><label>Sueldo bruto habitual ({employment.currencyCode})<input ref={monthlyRemuneration} name="monthlyRemuneration" type={inputType} inputMode="decimal" autoComplete="off" value={salaryInput ?? suggestedSalary} onChange={(event) => setSalaryInput(event.target.value)} placeholder={referenceLoading ? 'Buscando en tus recibos…' : 'Ingresá tu sueldo bruto'} maxLength={24} required={salaryMode === 'SIMPLE'} disabled={busy || salaryMode === 'DOCUMENTS'} /><small>Antes de descuentos, sin aguinaldo ni pagos excepcionales.</small></label><label>Vacaciones pendientes (días)<input name="pendingVacationDays" type="text" inputMode="decimal" value={pendingVacationDays} onChange={(event) => setPendingVacationDays(event.target.value)} placeholder="Automático: proporcional del año" maxLength={8} disabled={busy} /><small>Si conocés el saldo total, incluidos años anteriores, ingresalo acá. Reemplaza el proporcional automático.</small></label></div>
      {salaryMode === 'SIMPLE' && <div className="termination-suggestion" role="status">
        {referenceLoading ? <p>Buscando el sueldo disponible en tus recibos…</p> : salaryInput !== null ? <p>Sueldo ajustado sólo para esta simulación. {suggestedSalary && <button type="button" className="text-button" disabled={busy} onClick={() => { setSalaryInput(null); setResult(null); }}>Volver al sueldo sugerido</button>}</p> : reference?.salaryReference ? <p>Precargado del total {reference.salaryReference.sourceField === 'remunerativeAmount' ? 'remunerativo' : 'bruto'} de {periodLabel(reference.salaryReference.period)}. Es una aproximación; podés ajustarla si incluye extras. No necesitás revisar cada recibo para estimar.</p> : <p>{referenceError ? 'No pudimos precargar el sueldo. Podés ingresarlo para calcular.' : 'No hay un sueldo mensual disponible para esta fecha. Ingresalo una vez para estimar sin cargar más recibos.'}</p>}
      </div>}
      {date > today() && <p>Esta simulación supone que tu remuneración se mantiene igual a la última conocida, salvo que ingreses otra. Es una proyección.</p>}
      {date < today() && <p>El cálculo histórico utiliza la normativa y la información salarial correspondientes hasta esa fecha.</p>}
      <details><summary>Ajustes para mayor precisión</summary><div className="stack-form termination-overrides">
        <p>Son opcionales y se usan sólo en esta simulación. No modifican tu empleo ni los recibos.</p>
        <label>Cómo tomar el sueldo<select name="salaryMode" value={salaryMode} disabled={busy} onChange={(event) => setSalaryMode(event.target.value as 'SIMPLE' | 'DOCUMENTS')}><option value="SIMPLE">Estimación simple con el sueldo indicado</option><option value="DOCUMENTS">Análisis detallado de los recibos</option></select><small>El análisis detallado distingue conceptos y remuneraciones de cada mes; puede necesitar datos adicionales.</small></label>
        <div className="field-row"><label>Aportes estimados (%)<input name="deductionRatePercent" type={inputType} autoComplete="off" inputMode="decimal" defaultValue="17" maxLength={6} disabled={busy} /><small>Se aplican sólo al sueldo pendiente y al aguinaldo proporcional. El 17% es una referencia editable, sin topes de aportes.</small></label><label>Otras retenciones estimadas ({employment.currencyCode})<input name="additionalWithholdings" type={inputType} inputMode="decimal" autoComplete="off" placeholder="0" maxLength={24} disabled={busy} /><small>Por ejemplo, Ganancias si conocés el importe. No lo calculamos automáticamente.</small></label></div>
        <div className="field-row"><label>Días de vacaciones ya gozados este año<input name="vacationDaysTaken" type="text" inputMode="decimal" maxLength={8} disabled={busy || pendingVacationDays.trim() !== ''} /></label><label>Días pendientes de años anteriores<input name="priorVacationDays" type="text" inputMode="decimal" maxLength={8} disabled={busy || pendingVacationDays.trim() !== ''} /></label></div>
        <small>Estos dos campos ajustan el saldo automático; no se suman al total de vacaciones que ingreses arriba.</small>
        <label>SAC ya pagado en el semestre ({employment.currencyCode})<input name="sacAlreadyPaid" type={inputType} inputMode="decimal" autoComplete="off" maxLength={24} disabled={busy} /></label>
        <div className="field-row"><label>Convenio colectivo (CCT)<input name="cctCode" placeholder="Código del convenio, si lo conocés" maxLength={80} required={capOverride} disabled={busy} /></label><label>Categoría del convenio<input name="cctCategory" maxLength={120} disabled={busy} /></label></div>
        <label className="termination-check"><input type="checkbox" checked={capOverride} disabled={busy} onChange={(event) => setCapOverride(event.target.checked)} />Tengo un tope de convenio con fuente y vigencia para revisar</label>
        {capOverride && <div className="stack-form"><label>Tope aplicable ({employment.currencyCode})<input name="capAmount" type={inputType} inputMode="decimal" autoComplete="off" maxLength={24} required disabled={busy} /></label><div className="field-row"><label>Vigente desde<input type="date" name="capEffectiveFrom" required disabled={busy} /></label><label>Vigente hasta<input type="date" name="capEffectiveTo" required disabled={busy} /></label></div><label>Fuente del tope<input name="capSourceUrl" type="url" placeholder="https://…" required disabled={busy} maxLength={500} /></label><small>Se mostrará como tope aportado para esta simulación, con su fuente y vigencia.</small></div>}
      </div></details>
      <p className="termination-form-note">El cálculo simple supone un sueldo habitual constante. Vas a ver el bruto y un neto orientativo en ambos escenarios.</p>
      <div><button className="button primary" disabled={busy || !date || (referenceLoading && salaryInput === null && salaryMode === 'SIMPLE')}>{busy ? 'Calculando…' : 'Calcular estimación'}</button></div>
    </form>}
    {busy && <section className="panel" role="status"><div className="loader" aria-hidden="true" /><p>Preparando datos y comparación…</p></section>}
    {result && <section className="termination-result stack-form" aria-label="Resultado de la estimación" aria-live="polite">
      <div className="panel-heading"><div><p className="eyebrow">{result.inputs.isProjection ? 'Proyección' : 'Estimación'} · {dateLabel(result.inputs.terminationDate)}</p><h2 ref={resultTitle} tabIndex={-1}>{result.status === 'AVAILABLE' ? 'Cuánto podrías cobrar' : result.status === 'UNSUPPORTED' ? 'Régimen o fecha sin cobertura' : missingSalary ? 'Ingresá un sueldo para estimar' : 'Faltan datos para calcular'}</h2></div>{result.status === 'AVAILABLE' && <span className="status ready">{result.inputs.salaryMode === 'SIMPLE' ? 'Estimación simple' : `Completitud ${qualityLabels[result.confidence].toLowerCase()}`}</span>}</div>
      {missingSalary && <section className="panel stack-form termination-next-step" aria-labelledby="termination-next-step-title">
        <h3 id="termination-next-step-title">Podés continuar con una estimación simple</h3>
        <p>El análisis detallado necesita más información de los conceptos. Usá el sueldo bruto sugerido o ingresá uno para estimar sin revisar todos los recibos.</p>
        <div><button type="button" className="button primary" onClick={enterSalary}>Usar estimación simple</button></div>
      </section>}
      {result.status === 'UNAVAILABLE' && !result.inputs.startDate && <section className="panel stack-form"><h3>Completá la fecha de ingreso</h3><p>Es necesaria para calcular la antigüedad. Podés confirmarla en tu empleo.</p><button type="button" className="button secondary" onClick={onManageEmployment}>Revisar datos del empleo</button></section>}
      <div className="termination-scenarios">{result.scenarios.map((scenario) => <article className="panel termination-scenario" key={scenario.code}>
        <h3>{scenario.code === 'WITH_NOTICE' ? 'Con preaviso' : 'Sin preaviso'}</h3><p>{scenario.code === 'WITH_NOTICE' ? 'Período de preaviso cumplido completamente.' : 'Incluye los conceptos que corresponden por falta de preaviso.'}</p>
        <dl className="termination-totals"><div><dt>Bruto estimado</dt><dd><MoneyValue value={scenario.total} currency={result.currencyCode} /></dd></div><div><dt>Neto orientativo</dt><dd><MoneyValue value={scenario.netEstimate.total} currency={result.currencyCode} /></dd></div></dl>
        <details><summary>Ver desglose y descuentos</summary><p>Preaviso requerido: {scenario.notice.value} {scenario.notice.unit === 'MONTHS' ? 'meses' : 'días'}.</p><dl className="termination-breakdown">{scenario.breakdown.map((line) => <div key={line.code}><dt>{line.name}</dt><dd><MoneyValue value={line.amount} currency={result.currencyCode} /></dd><details><summary>¿Cómo se calculó?</summary><p>{line.explanation}</p><small>{line.ruleOrigin}</small></details></div>)}<div><dt>Aportes estimados (<SensitiveValue value={scenario.netEstimate.contributionPercent} />%) sobre sueldo y SAC</dt><dd>− <MoneyValue value={scenario.netEstimate.contributionsAmount} currency={result.currencyCode} /></dd></div><div><dt>Otras retenciones ingresadas</dt><dd>− <MoneyValue value={scenario.netEstimate.additionalWithholdingsAmount} currency={result.currencyCode} /></dd></div></dl></details>
      </article>)}</div>
      {result.scenarios.length > 0 && <p className="termination-net-note">Neto orientativo: descontamos aportes sólo del sueldo pendiente y del aguinaldo proporcional, más las retenciones que ingresaste. No calculamos Ganancias ni topes de aportes automáticamente. Incluye el sueldo del mes como pendiente de pago.</p>}
      {result.warnings.length > 0 && <details className="panel" open={result.status !== 'AVAILABLE' && !missingSalary}><summary>{result.status === 'AVAILABLE' ? 'Qué puede cambiar este estimado' : 'Detalle de los datos pendientes'}</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <details className="panel"><summary>Datos utilizados para esta estimación</summary><dl className="termination-inputs">
        <div><dt>Empresa</dt><dd>{result.inputs.employment.employerName}</dd></div><div><dt>País del empleo</dt><dd>{result.inputs.employment.countryCode ? countryName(result.inputs.employment.countryCode) : 'Sin confirmar'}</dd></div>
        <div><dt>Fecha de ingreso</dt><dd>{dateLabel(result.inputs.startDate)} · {sourceLabels[result.inputs.startDateSource]}</dd></div><div><dt>Fecha simulada de egreso</dt><dd>{dateLabel(result.inputs.terminationDate)}</dd></div>
        <div><dt>Antigüedad computada</dt><dd>{result.inputs.seniority ? `${result.inputs.seniority.years} años, ${result.inputs.seniority.months} meses y ${result.inputs.seniority.days} días` : 'No disponible'}</dd></div>
        <div><dt>Base salarial seleccionada</dt><dd><MoneyValue value={result.salaryBase.amount} currency={result.currencyCode} /> · {sourceLabels[result.salaryBase.source]}{result.salaryBase.selectedPeriod ? ` · ${periodLabel(result.salaryBase.selectedPeriod)}` : ''}</dd></div>
        <div><dt>Base tras el tope y piso aplicables</dt><dd><MoneyValue value={result.inputs.cappedSalaryBase} currency={result.currencyCode} /></dd></div><div><dt>Remuneración mensual usada</dt><dd><MoneyValue value={result.salaryBase.currentMonthlyRemuneration} currency={result.currencyCode} /></dd></div>
        <div><dt>Vacaciones pendientes utilizadas</dt><dd>{result.inputs.vacationDays ?? '—'} días · {result.inputs.overrides.pendingVacationDays !== undefined ? 'Saldo ingresado' : 'Saldo proporcional calculado'}</dd></div>
        <div><dt>Recibos analizados</dt><dd>{result.salaryBase.analyzedDocumentIds.length}</dd></div><div><dt>Convenio</dt><dd>{result.inputs.collectiveAgreement ? `${result.inputs.collectiveAgreement.cctCode}${result.inputs.collectiveAgreement.category ? ` · ${result.inputs.collectiveAgreement.category}` : ''}` : 'Sin tope de convenio confirmado'}</dd></div>
        <div><dt>Versión normativa</dt><dd>{result.legalRuleVersion ? `${result.legalRuleVersion.code} / ${result.legalRuleVersion.version}` : 'Sin cobertura configurada'}</dd></div>
      </dl>
      {result.salaryBase.missingPeriods.length > 0 && <p>Períodos sin recibos analizados: {result.salaryBase.missingPeriods.map(periodLabel).join(', ')}.</p>}
      {Boolean(result.salaryBase.unusablePeriods?.length) && <p>Recibos sin detalle suficiente para el análisis por conceptos: {result.salaryBase.unusablePeriods!.map(periodLabel).join(', ')}. Podés afinar ese análisis más adelante; no impide estimar con el sueldo indicado.</p>}
      {Object.keys(result.inputs.overrides).length > 0 && <p>Esta estimación incluye datos ingresados sólo para simular. Los documentos originales y sus datos se conservan.</p>}
      {result.inputs.collectiveAgreement && <p>Tope: <MoneyValue value={result.inputs.collectiveAgreement.capAmount} currency={result.currencyCode} /> · versión {result.inputs.collectiveAgreement.version} · {dateLabel(result.inputs.collectiveAgreement.effectiveFrom)} a {dateLabel(result.inputs.collectiveAgreement.effectiveTo)}. <a className="inline-link" href={result.inputs.collectiveAgreement.sourceUrl} target="_blank" rel="noreferrer">Fuente del convenio</a></p>}
      </details>
      {result.salaryBase.trace.length > 0 && <details className="panel"><summary>Por qué se incluyó o excluyó cada concepto</summary><ul className="termination-trace">{result.salaryBase.trace.map((line, index) => <li key={`${line.settlementId}-${index}`}>
        <strong>{periodLabel(line.period)} · {earningLabels[line.code] ?? (settlementTypeLabel(line.code) !== '—' ? settlementTypeLabel(line.code) : 'Concepto sin clasificar')}</strong>
        {line.sourceDescription && <span>Concepto en el recibo: <SensitiveValue value={line.sourceDescription} /></span>}
        <span>{treatmentLabels[line.treatment]} · <MoneyValue value={line.amount} currency={result.currencyCode} /></span><p>{line.explanation}</p>
        <a className="inline-link" href={`/${writeDocumentLocation(writeOwnerLocation('', { section: 'history', tab: 'documents', employmentId: result.inputs.employment.id, currencyCode: result.currencyCode }), { documentId: line.documentId, review: 'termination', lineItemId: line.lineItemId })}`}>Revisar motivo en el recibo</a>
      </li>)}</ul></details>}
      {result.assumptions.length > 0 && <details className="panel"><summary>Supuestos de esta estimación</summary><ul>{result.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></details>}
      {result.legalRuleVersion && <details className="panel"><summary>Normativa y fuentes</summary><p>Vigencia: {dateLabel(result.legalRuleVersion.effectiveFrom)} a {result.legalRuleVersion.effectiveTo ? dateLabel(result.legalRuleVersion.effectiveTo) : 'sin cierre configurado'}. Revisión: {dateLabel(result.legalRuleVersion.reviewedAt)}.</p><ul>{result.legalRuleVersion.references.map((source) => <li key={source.url}><a className="inline-link" href={source.url} target="_blank" rel="noreferrer">{source.name}</a></li>)}</ul><small>Cálculo: {result.calculationVersion}</small></details>}
      <p className="termination-disclaimer">{result.disclaimer}</p>
    </section>}
  </div>;
}
