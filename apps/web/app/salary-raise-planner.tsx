'use client';

import { useId, useState } from 'react';
import { calculateSalaryRaise, ECONOMIC_SERIES_CODES, MAX_SIMULATED_RAISE_PERCENT } from '@salarivo/economic-data';
import { economicStatusMessage, periodLabel, type EconomicReason, type EconomicStatus } from './format';
import { MoneyValue, PercentageValue, SensitiveValue, usePrivacyMode } from './privacy-mode';
import styles from './salary-raise-planner.module.css';

export type SalaryRaisePoint = {
  readonly period: string;
  readonly regular: { readonly netAmount: string | null; readonly basicAmount?: string | null; readonly grossAmount?: string | null };
  readonly regularMixed?: boolean;
  readonly quality?: { readonly incompleteDocuments: number };
  readonly economic?: {
    readonly purchasingPower: {
      readonly status: EconomicStatus;
      readonly reason: EconomicReason;
      readonly currencyCode: string;
      readonly referencePeriod: string | null;
      readonly regularAmounts?: { readonly netAmount: string | null } | null;
      readonly observations: readonly {
        readonly seriesCode: string;
        readonly observationDate: string;
        readonly requestedDate: string;
        readonly selectionMethod: string;
        readonly revision: number;
        readonly source: string;
        readonly provider: string;
        readonly methodology: string;
      }[];
    };
  };
};

