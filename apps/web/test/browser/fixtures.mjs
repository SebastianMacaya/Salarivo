// Synthetic browser-only data. This never seeds a database or contacts a real account.
import { analyzeSalaryHistory, compareSalaryPeriods } from '../../../api/src/salary-analytics.ts';
import { addEconomicProjections, buildEconomicAnalytics, compareEconomicPeriods } from '../../../api/src/economic-analytics.ts';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-01T12:00:00.000Z';
const employerName = 'Empresa Sintética de Investigación y Desarrollo Internacional con Nombre Extenso';
const amount = (cents) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const settlements = Array.from({ length: 20 }, (_, index) => {
  const basic = 120000000n + BigInt(index) * 1250042n;
  return { id: id(200 + index), documentId: id(300 + index), employmentId: id(10), employmentContext: id(10), employmentStartPeriod: '2025-01', employmentStatus: 'ACTIVE', currencyCode: 'ARS', payrollPeriod: `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`, settlementType: 'NORMAL', isRecurring: true, basicAmount: amount(basic), grossAmount: amount(basic + 50000000n), netAmount: amount(basic + 20000000n), deductionsAmount: '300000.00', remunerativeAmount: amount(basic + 50000000n), nonRemunerativeAmount: '0.00', earnings: [{ code: 'BASIC_SALARY', amount: amount(basic), isRecurring: true }] };
});
const analytics = analyzeSalaryHistory(settlements);
const last = settlements.at(-1);
const permissions = ['dashboard.read', 'users.read_metadata', 'users.read_contact', 'users.status.update', 'sessions.revoke', 'documents.read_metadata', 'documents.quarantine', 'employers.read_metadata', 'processing.read', 'processing.retry', 'processing.cancel', 'processing.reprocess', 'processing.rollback', 'storage.read', 'privacy.read', 'security.read', 'audit.read', 'legal.manage', 'settings.read', 'system.health.read', 'roles.manage'];
const employment = { id: id(10), employerId: id(20), employerName, role: 'Especialista en sistemas y operaciones de prueba', startDate: '2025-01-01', endDate: null, status: 'ACTIVE', countryCode: 'AR', countryConfirmedAt: now, statusConfirmedAt: now, legalRegimeCode: 'AR_LCT_GENERAL', employmentType: 'DEPENDENT', currencyCode: 'ARS', isFavorite: true, employerStatus: 'VERIFIED' };
export const manyEmployments = [
  ['Estudio Delta', 'Asistente', '2013-01-01', '2014-12-31'],
  ['Cooperativa Ñandú', 'Analista de datos', '2026-02-01', null],
  [employerName, 'Analista de sistemas', '2022-04-01', '2024-12-31'],
  ['Servicios del Sur', 'Coordinación técnica', '2021-01-01', '2022-03-31'],
  ['Taller Horizonte', 'Soporte', '2019-01-01', '2020-12-31'],
  ['Laboratorio Álamo', 'Investigación', '2018-01-01', '2018-12-31'],
  ['Fundación Río', 'Administración', '2017-01-01', '2017-12-31'],
  ['Consultora del Centro', 'Operaciones', '2016-01-01', '2016-12-31'],
  ['Comercio Aurora', 'Atención al cliente', '2015-01-01', '2015-12-31'],
  ['Proyecto Inicial', null, '2012-01-01', '2012-12-31'],
  ['Archivo Pendiente', null, '2011-01-01', null, 'UNKNOWN'],
].map(([name, role, startDate, endDate, status], index) => ({ ...employment, id: id(600 + index), employerId: name === employerName ? employment.employerId : id(700 + index), employerName: name, role, startDate, endDate, status: status || (endDate ? 'ENDED' : 'ACTIVE'), isFavorite: index === 0 })).concat(employment);
const user = { id: id(1), email: 'persona.sintetica@example.test', displayName: 'Persona Sintética', role: 'USER', adminRole: null, permissions: [], authState: 'AUTHENTICATED', mfaEnabled: true, onboardingCompleted: true, legalAcceptanceRequired: false, authMethods: ['GOOGLE'], primaryCountryCode: 'AR', primaryCountryConfirmedAt: now };
const history = { calculationVersion: 'salary-analytics-v2', economicCalculationVersion: 'economic-analytics-v2', analytics, contexts: [{ employmentContext: id(10), employmentId: id(10), employerName, state: 'CONFIRMED', countryCode: 'AR', currencyCode: 'ARS', isFavorite: true, employmentStatus: 'ACTIVE', startDate: '2025-01-01', endDate: null, firstPeriod: '2025-01', lastPeriod: '2026-08' }], coverage: { documents: 20, activeEmployments: 1, completedDocuments: 20, needsReviewDocuments: 0, pendingReviewDocuments: 0, unassociatedDocuments: 0, analyzedSettlements: 20, reprocessing: { candidateDocuments: 0, processingDocuments: 0, reviewRequiredDocuments: 0 } } };
// Constant salary, exchange rate and IPC make any SAC-induced salary drop a regression.
const sacSettlements = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((period, index) => ({
  ...settlements[0], id: id(800 + index), documentId: id(900 + index), payrollPeriod: period, employmentStartPeriod: '2025-11',
  countryCode: 'AR', paymentDate: null, issueDate: null, basicAmount: '90000.00', grossAmount: '100000.00', netAmount: '80000.00', deductionsAmount: '20000.00', remunerativeAmount: '100000.00', earnings: [{ code: 'BASIC_SALARY', amount: '90000.00', isRecurring: true }],
}));
for (const [period, type, gross, net, deductions] of [['2025-12', 'SAC', '50000.00', '40000.00', '10000.00'], ['2026-06', 'SAC', '50000.00', '40000.00', '10000.00'], ['2026-03', 'BONUS', '20000.00', '16000.00', '4000.00']]) {
  sacSettlements.push({ ...sacSettlements[0], id: id(800 + sacSettlements.length), documentId: id(900 + sacSettlements.length), payrollPeriod: period, settlementType: type, isRecurring: false, basicAmount: '0.00', grossAmount: gross, netAmount: net, deductionsAmount: deductions, remunerativeAmount: gross, earnings: [{ code: type, amount: gross, isRecurring: false }] });
}
const syntheticEconomicData = { async query(_sql, values) {
  return { rows: JSON.parse(values[0]).map((request) => {
    const fx = request.series_code.startsWith('FX.');
    const date = request.selection === 'LATEST' ? '2026-07-01' : request.target_date;
    const missing = !fx && date === '2026-08-01';
    return { ...request, requested_series_code: request.series_code, series_id: fx ? 'synthetic-fx' : 'synthetic-cpi', external_series_id: 'synthetic-series', name: 'Observación sintética', provider_code: 'SYNTHETIC', source_url: 'https://example.test/source', methodology: 'Datos sintéticos constantes.', series_status: 'ACTIVE', series_valid_from: '2020-01-01', series_valid_to: null, series_metadata: { licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' }, observation_id: missing ? null : `${request.series_code}:${date}`, observation_date: missing ? null : date, observation_value: missing ? null : fx ? '1000.000000000000' : '100.000000000000', observation_metadata: { source: 'Fuente sintética' }, revision: 1, fetched_at: now, job_state: missing ? 'PENDING' : 'COMPLETED', job_error_code: null };
  }) };
} };
const sacEconomics = await buildEconomicAnalytics(syntheticEconomicData, sacSettlements);
const sacAnalytics = analyzeSalaryHistory(sacSettlements);
export const sacHistory = { ...history, analytics: { ...sacAnalytics, scopes: addEconomicProjections(sacAnalytics.scopes, sacEconomics) }, contexts: history.contexts.map((context) => ({ ...context, firstPeriod: '2025-11' })), coverage: { ...history.coverage, documents: sacSettlements.length, completedDocuments: sacSettlements.length, analyzedSettlements: sacSettlements.length } };
const sacCompareOptions = { employmentContext: id(10), currencyCode: 'ARS', fromPeriod: '2026-06', toPeriod: '2026-07' };
export const sacComparison = { ...compareSalaryPeriods(sacSettlements, sacCompareOptions), economic: compareEconomicPeriods(sacEconomics, sacCompareOptions) };
const mixedSettlements = sacSettlements.map((settlement) => settlement.payrollPeriod === '2026-07' ? { ...settlement, grossAmount: '150000.00', netAmount: '120000.00', deductionsAmount: '30000.00', remunerativeAmount: '150000.00', earnings: [...settlement.earnings, { code: 'SAC', amount: '50000.00', isRecurring: false }] } : settlement);
const mixedAnalytics = analyzeSalaryHistory(mixedSettlements);
export const mixedSacHistory = { ...sacHistory, analytics: { ...mixedAnalytics, scopes: addEconomicProjections(mixedAnalytics.scopes, await buildEconomicAnalytics(syntheticEconomicData, mixedSettlements)) } };
const documents = [...settlements].reverse().map((settlement) => ({ id: settlement.documentId, employmentId: id(10), employerName, payrollPeriod: settlement.payrollPeriod, settlementType: 'NORMAL', originalFilename: `recibo-sintetico-${settlement.payrollPeriod}-nombre-largo-para-verificar-responsive.pdf`, displayFilename: `Recibo mensual ${settlement.payrollPeriod} · ${employerName}`, createdAt: now, processingStatus: 'COMPLETED', documentType: 'PAYROLL', confidence: '0.99', originalAvailable: true, needsReview: false }));
const run = { id: id(40), processingVersion: 1, status: 'COMPLETED', triggerKind: 'INITIAL', parserVersion: 'synthetic-v1', resultSchemaVersion: '1', pipelineFingerprint: 'synthetic', promotionOutcome: 'PROMOTED', promotedAt: now, startedAt: now, finishedAt: now, active: true, decisionRequired: false };
const detail = { ...documents[0], countryCode: 'AR', countrySource: 'EMPLOYMENT_CONFIRMED', countryConfidence: 'HIGH', countrySnapshotAt: now, classificationStatus: 'SUPPORTED', confidence: '0.99', declaredMimeType: 'application/pdf', detectedMimeType: 'application/pdf', errorCode: null, extractedFields: ['employer.name', 'settlement.type', 'settlement.payrollPeriod', 'settlement.basicAmount', 'settlement.grossAmount', 'settlement.netAmount'].map((fieldPath, index) => ({ id: id(50 + index), fieldPath, confidence: '0.99', correctedValue: null, correction: null, effectiveValue: fieldPath === 'employer.name' ? employerName : fieldPath === 'settlement.type' ? 'NORMAL' : last[fieldPath.replace('settlement.', '')], extractorVersion: 'synthetic-v1', interpretedValue: null, pageNumber: 1, rawValue: null, source: 'PDF_TEXT', sourceRegion: { version: 1, origin: 'TOP_LEFT', space: 'PAGE_NORMALIZED', x: .1, y: .1 + index * .1, width: .4, height: .04 } })), extractionRun: { ...run, confidence: '0.99', extractorName: 'synthetic', extractorVersion: '1', normalizerVersion: '1', ocrProvider: null, ocrVersion: null }, lineItems: [{ id: id(60), amount: last.basicAmount, confidence: '0.99', currencyCode: 'ARS', isRecurring: true, itemOrdinal: 1, itemType: 'EARNING', normalizedConceptCode: 'BASIC_SALARY', rawDescription: 'Concepto sintético con una descripción extensa para probar el ajuste de texto', sourcePage: 1 }], lastReprocessError: null, pageCount: 1, processedAt: now, reviewSettlement: { componentsBalance: true, deductionsMatchTotal: true, totalsBalance: true }, retentionPolicy: 'KEEP_ORIGINAL', securityStatus: 'CLEAN', settlement: last, sizeBytes: 1000, unsupportedFeedback: null, analysis: { status: 'COMPLETED', activeRunId: run.id, currentRun: run, issues: [], reprocess: { available: false, retryAvailable: false, inProgress: false, latestOutcome: 'PROMOTED' } } };
const adminUser = { id: id(2), maskedEmail: 'p***@example.test', status: 'ACTIVE', role: 'USER', adminRole: null, mfaEnabled: true, activeSessions: 2, documentCount: 20, employerCount: 1, storageBytes: 1000000, createdAt: now, lastLoginAt: now };
const adminDocument = { id: detail.id, userId: id(2), maskedEmail: 'p***@example.test', documentType: 'PAYROLL', processingStatus: 'COMPLETED', securityStatus: 'CLEAN', classificationStatus: 'SUPPORTED', sizeBytes: 1000, pageCount: 1, retentionPolicy: 'KEEP_ORIGINAL', originalAvailable: true, createdAt: now, processedAt: now, activeRunStatus: 'COMPLETED', activeParserVersion: 'synthetic-v1', reprocessAvailable: false, issueCount: 0 };
const adminEmployer = { id: id(20), name: employerName, normalizedName: 'empresa sintetica', countryCode: 'AR', status: 'VERIFIED', mergedIntoEmployerId: null, createdSource: 'MANUAL', employmentCount: 1, userCount: 1, documentCount: 20, createdAt: now, updatedAt: now, verifiedAt: now };
const legalDocuments = ['TERMS', 'PRIVACY_NOTICE'].map((documentType, index) => ({ id: id(80 + index), documentType, version: '1.0', title: 'Política sintética para pruebas', publishedAt: now, effectiveAt: now, requiresAcceptance: true, approvedForProduction: false, acknowledgementCount: 1, status: 'CURRENT' }));
const overview = { range: '7D', metrics: { totalUsers: 100, activeUsers: 80, totalDocuments: 1000, pendingReview: 5, activeImports: 2, failedDocuments: 3 }, activity: { newUsers: 4, documentsCreated: 30, completedDocuments: 25, failedJobs: 2, retryableJobs: 1, quarantinedDocuments: 0, pendingPrivacyOperations: 1 }, legalDocuments };
const job = { id: id(90), documentId: detail.id, userId: id(2), stage: 'PARSING', state: 'RETRYABLE', attempt: 1, maxAttempts: 3, errorCode: 'SYNTHETIC_RETRY', processingVersion: 1, availableAt: now, createdAt: now, updatedAt: now, startedAt: now, completedAt: null };

permissions.push('layouts.manage');

export function syntheticPdf() {
  const stream = 'BT /F1 24 Tf 50 740 Td (Salarivo - synthetic test document) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const offset = text.length; text += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return text;
}

const fixtures = { user, permissions, employment, history, documents, detail, run, adminUser, adminDocument, adminEmployer, legalDocuments, overview, job, now, pdf: syntheticPdf(), comparisons: { latest: compareSalaryPeriods(settlements, { employmentContext: id(10), currencyCode: 'ARS', fromPeriod: '2025-01', toPeriod: '2026-08' }) } };

function installFixture(data, options) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Synthetic fixtures require localhost.');
  const nativeFetch = window.fetch.bind(window);
  const state = window.__salarivoFixture = { mode: 'owner', empty: false, failPaths: [], delay: 0, calls: [], unhandled: [], sessions: [1, 2], ...options };
  const readingIds = data.documents.slice(0, 2).map((document) => document.id);
  const readingPending = (documentId) => state.readingImprovement && readingIds.includes(documentId) && !(state.confirmedReadings || []).includes(documentId);
  const readingRun = { ...data.run, id: '00000000-0000-4000-8000-000000000041', processingVersion: 2, active: false, decisionRequired: true, promotionOutcome: 'REVIEW_REQUIRED' };
  localStorage.setItem('salarivo.privacy-mode', state.private ? 'enabled' : 'disabled');
  let batch = null;
  const ok = (result) => Response.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  const page = (items) => ({ items, page: 1, pageSize: 25, total: items.length });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.pathname === '/__qa__/salary.pdf') return new Response(data.pdf, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } });
    if (!url.pathname.startsWith('/api/v1/')) return nativeFetch(input, init);
    const path = url.pathname.slice('/api/v1'.length);
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    state.calls.push({ path, method });
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.failPaths.includes(path)) return Response.json({ error: { code: 'SYNTHETIC_FAILURE', message: 'Error sintético controlado. Reintentá.' } }, { status: 503 });
    if (path === '/auth/me') return state.mode === 'guest' ? Response.json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, { status: 401 }) : ok({ ...data.user, ...(state.mode === 'admin' ? { role: 'ADMIN', adminRole: 'SUPER_ADMIN', permissions: data.permissions } : {}), ...(state.mode === 'mfa' ? { authState: 'MFA_REQUIRED' } : {}), ...(state.mode === 'onboarding' ? { onboardingCompleted: false } : {}), ...(state.mode === 'acceptance' ? { legalAcceptanceRequired: true } : {}) });
    if (path === '/auth/step-up') {
      if (JSON.parse(init.body).code !== '123456') return Response.json({ error: { code: 'INVALID_MFA_CODE', message: 'Código MFA sintético incorrecto.' } }, { status: 401 });
      state.stepUp = true;
      return ok({});
    }
    if (path === '/auth/mfa/verify' && method === 'POST') {
      if (JSON.parse(init.body).code !== '123456') return Response.json({ error: { code: 'INVALID_MFA_CODE', message: 'Código MFA sintético incorrecto.' } }, { status: 401 });
      state.mode = 'owner';
      return ok(data.user);
    }
    if (/^\/admin\/users\/[^/]+\/status$/.test(path) && method === 'POST') return state.stepUp ? ok({}) : Response.json({ error: { code: 'STEP_UP_REQUIRED', message: 'Confirmá tu identidad.' } }, { status: 403 });
    if (path === '/auth/logout') { state.mode = 'guest'; return new Response(null, { status: 204 }); }
    if (path === '/auth/sessions') return ok(state.sessions.map((n) => ({ id: `synthetic-session-${n}`, browser: n === 1 ? 'CHROME' : 'SAFARI', createdAt: data.now, current: n === 1, deviceType: n === 1 ? 'DESKTOP' : 'MOBILE', expiresAt: '2026-10-01T12:00:00.000Z', lastSeenAt: data.now, operatingSystem: n === 1 ? 'WINDOWS' : 'IOS' })));
    if ((/^\/auth\/sessions\/synthetic-session-\d+$/.test(path) && method === 'DELETE') || (path === '/auth/sessions/revoke-others' && method === 'POST')) {
      if (state.stepUpRequired && !state.stepUp) return Response.json({ error: { code: 'STEP_UP_REQUIRED', message: 'Confirmá tu identidad.' } }, { status: 403 });
      const before = state.sessions.length;
      const selected = Number(path.match(/\d+$/)?.[0]);
      state.sessions = state.sessions.filter(n => selected ? n !== selected : n === 1);
      return ok(selected ? { revoked: before !== state.sessions.length } : { revokedSessions: before - state.sessions.length });
    }
    if (path === '/auth/mfa') return ok({ enabled: true, enabledAt: data.now, method: 'TOTP', pendingEnrollment: false, recoveryCodesRemaining: 8 });
    if (path.startsWith('/legal/')) return ok({ version: '1.0', title: 'Política sintética', effectiveAt: data.now, publishedAt: data.now, content: 'Contenido sintético para verificar la lectura responsive.\n\nEstos datos sólo existen dentro de la prueba.', versions: [{ version: '1.0', effectiveAt: data.now, publishedAt: data.now }] });
    if (path === '/profile/country') {
      if (method === 'PATCH') { data.user.primaryCountryCode = JSON.parse(init.body).primaryCountryCode; data.user.primaryCountryConfirmedAt = data.now; }
      return ok({ primaryCountryCode: data.user.primaryCountryCode, primaryCountryConfirmedAt: data.user.primaryCountryConfirmedAt, suggestion: { countryCode: 'AR', confidence: 'MEDIUM', source: 'BROWSER_LOCALE' } });
    }
    if (path === `/employments/${data.employment.id}` && method === 'PATCH') { Object.assign(data.employment, JSON.parse(init.body)); return ok(data.employment); }
    if (path === '/employments') return ok(state.empty ? [] : state.employments || [data.employment]);
    if (path === '/employment-detections') return ok(state.detections || []);
    if (path === '/salary-history') return ok(state.empty ? { ...data.history, contexts: [], analytics: { ...data.history.analytics, scopes: [] } } : state.history || data.history);
    if (path === '/salary-history/concepts') return ok({ items: state.empty ? [] : [{ period: '2026-08', settlementId: 'synthetic-settlement', settlementType: 'NORMAL', earningIndex: 0, category: 'NORMAL', code: 'BASIC_SALARY', isRecurring: true, amount: data.detail.settlement.basicAmount }], nextCursor: null });
    if (path === '/salary-history/comparison') return ok(state.comparison || data.comparisons.latest);
    if (path === '/documents') {
      const items = state.empty ? [] : data.documents.map((document) => ({ ...document, needsReview: Boolean(readingPending(document.id)), decisionRequired: Boolean(readingPending(document.id)) })).filter((document) => !state.readingImprovement || url.searchParams.get('statusGroup') !== 'REVIEW' || document.needsReview);
      return ok({ items: items.slice(0, Number(url.searchParams.get('limit')) || 20), nextCursor: null, pendingReview: state.empty ? 0 : readingIds.filter(readingPending).length, total: items.length });
    }
    if (/^\/documents\/[^/]+\/original$/.test(path)) return ok({ url: `${location.origin}/__qa__/salary.pdf`, expiresAt: '2026-10-01T12:00:00.000Z' });
    if (/^\/documents\/[^/]+\/processing-runs$/.test(path)) return ok({ items: readingPending(path.split('/')[2]) ? [readingRun, data.run] : [data.run] });
    if (/^\/documents\/[^/]+\/processing-runs\/[^/]+$/.test(path)) return ok({ ...readingRun, issues: [], compatiblePromotionCount: state.readingCompatibleCount ?? 2, comparisonPreview: { baseRunId: data.run.id, candidateRunId: readingRun.id, fields: [], lineItems: { beforeCount: 1, afterCount: 1, changed: true, changes: [{ itemOrdinal: 1, before: { ...data.detail.lineItems[0], sourceField: null }, after: { ...data.detail.lineItems[0], sourceField: 'settlement.remunerativeAmount' } }] } } });
    if (/^\/documents\/[^/]+\/processing-runs\/[^/]+\/decision$/.test(path) && method === 'POST') {
      const body = JSON.parse(init.body);
      state.readingDecisions = [...(state.readingDecisions || []), body];
      if (state.changeCompatibleCount) { state.readingCompatibleCount = 1; state.changeCompatibleCount = false; return Response.json({ error: { code: 'COMPATIBLE_PROMOTION_COUNT_CHANGED', message: 'Cambió la cantidad de recibos compatibles.' } }, { status: 409 }); }
      if (body.expectedActiveRunId !== data.run.id) return Response.json({ error: { code: 'ACTIVE_RUN_CHANGED' } }, { status: 409 });
      state.confirmedReadings = [...(state.confirmedReadings || []), ...(body.scope === 'COMPATIBLE' ? readingIds : [path.split('/')[2]])];
      if (state.failAfterReadingDecision) state.failPaths.push(`/documents/${path.split('/')[2]}`);
      return ok({ compatiblePromotionCount: body.scope === 'COMPATIBLE' ? 2 : 1 });
    }
    if (/^\/documents\/[^/]+\/country$/.test(path) && method === 'PATCH') {
      const body = JSON.parse(init.body);
      state.countryRequests = [...(state.countryRequests || []), body];
      const current = state.documentCountry || data.detail;
      if (state.failCountry || body.extractionRunId !== data.detail.extractionRun.id || body.expectedCountryCode !== current.countryCode) return Response.json({ error: { code: 'DOCUMENT_COUNTRY_MISMATCH', message: 'El país no coincide con el empleo confirmado. Revisá la asociación.' } }, { status: 409 });
      state.documentCountry = { countryCode: body.countryCode, countrySource: 'USER_CONFIRMED', countryConfidence: 'HIGH', countrySnapshotAt: data.now };
      return ok(state.documentCountry);
    }
    if (/^\/documents\/[^/]+$/.test(path)) {
      const current = { ...data.detail, ...state.documentCountry, id: path.split('/')[2], decisionRequired: Boolean(readingPending(path.split('/')[2])) };
      return ok(state.documentIssues ? { ...current, analysis: { ...current.analysis, issues: state.documentIssues } } : current);
    }
    if (path === '/reprocessing/candidates') return ok({ items: [], total: 0, batchLimit: 100 });
    if (path === '/reprocessing-batches/latest') return ok(null);
    if (path === '/imports/active') return ok(batch && ['ACTIVE', 'PAUSED'].includes(batch.status) ? batch : null);
    if (path === '/imports' && method === 'POST') { const body = JSON.parse(init.body); batch = { id: 'synthetic-batch', status: 'ACTIVE', items: body.items.map((item, index) => ({ ...item, id: `synthetic-item-${index}`, status: 'PENDING_UPLOAD' })), progress: { total: body.items.length, resolved: 0, percentage: 0 }, totals: { PENDING_UPLOAD: body.items.length } }; return ok(batch); }
    if (path === '/upload-sessions') return ok({ id: 'synthetic-upload', url: `${location.origin}/__qa__/upload`, method: 'PUT', fields: {}, headers: {} });
    if (path === '/upload-sessions/synthetic-upload/complete') { batch.status = 'COMPLETED'; batch.items.forEach((item) => { item.status = 'COMPLETED'; }); batch.progress = { total: batch.items.length, resolved: batch.items.length, percentage: 100 }; batch.totals = { COMPLETED: batch.items.length }; return ok({}); }
    if (path.startsWith('/imports/synthetic-batch')) return ok(batch);
    if (path === '/admin/overview') return ok(data.overview);
    if (path === '/admin/users') return ok(page([data.adminUser]));
    if (/^\/admin\/users\/[^/]+$/.test(path)) return ok({ user: data.adminUser, employments: [{ ...data.employment, employerName: data.adminEmployer.name }], recentDocuments: [data.adminDocument] });
    if (path === '/admin/documents') return ok(page([data.adminDocument]));
    if (/^\/admin\/documents\/[^/]+$/.test(path)) return ok({ document: data.adminDocument, employmentId: data.employment.id, importBatchId: 'synthetic-batch', activeRunId: data.run.id, processingRuns: [data.run], issues: [], recentJobs: [data.job] });
    if (path === '/admin/employers') return ok(page([data.adminEmployer]));
    if (/^\/admin\/employers\/[^/]+$/.test(path)) return ok({ employer: data.adminEmployer, aliases: [], identifiers: [], detectionOrigins: [], possibleMatches: [] });
    if (path === '/admin/jobs') return ok(page([data.job]));
    if (path === '/admin/processing/layouts') return ok(page([{ employerId: data.adminEmployer.id, fingerprint: 'a'.repeat(64), fingerprintVersion: '1', observedRuns: 2, lastSeenAt: data.now, layoutId: null, versions: [], versionCount: 0 }]));
    if (path === '/admin/processing/layouts/approve' && method === 'POST') return ok({ id: '00000000-0000-4000-8000-000000000501', layoutId: '00000000-0000-4000-8000-000000000500', version: 1, ...JSON.parse(init.body), approvedAt: data.now });
    if (path === '/admin/processing/health') return ok({ summary: { totalDocuments: 20, completeDocuments: 19, warningDocuments: 0, failedDocuments: 1, reviewRequiredDocuments: 0, candidateDocuments: 0, processingDocuments: 0 }, currentPipeline: { fingerprint: 'synthetic-fingerprint', parserVersion: 'synthetic-v1', resultSchemaVersion: '1' }, versions: page([{ pipelineFingerprint: 'synthetic-fingerprint', parserVersion: 'synthetic-v1', status: 'COMPLETED', promotionOutcome: 'PROMOTED', documents: 20 }]), issues: page([{ code: 'SYNTHETIC_WARNING', severity: 'WARNING', documents: 1, candidates: 0 }]), checkedAt: data.now });
    if (path === '/admin/processing/ocr') return ok({ periodStart: data.now, summary: { operations: 3, calls: 2, succeeded: 1, failed: 1, blocked: 0, cacheHits: 1, timeouts: 1, retries: 1, documents: 2, reviewRequiredDocuments: 1, reportedTotalTokens: '3000', missingTokenReports: 1, estimatedCostUsd: '0.00300000', accountedCostUsd: '0.10300000', averageDurationMs: 900, processedDocuments: 20, withoutOcrDocuments: 18, zaiDocuments: 2, unknownLayoutDocuments: 1 }, providers: [{ provider: 'zai', model: 'glm-ocr', health: 'DEGRADED', lastRequestAt: data.now, lastErrorCode: 'OCR_TIMEOUT', succeeded: 1, failed: 1, blocked: 0 }], users: page([{ userId: data.adminUser.id, documents: 2, reportedTotalTokens: '3000', estimatedCostUsd: '0.00300000', accountedCostUsd: '0.10300000' }]), checkedAt: data.now });
    if (path === '/admin/storage') return ok({ ...page([{ userId: data.adminUser.id, originalBytes: 1000000, documentCount: 20, largestDocumentBytes: 50000, quotaBytes: 100000000, usagePercent: 1, anomalyFlags: [] }]), summary: { totalOriginalBytes: 1000000, documentCount: 20, usersWithOriginals: 1, pendingDeletions: 0, uncertainArtifactWrites: 0, quotaBytesPerUser: 100000000 } });
    if (path === '/admin/privacy') return ok(page([{ id: 'synthetic-operation', userId: data.adminUser.id, maskedEmail: data.adminUser.maskedEmail, operationType: 'DATA_EXPORT', status: 'PENDING', hasOutput: false, outputExpiresAt: null, errorCode: null, createdAt: data.now, updatedAt: data.now, startedAt: null, completedAt: null }]));
    if (path === '/admin/security') return ok({ activeSessions: 5, recentlyRevokedSessions: 1, adminsWithoutMfa: 0, suspendedUsers: 0, blockedUsers: 0, quarantinedDocuments: 0, securityErrors: 0, adminMutations24h: 1 });
    if (path === '/admin/audit') return ok(page([{ id: 'synthetic-event', actorUserId: data.adminUser.id, actorAdminRole: 'SUPPORT', action: 'USER_STATUS_UPDATED', resourceType: 'USER', resourceId: data.adminUser.id, result: 'SUCCESS', reasonCode: 'USER_REQUEST', reference: 'SYNTHETIC-REFERENCE-WITH-LONG-TEXT', createdAt: data.now }]));
    if (path === '/admin/roles') return ok([{ role: 'SUPER_ADMIN', permissions: data.permissions }]);
    if (path === '/admin/settings') return ok({ environment: 'synthetic-test', authentication: { provider: 'Google' }, limits: { maxFileBytes: 20000000 }, storage: { private: true }, features: { pdf: true } });
    if (path === '/admin/system/health') return ok({ overall: 'HEALTHY', components: { api: 'HEALTHY', worker: 'HEALTHY', database: 'HEALTHY' }, checkedAt: data.now });
    if (path.startsWith('/admin/legal-documents/')) return ok({ ...data.legalDocuments[0], content: 'Texto legal sintético '.repeat(100) });
    if (path.startsWith('/admin/reprocessing-batches/')) return ok(null);
    if (/^\/admin\/users\/[^/]+\/(sessions|audit)$/.test(path)) return ok(page([]));
    state.unhandled.push({ path, method });
    return Response.json({ error: { code: 'UNMOCKED_TEST_ROUTE', message: `Ruta sintética no definida: ${path}` } }, { status: 501 });
  };
  const NativeRequest = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends NativeRequest {
    open(method, url, ...rest) { this.syntheticUpload = new URL(url, location.href).pathname === '/__qa__/upload'; if (!this.syntheticUpload) super.open(method, url, ...rest); }
    send(body) { if (!this.syntheticUpload) return super.send(body); Object.defineProperty(this, 'status', { value: 200 }); const complete = () => { this.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: body.size, total: body.size })); this.dispatchEvent(new ProgressEvent('load')); }; if (state.holdUpload) state.releaseUpload = complete; else queueMicrotask(complete); }
  };
}

export const fixtureSource = (options = {}) => `(${installFixture.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(options)});`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || join(tmpdir(), 'salarivo-browser-fixture.js');
  writeFileSync(target, fixtureSource());
  process.stdout.write(`${target}\n`);
}
