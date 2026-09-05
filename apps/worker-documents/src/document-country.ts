import { getCountry } from '@salarivo/jurisdictions';

export type DocumentCountry = {
  countryCode: string | null;
  source: 'DOCUMENT_DETECTION' | 'EMPLOYMENT_CONFIRMED' | 'USER_CONFIRMED' | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
};

export type DocumentCountryContext = {
  confirmedEmploymentCountryCode?: string | null;
  snapshot?: DocumentCountry | null;
};

export type ClassifiedDocumentCountry = DocumentCountry & {
  detectedCountryCode: string | null;
  issues: string[];
};

// Closed signals only: identifiers and OCR text never leave the document pipeline.
export function detectDocumentCountry(text: string): DocumentCountry {
  const normalized = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const payroll = /\b(?:recibo\s+(?:de\s+)?(?:sueldo|haberes)|liquidacion\s+(?:de\s+)?(?:haberes|sueldos?)|payslip|pay\s+statement|nomina|holerite)\b/.test(normalized);
  const labeledCode = /^\s*(?:pais|country)(?:\s+(?:de\s+)?(?:empleo|laboral))?\s*:\s*([a-z]{2})\s*$/m.exec(normalized)?.[1]?.toUpperCase();
  if (payroll && labeledCode && getCountry(labeledCode)) {
    return { countryCode: labeledCode, source: 'DOCUMENT_DETECTION', confidence: 'MEDIUM' };
  }
  const fiscalIdentifier = /\bcu(?:it|il)\s*[:.-]?\s*\d{2}[-\s]?\d{8}[-\s]?\d\b/.test(normalized);
  const explicitCountry = /\b(?:argentina|ars|pesos argentinos)\b/.test(normalized);
  if (payroll && (fiscalIdentifier || explicitCountry)) {
    return { countryCode: 'AR', source: 'DOCUMENT_DETECTION', confidence: fiscalIdentifier ? 'HIGH' : 'MEDIUM' };
  }
  return { countryCode: null, source: null, confidence: null };
}

export function classifyDocumentCountry(text: string, context: DocumentCountryContext = {}): ClassifiedDocumentCountry {
  return resolveDocumentCountry(detectDocumentCountry(text), context);
}

export function resolveDocumentCountry(detected: DocumentCountry, context: DocumentCountryContext = {}): ClassifiedDocumentCountry {
  const confirmed = context.confirmedEmploymentCountryCode;
  const snapshot = context.snapshot;
  const humanCountry = snapshot?.source === 'USER_CONFIRMED' ? snapshot.countryCode : null;
  const selected: DocumentCountry = humanCountry && (!confirmed || confirmed === humanCountry)
    ? snapshot!
    : confirmed
    ? { countryCode: confirmed, source: 'EMPLOYMENT_CONFIRMED', confidence: 'HIGH' }
    : detected.countryCode ? detected : snapshot?.countryCode ? snapshot : detected;
  const issues: string[] = [];
  if (confirmed && ((humanCountry && confirmed !== humanCountry)
    || (!humanCountry && detected.countryCode && confirmed !== detected.countryCode))) issues.push('COUNTRY_EMPLOYMENT_CONFLICT');
  if (snapshot?.countryCode && ((selected.countryCode && selected.countryCode !== snapshot.countryCode)
    || (!humanCountry && detected.countryCode && detected.countryCode !== snapshot.countryCode))) issues.push('COUNTRY_SNAPSHOT_CONFLICT');
  if (!selected.countryCode) issues.push('COUNTRY_UNCONFIRMED');
  else if (selected.countryCode !== 'AR') issues.push('COUNTRY_NOT_SUPPORTED');
  return { ...selected, detectedCountryCode: detected.countryCode, issues };
}
