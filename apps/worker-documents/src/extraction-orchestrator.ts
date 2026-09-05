import {
  attachSpatialEvidence,
  classifyPayrollText,
  extractArgentinePayroll,
  payrollExtractionNeedsReview,
  type FieldSource,
  type PayrollExtraction,
  type TextEvidencePage,
} from './engine.ts';
import { OCRProviderError, type OCRResult } from './ocr-provider.ts';
import { documentLayoutParserVersion, type ApprovedDocumentLayout } from '@salarivo/database/document-layouts';
import { fingerprintLayout, layoutFingerprintVersion } from './layout-fingerprint.ts';
import { classifyDocumentCountry, type ClassifiedDocumentCountry, type DocumentCountryContext } from './document-country.ts';

export type OCRTriggerReason = 'NO_NATIVE_TEXT' | 'UNKNOWN_EMPLOYER' | 'FIELD_RECOVERY' | 'PARSER_PARTIAL_RESULT';
export type ExtractionText = { text: string; evidence: TextEvidencePage[]; source: Exclude<FieldSource, 'RULE'> };
export type ExtractionOutcome = ExtractionText & {
  extraction: PayrollExtraction;
  issues: string[];
  ocrResult?: OCRResult;
  triggerReason: OCRTriggerReason | null;
  layout: ExtractionLayout;
  country: ClassifiedDocumentCountry;
};
export type ExtractionLayout = {
  fingerprint: string | null;
  fingerprintVersion: typeof layoutFingerprintVersion;
  profile: ApprovedDocumentLayout | null;
};
type LayoutResolver = (text: string, employerName: string, countryCode: string) => Promise<ApprovedDocumentLayout | null>;

export function ocrFallbackReason(text: string, extraction: PayrollExtraction): OCRTriggerReason | null {
  if (text.trim().length < 80) return 'NO_NATIVE_TEXT';
  if (!extraction.employerName) return 'UNKNOWN_EMPLOYER';
  const missing = !extraction.payrollPeriod || !extraction.grossAmount || !extraction.netAmount
    || !extraction.deductionsAmount || (extraction.settlementType === 'NORMAL' && !extraction.basicAmount);
  if (missing) return 'FIELD_RECOVERY';
  return payrollExtractionNeedsReview(extraction) ? 'PARSER_PARTIAL_RESULT' : null;
}

export function ocrEvidence(result: OCRResult): TextEvidencePage[] {
  return result.pages.map((page) => ({
    height: 1, left: 0, pageNumber: page.pageNumber, top: 0, width: 1,
    // Block coordinates are not word coordinates: only an exact whole-block match gets a highlight.
    words: page.blocks.flatMap((block, index) => block.content && block.sourceRegion ? [{
      height: block.sourceRegion.height, left: block.sourceRegion.x,
      lineKey: `${page.pageNumber}:${index}`, text: block.content,
      top: block.sourceRegion.y, width: block.sourceRegion.width,
    }] : []),
  }));
}

async function parse(input: ExtractionText, pageCount: number, context: DocumentCountryContext, resolveLayout?: LayoutResolver): Promise<{
  extraction: PayrollExtraction; layout: ExtractionLayout; country: ClassifiedDocumentCountry;
}> {
  const country = classifyDocumentCountry(input.text, context);
  const unsupported = (country.countryCode !== null && country.countryCode !== 'AR')
    || (country.source !== 'USER_CONFIRMED' && country.detectedCountryCode !== null && country.detectedCountryCode !== 'AR');
  // An unknown country can retain a supported salary candidate for owner review, never a jurisdiction default.
  const supportedCandidate = country.countryCode === 'AR' || classifyPayrollText(input.text).decision === 'SUPPORTED';
  const initial = extractArgentinePayroll(unsupported || !supportedCandidate ? '' : input.text, input.source);
  const fingerprint = unsupported ? null : fingerprintLayout(input.text, pageCount);
  const resolved = country.countryCode && !country.issues.length && fingerprint && initial.employerName && resolveLayout
    ? await resolveLayout(input.text, initial.employerName, country.countryCode) : null;
  const profile = resolved?.fingerprint === fingerprint && resolved.fingerprintVersion === layoutFingerprintVersion
    && resolved.countryCode === country.countryCode && resolved.documentType === 'PAYROLL'
    && resolved.parserVersion === documentLayoutParserVersion ? resolved : null;
  const extraction = profile ? extractArgentinePayroll(input.text, input.source, profile.aliases) : initial;
  return { extraction: attachSpatialEvidence(extraction, input.evidence), country,
    layout: { fingerprint, fingerprintVersion: layoutFingerprintVersion, profile } };
}

