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
  legalRuleVersion: { code: string; version: string; effectiveFrom: string; effectiveTo: string | null; reviewedAt: string; references: { name: string; url: string }[] } | null;
  calculationVersion: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warnings: string[]; assumptions: string[]; disclaimer: string;
  salaryBase: {
    amount: string | null; currentMonthlyRemuneration: string | null; selectedPeriod: string | null;
    source: 'DOCUMENTS' | 'SIMULATION_OVERRIDE' | 'UNAVAILABLE'; analyzedDocumentIds: string[]; missingPeriods: string[]; unusablePeriods?: string[];
    trace: { documentId: string; settlementId: string; lineItemId?: string; sourceDescription?: string | null; period: string; code: string; amount: string; treatment: 'INCLUDED' | 'EXCLUDED' | 'AVERAGED' | 'REVIEW_REQUIRED'; explanation: string }[];
  };
  scenarios: { code: 'WITH_NOTICE' | 'WITHOUT_NOTICE'; total: string; notice: { unit: 'MONTHS' | 'DAYS'; value: number }; breakdown: { code: string; name: string; amount: string; explanation: string; ruleOrigin: string }[] }[];
  inputs: {
    employment: Employment; startDate: string | null; startDateSource: 'CONFIRMED' | 'EXTRACTED' | 'UNKNOWN' | 'SIMULATION_OVERRIDE';
    terminationDate: string; isProjection: boolean; seniority: { years: number; months: number; days: number; indemnityYears: number } | null;
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
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const overridesDetails = useRef<HTMLDetailsElement>(null);
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
    for (const key of ['startDate', 'cctCode', 'cctCategory']) if (form.get(key)) overrides[key] = String(form.get(key));
    for (const key of ['monthlyRemuneration', 'vacationDaysTaken', 'priorVacationDays', 'sacAlreadyPaid']) {
      if (form.get(key)) overrides[key] = normalizeReviewValue('settlement.grossAmount', String(form.get(key)));
    }
    if (capOverride) overrides.cctCapVersion = {
      version: `manual-${form.get('capEffectiveFrom')}`, cctCode: form.get('cctCode'), category: form.get('cctCategory') || null,
      capAmount: normalizeReviewValue('settlement.grossAmount', String(form.get('capAmount'))),
      effectiveFrom: form.get('capEffectiveFrom'), effectiveTo: form.get('capEffectiveTo'), sourceUrl: form.get('capSourceUrl'),
    };
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await api<Estimate>(`/employments/${employment.id}/termination-estimate`, { method: 'POST', body: JSON.stringify({ terminationDate: date, terminationType: 'DISMISSAL_WITHOUT_CAUSE', overrides }) }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos calcular la estimación. Revisá los datos e intentá de nuevo.'); }
    finally { setBusy(false); }
  }
  const inputType = privateMode ? 'password' : 'text';
  const documentsHref = employment ? `/${writeOwnerLocation('', { section: 'history', tab: 'documents', employmentId: employment.id, currencyCode: employment.currencyCode })}` : '/?section=history&tab=documents';
  const reviewDocuments = [...new Map(result?.salaryBase.trace.filter((line) => line.treatment === 'REVIEW_REQUIRED').map((line) => [line.documentId, line])).values()].sort((a, b) => b.period.localeCompare(a.period));
  const missingSalary = result?.status === 'UNAVAILABLE' && result.inputs.probation !== null && result.salaryBase.amount === null;
  const monthlyReceipts = result?.inputs.salaryInputs.filter((item) => item.settlementType === 'NORMAL') ?? [];
  const latestMonthlyReceipt = [...monthlyReceipts].sort((a, b) => b.payrollPeriod.localeCompare(a.payrollPeriod))[0];
  const salaryReference = latestMonthlyReceipt?.remunerativeAmount && /^[0-9]+\.[0-9]{2}$/.test(latestMonthlyReceipt.remunerativeAmount)
    && !/^0+\.00$/.test(latestMonthlyReceipt.remunerativeAmount)
    && monthlyReceipts.filter((item) => item.payrollPeriod === latestMonthlyReceipt.payrollPeriod).length === 1 ? latestMonthlyReceipt : null;
  const enterSalary = () => {
    if (overridesDetails.current) overridesDetails.current.open = true;
    monthlyRemuneration.current?.focus(); monthlyRemuneration.current?.scrollIntoView({ block: 'center' });
  };
  return <div className="page termination-page" aria-busy={loading || busy}>
    <div className="page-header"><div><p className="eyebrow">Tu relación laboral</p><h1>Indemnización estimada</h1></div><PrivacyToggle /></div>
    <p className="page-intro">Compará un despido sin causa con el preaviso cumplido y sin preaviso, usando los datos de un empleo.</p>
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
    {employment && <form className="panel stack-form" onSubmit={calculate} onChange={() => setResult(null)}>
      <div className="panel-heading"><div><p className="eyebrow">Despido sin causa</p><h2>Preparar simulación</h2></div><a className="inline-link" href={documentsHref}>Ver recibos de este empleo</a></div>
      <p>Elegí la fecha y calculá con los recibos ya analizados. Si falta información, te indicaremos qué recibo revisar. También podés ingresar una remuneración para probar una estimación.</p>
      <div className="field-row"><label>Fecha efectiva de finalización<input name="terminationDate" type="date" value={date} onChange={(event) => setDate(event.target.value)} required disabled={busy} /></label><div className="termination-today"><button type="button" className="button secondary" disabled={busy} onClick={() => { setDate(today()); setResult(null); }}>Hoy</button></div></div>
      {date > today() && <p>Esta simulación supone que tu remuneración se mantiene igual a la última conocida, salvo que ingreses otra. Es una proyección.</p>}
      {date < today() && <p>El cálculo histórico utiliza la normativa y la información salarial correspondientes hasta esa fecha.</p>}
      <details ref={overridesDetails}><summary>Corregir datos sólo para esta simulación</summary><div className="stack-form termination-overrides">
        <p>Completá sólo lo que quieras ajustar; el resto usa el dato disponible. Estos cambios no modifican el empleo ni los datos de los PDFs.</p>
        <div className="field-row"><label>Usar otra fecha de ingreso<input name="startDate" type="date" disabled={busy} /><small>Registrada: {dateLabel(employment.startDate)}</small></label><label>Remuneración mensual bruta normal y habitual ({employment.currencyCode})<input ref={monthlyRemuneration} name="monthlyRemuneration" type={inputType} inputMode="decimal" autoComplete="off" placeholder="Importe para esta simulación" maxLength={24} disabled={busy} /><small>No uses el salario neto.</small></label></div>
        <div className="field-row"><label>Convenio colectivo (CCT)<input name="cctCode" placeholder="Código del convenio, si lo conocés" maxLength={80} required={capOverride} disabled={busy} /></label><label>Categoría del convenio<input name="cctCategory" maxLength={120} disabled={busy} /></label></div>
        <label className="termination-check"><input type="checkbox" checked={capOverride} disabled={busy} onChange={(event) => setCapOverride(event.target.checked)} />Tengo un tope de convenio con fuente y vigencia para revisar</label>
        {capOverride && <div className="stack-form"><label>Tope aplicable ({employment.currencyCode})<input name="capAmount" type={inputType} inputMode="decimal" autoComplete="off" maxLength={24} required disabled={busy} /></label><div className="field-row"><label>Vigente desde<input type="date" name="capEffectiveFrom" required disabled={busy} /></label><label>Vigente hasta<input type="date" name="capEffectiveTo" required disabled={busy} /></label></div><label>Fuente del tope<input name="capSourceUrl" type="url" placeholder="https://…" required disabled={busy} maxLength={500} /></label><small>Se mostrará como tope aportado para esta simulación, con su fuente y vigencia.</small></div>}
        <div className="field-row"><label>Días de vacaciones ya gozados este año<input name="vacationDaysTaken" type="text" inputMode="decimal" maxLength={8} disabled={busy} /></label><label>Días pendientes de años anteriores<input name="priorVacationDays" type="text" inputMode="decimal" maxLength={8} disabled={busy} /></label></div>
        <label>SAC ya pagado en el semestre ({employment.currencyCode})<input name="sacAlreadyPaid" type={inputType} inputMode="decimal" autoComplete="off" maxLength={24} disabled={busy} /></label>
      </div></details>
      <div><button className="button primary" disabled={busy || !date}>{busy ? 'Calculando…' : 'Calcular estimación'}</button></div>
    </form>}
    {busy && <section className="panel" role="status"><div className="loader" aria-hidden="true" /><p>Preparando datos y comparación…</p></section>}
    {result && <section className="termination-result stack-form" aria-label="Resultado de la estimación" aria-live="polite">
      <div className="panel-heading"><div><p className="eyebrow">{result.inputs.isProjection ? 'Proyección' : 'Estimación'} · {dateLabel(result.inputs.terminationDate)}</p><h2 ref={resultTitle} tabIndex={-1}>{result.status === 'AVAILABLE' ? 'Comparación de escenarios' : result.status === 'UNSUPPORTED' ? 'Régimen o fecha sin cobertura' : missingSalary ? 'Falta resolver la remuneración mensual' : 'Faltan datos para calcular'}</h2></div>{result.status === 'AVAILABLE' && <span className={`status ${result.confidence === 'HIGH' ? 'ready' : 'pending'}`}>Completitud {qualityLabels[result.confidence].toLowerCase()}</span>}</div>
      {missingSalary && <section className="panel stack-form termination-next-step" aria-labelledby="termination-next-step-title">
        <h3 id="termination-next-step-title">Cómo continuar</h3>
        <p>{result.salaryBase.analyzedDocumentIds.length > 0 ? `Analizamos ${result.salaryBase.analyzedDocumentIds.length} recibo${result.salaryBase.analyzedDocumentIds.length === 1 ? '' : 's'} de este empleo, pero no pudimos separar con certeza la remuneración mensual normal y habitual. Los PDFs ya están cargados; no hace falta subirlos otra vez.` : 'Todavía no hay recibos utilizables para este empleo y esta fecha. Revisá si están asociados al empleo, terminaron de analizarse o tienen una nueva lectura pendiente de tu confirmación.'}</p>
        <div className="inline-actions"><a className="button primary" href={reviewDocuments.length ? `/${writeDocumentLocation(documentsHref.slice(1), { documentId: reviewDocuments[0].documentId, review: 'termination', lineItemId: reviewDocuments[0].lineItemId })}` : documentsHref}>{reviewDocuments.length ? 'Revisar el recibo más reciente' : 'Revisar recibos del empleo'}</a><button type="button" className="button secondary" onClick={enterSalary}>Ingresar remuneración para esta simulación</button></div>
        <p>Si conocés tu remuneración bruta normal y habitual, podés ingresarla y volver a calcular. El importe queda sólo en esta simulación; no uses el neto cobrado.</p>
        {salaryReference && <div className="termination-salary-reference stack-form"><strong>Un importe de referencia ya está en tu recibo</strong><p>Total remunerativo de {periodLabel(salaryReference.payrollPeriod)}: <MoneyValue value={salaryReference.remunerativeAmount} currency={result.currencyCode} />.</p><p>Puede incluir vacaciones, premios, retroactivos o ajustes. Revisá que represente tu remuneración mensual normal y habitual antes de calcular.</p><div className="inline-actions"><button type="button" className="button secondary" onClick={() => { enterSalary(); if (monthlyRemuneration.current) monthlyRemuneration.current.value = salaryReference.remunerativeAmount!; }}>Completar con este importe y revisarlo</button><a className="inline-link" href={`/${writeDocumentLocation(documentsHref.slice(1), { documentId: salaryReference.documentId, review: 'termination' })}`}>Ver recibo de referencia</a></div></div>}
        {reviewDocuments.length > 0 && <details><summary>Recibos con datos para revisar ({reviewDocuments.length})</summary><ul className="termination-review-documents">{reviewDocuments.map((line) => <li key={line.documentId}><div><strong>{periodLabel(line.period)}</strong><p>{line.explanation}</p></div><a className="inline-link" href={`/${writeDocumentLocation(documentsHref.slice(1), { documentId: line.documentId, review: 'termination', lineItemId: line.lineItemId })}`}>Revisar recibo de {periodLabel(line.period)}</a></li>)}</ul></details>}
      </section>}
      {result.status === 'UNAVAILABLE' && !result.inputs.startDate && <section className="panel stack-form"><h3>Completá la fecha de ingreso</h3><p>Es necesaria para calcular la antigüedad. Podés confirmarla en tu empleo.</p><button type="button" className="button secondary" onClick={onManageEmployment}>Revisar datos del empleo</button></section>}
      {result.scenarios.length > 0 && <dl className="panel termination-mobile-totals" aria-label="Totales estimados de ambos escenarios">{result.scenarios.map((scenario) => <div key={scenario.code}><dt>{scenario.code === 'WITH_NOTICE' ? 'Con preaviso' : 'Sin preaviso'}</dt><dd><MoneyValue value={scenario.total} currency={result.currencyCode} /></dd></div>)}</dl>}
      {result.warnings.length > 0 && <details className="panel" open={result.status !== 'AVAILABLE' && !missingSalary}><summary>{result.status === 'AVAILABLE' ? 'Alcance y datos por confirmar' : 'Detalle de los datos pendientes'} ({result.warnings.length})</summary>{result.status === 'AVAILABLE' && <p>Ya podés ver la estimación. Estos puntos explican sus límites y qué datos permitirían afinarla.</p>}<ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><div className="inline-actions"><a className="inline-link" href={documentsHref}>Ver recibos de este empleo</a><button type="button" className="text-button" onClick={onManageEmployment}>Revisar empleo</button></div></details>}
      <div className="termination-scenarios">{result.scenarios.map((scenario) => <article className="panel termination-scenario" key={scenario.code}>
        <h3>{scenario.code === 'WITH_NOTICE' ? 'Con preaviso' : 'Sin preaviso'}</h3><p>{scenario.code === 'WITH_NOTICE' ? 'Período de preaviso cumplido completamente.' : 'Incluye los conceptos que corresponden por falta de preaviso.'}</p>
        <small>Total estimado</small><strong className="termination-total"><MoneyValue value={scenario.total} currency={result.currencyCode} /></strong>
        <p>Preaviso requerido: {scenario.notice.value} {scenario.notice.unit === 'MONTHS' ? 'meses' : 'días'}.</p>
        <dl className="termination-breakdown">{scenario.breakdown.map((line) => <div key={line.code}><dt>{line.name}</dt><dd><MoneyValue value={line.amount} currency={result.currencyCode} /></dd><details><summary>¿Cómo se calculó?</summary><p>{line.explanation}</p><small>{line.ruleOrigin}</small></details></div>)}</dl>
      </article>)}</div>
      <section className="panel"><h3>Datos utilizados para esta estimación</h3><dl className="termination-inputs">
        <div><dt>Empresa</dt><dd>{result.inputs.employment.employerName}</dd></div><div><dt>País del empleo</dt><dd>{result.inputs.employment.countryCode ? countryName(result.inputs.employment.countryCode) : 'Sin confirmar'}</dd></div>
        <div><dt>Fecha de ingreso</dt><dd>{dateLabel(result.inputs.startDate)} · {sourceLabels[result.inputs.startDateSource]}</dd></div><div><dt>Fecha simulada de egreso</dt><dd>{dateLabel(result.inputs.terminationDate)}</dd></div>
        <div><dt>Antigüedad computada</dt><dd>{result.inputs.seniority ? `${result.inputs.seniority.years} años, ${result.inputs.seniority.months} meses y ${result.inputs.seniority.days} días` : 'No disponible'}</dd></div>
        <div><dt>Base salarial seleccionada</dt><dd><MoneyValue value={result.salaryBase.amount} currency={result.currencyCode} /> · {sourceLabels[result.salaryBase.source]}{result.salaryBase.selectedPeriod ? ` · ${periodLabel(result.salaryBase.selectedPeriod)}` : ''}</dd></div>
        <div><dt>Base tras el tope y piso aplicables</dt><dd><MoneyValue value={result.inputs.cappedSalaryBase} currency={result.currencyCode} /></dd></div><div><dt>Remuneración mensual usada</dt><dd><MoneyValue value={result.salaryBase.currentMonthlyRemuneration} currency={result.currencyCode} /></dd></div>
        <div><dt>Recibos analizados</dt><dd>{result.salaryBase.analyzedDocumentIds.length}</dd></div><div><dt>Convenio</dt><dd>{result.inputs.collectiveAgreement ? `${result.inputs.collectiveAgreement.cctCode}${result.inputs.collectiveAgreement.category ? ` · ${result.inputs.collectiveAgreement.category}` : ''}` : 'Sin tope de convenio confirmado'}</dd></div>
        <div><dt>Versión normativa</dt><dd>{result.legalRuleVersion ? `${result.legalRuleVersion.code} / ${result.legalRuleVersion.version}` : 'Sin cobertura configurada'}</dd></div>
      </dl>
      {result.salaryBase.missingPeriods.length > 0 && <p>Períodos sin recibos analizados: {result.salaryBase.missingPeriods.map(periodLabel).join(', ')}.</p>}
      {Boolean(result.salaryBase.unusablePeriods?.length) && <p>Períodos con recibos que no permiten calcular la base: {result.salaryBase.unusablePeriods!.map(periodLabel).join(', ')}. Revisá los motivos en el detalle de conceptos.</p>}
      {Object.keys(result.inputs.overrides).length > 0 && <p>Esta estimación incluye datos ingresados sólo para simular. Los documentos originales y sus datos se conservan.</p>}
      {result.inputs.collectiveAgreement && <p>Tope: <MoneyValue value={result.inputs.collectiveAgreement.capAmount} currency={result.currencyCode} /> · versión {result.inputs.collectiveAgreement.version} · {dateLabel(result.inputs.collectiveAgreement.effectiveFrom)} a {dateLabel(result.inputs.collectiveAgreement.effectiveTo)}. <a className="inline-link" href={result.inputs.collectiveAgreement.sourceUrl} target="_blank" rel="noreferrer">Fuente del convenio</a></p>}
      </section>
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