export function SalaryRaisePlanner({ currencyCode, countryCode, points, onViewPeriod }: {
  currencyCode: string;
  countryCode?: string | null;
  points: readonly SalaryRaisePoint[];
  onViewPeriod: (period: string) => void;
}) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const inputId = useId();
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [increasePercent, setIncreasePercent] = useState('10');
  const regularPoints = [...points].filter((point) => point.regularMixed || point.quality?.incompleteDocuments
    || [point.regular.netAmount, point.regular.basicAmount, point.regular.grossAmount].some((amount) => amount != null))
    .sort((a, b) => a.period.localeCompare(b.period));
  const latest = regularPoints.at(-1);
  const bases = regularPoints.filter((point) => latest && point.period < latest.period);
  const base = bases.find((point) => point.period === selectedPeriod) ?? bases.at(-1);
  const projection = base?.economic?.purchasingPower;
  const latestProjection = latest?.economic?.purchasingPower;
  const referencePeriod = projection?.referencePeriod;
  const targetNetAmount = projection?.regularAmounts?.netAmount;
  const isMonth = (value: string) => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
  const observations = projection?.observations ?? [];
  const priceObservations = observations.filter((observation) => observation.seriesCode === ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX);
  const hasSource = priceObservations.some((observation) => observation.selectionMethod === 'EXACT_PERIOD'
    && observation.requestedDate === `${base?.period}-01` && observation.observationDate === `${base?.period}-01`);
  const hasReference = priceObservations.some((observation) => observation.selectionMethod === 'LATEST_AVAILABLE'
    && observation.observationDate === `${referencePeriod}-01`);
  let unavailable = '';
  if (countryCode !== 'AR' || currencyCode !== 'ARS') {
    unavailable = 'Para preparar un aumento con IPC necesitás un empleo de Argentina con sueldo en ARS y país confirmado.';
  } else if (!latest || !base) {
    unavailable = 'Necesitás al menos dos períodos de sueldo habitual del mismo empleo. Importá otro recibo para elegir un mes de referencia.';
  } else if (latest.regularMixed || base.regularMixed) {
    unavailable = 'Uno de los períodos mezcla sueldo y pagos extraordinarios sin poder separar el neto habitual. Revisá sus recibos antes de calcular.';
  } else if (latest.quality?.incompleteDocuments || base.quality?.incompleteDocuments) {
    unavailable = 'Uno de los períodos tiene recibos con análisis incompleto. Revisalos antes de usar sus importes para preparar un aumento.';
  } else if (latest.regular.netAmount == null || base.regular.netAmount == null) {
    unavailable = 'Falta el neto habitual de uno de los períodos. Revisá sus recibos; el total con aguinaldo u otros pagos no reemplaza ese dato.';
  } else if (latest.regular.basicAmount == null || base.regular.basicAmount == null) {
    unavailable = 'Falta un básico comparable o hay liquidaciones ambiguas en uno de los períodos. Revisá sus recibos antes de usar el neto para preparar un aumento.';
  } else if (!projection || projection.status !== 'AVAILABLE') {
    unavailable = `${economicStatusMessage(projection?.status ?? 'UNAVAILABLE', projection?.reason)} El mes de referencia necesita cobertura IPC completa para calcular el objetivo.`;
  } else if (!referencePeriod || !isMonth(referencePeriod) || !isMonth(base.period) || !isMonth(latest.period)
    || referencePeriod < base.period || referencePeriod > new Date().toISOString().slice(0, 7)
    || projection.currencyCode !== currencyCode
    || (latestProjection?.referencePeriod && latestProjection.referencePeriod !== referencePeriod)
    || !hasSource || !hasReference || targetNetAmount == null) {
    unavailable = 'Falta una referencia IPC coherente con el neto habitual de ese mes. No podemos calcular el objetivo con los datos disponibles.';
  }
  let plan: ReturnType<typeof calculateSalaryRaise> | null = null;
  let simulation: ReturnType<typeof calculateSalaryRaise> | null = null;
  let invalidPercent = false;
  if (!unavailable && latest?.regular.netAmount && targetNetAmount) {
    try {
      plan = calculateSalaryRaise({ currencyCode, latestNetAmount: latest.regular.netAmount, targetNetAmount, increasePercent: '0' });
    } catch {
      unavailable = 'El cálculo necesita netos habituales positivos, válidos y con hasta dos decimales. Revisá los datos de los períodos elegidos.';
    }
    if (plan) {
      try {
        simulation = calculateSalaryRaise({ currencyCode, latestNetAmount: latest.regular.netAmount, targetNetAmount, increasePercent: increasePercent.replace(',', '.') });
      } catch {
        invalidPercent = true;
      }
    }
  }
  const simulationReading = simulation?.simulatedDifferenceToTarget === '0.00'
    ? 'El neto simulado alcanza exactamente el objetivo.'
    : simulation?.simulatedDifferenceToTarget.startsWith('-')
      ? 'El neto simulado queda por debajo del objetivo.'
      : 'El neto simulado supera el objetivo.';

  return <details className={`panel salary-raise-planner ${styles.planner}`}>
    <summary>Preparar un aumento</summary>
    <div className={`stack-form ${styles.body}`}>
      <p>Elegí un sueldo de referencia y calculá qué neto conservaría su poder de compra al último IPC disponible.</p>
      {bases.length > 0 && <label>Mes de referencia<select aria-label="Mes de referencia" value={base?.period ?? ''} onChange={(event) => setSelectedPeriod(event.target.value)}>
        {bases.map((point) => <option key={point.period} value={point.period}>{periodLabel(point.period)}</option>)}
      </select></label>}
      {unavailable && <p className="message warning" role="status">{unavailable}</p>}
      {plan && base && latest && referencePeriod && <>
        <p className="coverage-note">IPC hasta {periodLabel(referencePeriod)}. Último sueldo habitual registrado: {periodLabel(latest.period)}. Son las fechas disponibles; no asumimos que ese sueldo siga vigente ni proyectamos inflación posterior.</p>
        {latestProjection && latestProjection.status !== 'AVAILABLE' && <p className="message warning">IPC del último recibo: {economicStatusMessage(latestProjection.status, latestProjection.reason)} El objetivo usa el IPC completo del mes de referencia; la simulación parte del último neto nominal registrado.</p>}
        <dl className={styles.values}>
          <div><dt>Neto del mes de referencia</dt><dd><MoneyValue value={base.regular.netAmount} currency={currencyCode} kind="salary" /></dd></div>
          <div><dt>Objetivo a precios de {periodLabel(referencePeriod)}</dt><dd><MoneyValue value={targetNetAmount} currency={currencyCode} kind="salary" /></dd></div>
          <div><dt>Último neto habitual registrado</dt><dd><MoneyValue value={latest.regular.netAmount} currency={currencyCode} kind="salary" /></dd></div>
          <div><dt>Aumento para alcanzar el objetivo</dt><dd><PercentageValue value={plan.requiredIncreasePercent} /></dd></div>
        </dl>
        <p><SensitiveValue value={plan.requiredIncreasePercent === '0.00'
          ? 'El último neto registrado ya alcanza ese objetivo; no necesita un aumento para igualarlo.'
          : 'Este aumento se calcula sobre el último neto habitual registrado para alcanzar el objetivo.'} mask="Resultado oculto por modo privacidad" /></p>
        {privacyEnabled ? <div><p>Aumento sobre el último neto habitual (%): <PercentageValue value={increasePercent.replace(',', '.')} /></p><p className="coverage-note">Mostrá los importes para editar la simulación.</p></div>
          : <label htmlFor={inputId}>Aumento sobre el último neto habitual (%)<input id={inputId} type="text" inputMode="decimal" autoComplete="off" maxLength={7} value={increasePercent} onChange={(event) => setIncreasePercent(event.target.value)} aria-invalid={invalidPercent} aria-describedby={`${inputId}-help${invalidPercent ? ` ${inputId}-error` : ''}`} />
            <small id={`${inputId}-help`}>Entre 0 y {MAX_SIMULATED_RAISE_PERCENT}%, hasta dos decimales. Podés usar coma o punto.</small>
          </label>}
        {!privacyEnabled && invalidPercent && <p className="message error" id={`${inputId}-error`} role="alert">Ingresá un porcentaje entre 0 y {MAX_SIMULATED_RAISE_PERCENT}, con hasta dos decimales.</p>}
        <p className="coverage-note">Simulamos un aumento del neto de {periodLabel(latest.period)}. No es un aumento del bruto ni una predicción de descuentos, impuestos o del próximo recibo. No se guarda.</p>
        {simulation && <div className="salary-raise-results" role="status" aria-live="polite">
          <dl className={styles.values}>
            <div><dt>Neto simulado</dt><dd><MoneyValue value={simulation.simulatedNetAmount} currency={currencyCode} kind="salary" /></dd></div>
            <div><dt>Diferencia contra el objetivo</dt><dd><MoneyValue value={simulation.simulatedDifferenceToTarget} currency={currencyCode} kind="salary" /></dd></div>
          </dl>
          <p><SensitiveValue value={simulationReading} mask="Resultado oculto por modo privacidad" /></p>
        </div>}
        <details className="economic-evidence">
          <summary>Fuente y cálculo del objetivo</summary>
          <p>Ajustamos cada neto habitual del mes elegido × IPC de {periodLabel(referencePeriod)} ÷ IPC de {periodLabel(base.period)} y sumamos los importes, sin aguinaldo ni pagos extraordinarios. El objetivo reutiliza el ajuste del historial, con importes exactos a dos decimales. El porcentaje necesario se redondea hacia arriba a dos decimales para alcanzar el objetivo.</p>
          <p>La simulación multiplica el último neto nominal por (1 + aumento ÷ 100) y redondea a centavos. La diferencia es neto simulado menos objetivo.</p>
          <ul>{priceObservations.map((observation, index) => <li key={`${observation.selectionMethod}-${observation.observationDate}-${index}`}>
            <strong>{observation.source || observation.provider} · {periodLabel(observation.observationDate)} · revisión {observation.revision}</strong>
            <p>{observation.selectionMethod === 'EXACT_PERIOD' ? 'IPC del mes de referencia.' : 'Último IPC disponible.'} {observation.methodology}</p>
          </li>)}</ul>
          <div className="economic-source-links"><a href="https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31" target="_blank" rel="noopener noreferrer">Fuente: INDEC, IPC nacional</a><a href="https://www.datos.gob.ar/es/dataset/sspm-indice-precios-al-consumidor-nacional-ipc-base-diciembre-2016/archivo/sspm_145.3" target="_blank" rel="noopener noreferrer">Serie en Datos Argentina</a></div>
        </details>
      </>}
      {(base || latest) && <div className={styles.actions}>
        {base && <button type="button" className="text-button" onClick={() => onViewPeriod(base.period)}>Ver recibo de referencia</button>}
        {latest && <button type="button" className="text-button" onClick={() => onViewPeriod(latest.period)}>Ver último período</button>}
      </div>}
    </div>
  </details>;
}