export async function orchestrateExtraction(
  input: ExtractionText,
  options: {
    cachedOcr?: OCRResult | undefined;
    requiredReason?: OCRTriggerReason | undefined;
    fallback?: ((reason: OCRTriggerReason) => Promise<OCRResult>) | undefined;
    classificationLowThreshold?: number;
    classificationHighThreshold?: number;
    pageCount?: number;
    resolveLayout?: LayoutResolver;
    countryContext?: DocumentCountryContext;
  } = {},
): Promise<ExtractionOutcome> {
  const pageCount = options.pageCount ?? Math.max(input.evidence.length, options.cachedOcr?.pages.length ?? 0, 1);
  const initialParsed = await parse(input, pageCount, options.countryContext ?? {}, options.resolveLayout);
  const initial = initialParsed.extraction;
  const reason = options.requiredReason ?? ocrFallbackReason(input.text, initial);
  const outcome: ExtractionOutcome = { ...input, extraction: initial, issues: [...initialParsed.country.issues],
    triggerReason: reason, layout: initialParsed.layout, country: initialParsed.country };
  if (outcome.country.issues.some((code) => code !== 'COUNTRY_UNCONFIRMED')) return { ...outcome, triggerReason: null };
  if (!reason && !options.cachedOcr) return outcome;
  if (!options.cachedOcr && !options.fallback) return outcome;
  let result: OCRResult;
  try {
    result = options.cachedOcr ?? await options.fallback!(reason!);
  } catch (error) {
    if (!(error instanceof OCRProviderError)) throw error;
    return { ...outcome, issues: [...outcome.issues, error.code] };
  }
  const text = result.text;
  const evidence = ocrEvidence(result);
  const candidateParsed = await parse({ text, evidence, source: 'OCR' }, pageCount, options.countryContext ?? {}, options.resolveLayout);
  const candidate = candidateParsed.extraction;
  const classification = classifyPayrollText(text,
    options.classificationLowThreshold, options.classificationHighThreshold);
  const issues: string[] = [...candidateParsed.country.issues];
  if (classification.decision !== 'SUPPORTED' || !candidate.payrollPeriod
    || (!candidate.grossAmount && !candidate.netAmount)) issues.push('UNKNOWN_LAYOUT');
  if (!options.cachedOcr) {
    const comparable = ['employerName', 'payrollPeriod', 'settlementType', 'currencyCode',
      'basicAmount', 'grossAmount', 'netAmount', 'deductionsAmount',
      'remunerativeAmount', 'nonRemunerativeAmount'] as const;
    const conceptKey = (item: PayrollExtraction['lineItems'][number]) => JSON.stringify([
      item.itemType, item.normalizedConceptCode, item.amount, item.isRecurring,
      item.normalizedConceptCode ? null : item.rawDescription,
    ]);
    const remainingConcepts = new Map<string, number>();
    for (const item of candidate.lineItems) {
      const key = conceptKey(item);
      remainingConcepts.set(key, (remainingConcepts.get(key) ?? 0) + 1);
    }
    const conceptsChanged = initial.lineItems.some((item) => {
      const key = conceptKey(item);
      const remaining = remainingConcepts.get(key) ?? 0;
      if (!remaining) return true;
      remainingConcepts.set(key, remaining - 1);
      return false;
    });
    if (conceptsChanged || comparable.some((key) => initial[key] !== null && initial[key] !== candidate[key])) {
      issues.push('OCR_RESULT_CONFLICT');
    }
  }
  return { text, evidence, source: 'OCR', extraction: candidate, issues, ocrResult: result, triggerReason: reason,
    layout: candidateParsed.layout, country: candidateParsed.country };
}
