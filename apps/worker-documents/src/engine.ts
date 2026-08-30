export type FieldSource = 'PDF_TEXT' | 'OCR' | 'RULE';

export type MissingFieldReason = 'VALUE_NOT_INTERPRETABLE' | 'LABEL_OR_LAYOUT_NOT_RECOGNIZED';

export type Classification = {
  confidence: number;
  decision: 'SUPPORTED' | 'NEEDS_CONFIRMATION' | 'UNSUPPORTED';
  documentType: 'PAYROLL' | 'UNKNOWN';
  signals: string[];
};

export type ExtractedField = {
  confidence: number;
  fieldPath: string;
  interpretedValue: unknown;
  rawValue: string;
  signals?: { missingReason: MissingFieldReason };
  source: FieldSource;
};

export type PayrollLineItem = {
  amount: string;
  confidence: number;
  isRecurring: boolean | null;
  itemType: 'EARNING' | 'DEDUCTION';
  normalizedConceptCode: string | null;
  rawDescription: string;
};

export type PayrollExtraction = {
  basicAmount: string | null;
  currencyCode: 'ARS';
  deductionsAmount: string | null;
  employerName: string | null;
  fields: ExtractedField[];
  grossAmount: string | null;
  lineItems: PayrollLineItem[];
  needsReview: boolean;
  netAmount: string | null;
  payrollPeriod: string | null;
  settlementType:
    | 'NORMAL'
    | 'SAC'
    | 'VACACIONES'
    | 'BONO'
    | 'RETROACTIVO'
    | 'COMISION'
    | 'HORAS_EXTRA'
    | 'LIQUIDACION_FINAL'
    | 'INDEMNIZACION'
    | 'AJUSTE';
};

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-AR');

const numericAmountPattern = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const amountPattern = String.raw`(?:(?:\(?-?\$\s*|\(?-?)${numericAmountPattern}\)?-?)`;
const amountAtEnd = new RegExp(String.raw`(?<![\p{L}\p{N}.,/(\-])${amountPattern}\s*$`, 'u');
const amountToken = new RegExp(String.raw`(?<![\p{L}\p{N}.,/(\-])${amountPattern}(?![\p{L}\p{N}.,/\-])`, 'gu');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Amount = {
  confidence?: number;
  raw: string;
  source?: FieldSource;
  value: string;
};

type PositionedAmount = Amount & { index: number };

type PayrollTable = {
  columns: number[];
  descriptionEnd: number;
  headerIndex: number;
  totalIndex: number;
  totals: PositionedAmount[];
};

type EmployerCandidate = {
  confidence: number;
  raw: string;
  value: string;
};

export function hasPdfMagic(header: Uint8Array): boolean {
  return Buffer.from(header).subarray(0, 1024).indexOf('%PDF-') >= 0;
}

export function parseJobMessage(message: string): string | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    return entries.length === 1 && entries[0]?.[0] === 'jobId' && typeof entries[0][1] === 'string' && uuid.test(entries[0][1])
      ? entries[0][1]
      : null;
  } catch {
    return null;
  }
}

export function selectDispatchCandidates(
  candidates: ReadonlyArray<{ id: string; userId: string }>,
  activeJobsByUser: ReadonlyMap<string, number>,
  globalConcurrency: number,
  concurrencyPerUser: number,
): string[] {
  const scheduledByUser = new Map(activeJobsByUser);
  let remaining = globalConcurrency;
  for (const active of activeJobsByUser.values()) remaining -= active;
  if (remaining <= 0) return [];

  const selected: string[] = [];
  for (const candidate of candidates) {
    const userJobs = scheduledByUser.get(candidate.userId) ?? 0;
    if (userJobs >= concurrencyPerUser) continue;
    selected.push(candidate.id);
    scheduledByUser.set(candidate.userId, userJobs + 1);
    if (selected.length === remaining) break;
  }
  return selected;
}

export function uploadCleanupStatus(
  expiresAtMs: number,
  nowMs: number,
  graceMs: number,
  markerProtected = false,
): 'EXPIRED' | 'CANCELLED' {
  return markerProtected || nowMs >= expiresAtMs + graceMs ? 'CANCELLED' : 'EXPIRED';
}

export function pendingUploadCutoff(nowMs: number, uploadTtlMs: number, graceMs: number): Date {
  return new Date(nowMs - uploadTtlMs - graceMs);
}

export function validatePdfInfo(
  output: string,
  maxPages: number,
): { errorCode?: 'DOCUMENT_CORRUPTED' | 'DOCUMENT_ENCRYPTED' | 'DOCUMENT_TOO_MANY_PAGES'; pages?: number } {
  const pageMatch = /^Pages:\s+(\d+)\s*$/im.exec(output);
  const encryptedMatch = /^Encrypted:\s+(yes|no)\s*$/im.exec(output);
  if (!pageMatch?.[1] || !encryptedMatch?.[1]) return { errorCode: 'DOCUMENT_CORRUPTED' };
  if (encryptedMatch[1].toLowerCase() === 'yes') return { errorCode: 'DOCUMENT_ENCRYPTED' };
  const pages = Number.parseInt(pageMatch[1], 10);
  if (!Number.isSafeInteger(pages) || pages < 1) return { errorCode: 'DOCUMENT_CORRUPTED' };
  if (pages > maxPages) return { errorCode: 'DOCUMENT_TOO_MANY_PAGES' };
  return { pages };
}

export function validateRenderPixels(output: string, dpi: number, maxPixels: number): boolean {
  const dimensions = [...output.matchAll(/^Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/imsg)];
  if (!dimensions.length) return false;
  return dimensions.every((match) => {
    const width = Number(match[1]);
    const height = Number(match[2]);
    const pixels = (width / 72) * dpi * (height / 72) * dpi;
    return Number.isFinite(pixels) && width > 0 && height > 0 && pixels <= maxPixels;
  });
}

export function parseArgentineAmount(raw: string): string | null {
  const compact = raw.replace(/[\s\u00a0]/g, '');
  if (!/^\(?-?\$?\d[\d.,]*\)?-?$/.test(compact)) return null;
  const currencyless = compact.replace('$', '');
  const parenthesized = currencyless.startsWith('(') || currencyless.endsWith(')');
  if (parenthesized && !(currencyless.startsWith('(') && currencyless.endsWith(')'))) return null;
  let unsigned = parenthesized ? currencyless.slice(1, -1) : currencyless;
  const leadingNegative = unsigned.startsWith('-');
  const trailingNegative = unsigned.endsWith('-');
  if (Number(parenthesized) + Number(leadingNegative) + Number(trailingNegative) > 1) return null;
  if (leadingNegative) unsigned = unsigned.slice(1);
  if (trailingNegative) unsigned = unsigned.slice(0, -1);

  let integer: string;
  let fraction = '00';
  let match: RegExpExecArray | null;
  if (/^\d+$/.test(unsigned)) {
    integer = unsigned;
  } else if ((match = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(unsigned))) {
    integer = match[1]!.replaceAll('.', '');
    fraction = (match[2] ?? '').padEnd(2, '0') || '00';
  } else if ((match = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(unsigned))) {
    integer = match[1]!.replaceAll(',', '');
    fraction = (match[2] ?? '').padEnd(2, '0') || '00';
  } else if ((match = /^(\d+)[.,](\d{1,2})$/.exec(unsigned))) {
    integer = match[1]!;
    fraction = match[2]!.padEnd(2, '0');
  } else {
    return null;
  }
  integer = integer.replace(/^0+(?=\d)/, '');
  if (!integer || integer.length > 18 || !/^\d+$/.test(integer) || !/^\d{2}$/.test(fraction)) return null;
  const negative = parenthesized || leadingNegative || trailingNegative;
  return `${negative && (integer !== '0' || fraction !== '00') ? '-' : ''}${integer}.${fraction}`;
}

export function classifyPayrollText(text: string, lowThreshold = 0.2, highThreshold = 0.55): Classification {
  const normalized = fold(text);
  const rules: Array<[string, RegExp, number]> = [
    ['recibo_sueldo', /recibo\s+(?:de\s+)?(?:sueldo|haberes)/, 0.4],
    ['liquidacion_haberes', /liquidacion\s+(?:de\s+)?(?:haberes|sueldos?)/, 0.4],
    ['sueldo_basico', /\b(?:sueldo|salario|haber|remuneracion)\s+basic[oa]\b/, 0.2],
    ['haberes', /\bhaberes\b/, 0.1],
    ['remunerativo', /\bremunerativ[oa]s?\b/, 0.12],
    ['descuentos', /\bdescuentos?\b/, 0.08],
    ['neto', /\b(?:neto|liquido)\b/, 0.08],
    ['empleador', /\bempleador\b/, 0.05],
    ['identificador_laboral', /\b(?:cuil|cuit)\b/, 0.05],
  ];
  const signals: string[] = [];
  let confidence = 0;
  for (const [name, pattern, weight] of rules) {
    if (pattern.test(normalized)) {
      signals.push(name);
      confidence += weight;
    }
  }
  if (/\b(?:factura|comprobante\s+de\s+compra|iva\s+responsable)\b/.test(normalized)) {
    signals.push('documento_comercial');
    confidence -= 0.45;
  }
  const hasPayrollTitle = signals.includes('recibo_sueldo') || signals.includes('liquidacion_haberes');
  if (!hasPayrollTitle && /\bliquidacion\s+de\s+(?:impuesto\s+a\s+las\s+)?ganancias\b/.test(normalized)) {
    signals.push('documento_fiscal');
    confidence -= 0.45;
  }
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
  const decision = confidence >= highThreshold
    ? 'SUPPORTED'
    : confidence <= lowThreshold
      ? 'UNSUPPORTED'
      : 'NEEDS_CONFIRMATION';
  return { confidence, decision, documentType: decision === 'SUPPORTED' ? 'PAYROLL' : 'UNKNOWN', signals };
}

function extractPeriod(text: string): { raw: string; value: string } | null {
  const normalized = fold(text);
  const numeric = /(?:periodo(?:\s+de\s+liquidacion)?|liquidacion|mes)\s*[:\-]?\s*(0?[1-9]|1[0-2])[\/-](20\d{2})/.exec(normalized);
  if (numeric?.[1] && numeric[2]) {
    return { raw: numeric[0], value: `${numeric[2]}-${numeric[1].padStart(2, '0')}` };
  }
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const named = new RegExp(`(?:periodo(?:\\s+de\\s+liquidacion)?|liquidacion|mes)?\\s*[:\\-]?\\s*(${months.join('|')})\\s+(20\\d{2})`).exec(normalized);
  if (!named?.[1] || !named[2]) return null;
  return { raw: named[0].trim(), value: `${named[2]}-${String(months.indexOf(named[1]) + 1).padStart(2, '0')}` };
}

function amountsInLine(line: string): PositionedAmount[] {
  return [...line.matchAll(amountToken)].flatMap((match) => {
    const raw = match[0].trim();
    const value = parseArgentineAmount(raw);
    return value && match.index !== undefined ? [{ index: match.index, raw, value }] : [];
  });
}

function cleanEmployerCandidate(raw: string): string | null {
  const value = raw
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+(?:c\.?u\.?i\.?t\.?)\s*[:\-]?.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return value.length >= 2 && /\p{L}/u.test(value) ? value : null;
}

function extractEmployer(lines: string[]): EmployerCandidate | null {
  for (const line of lines.slice(0, 16)) {
    const match = /^\s*(?:empleador|raz[oó]n\s+social|empresa)\s*[:\-]\s*(.+)$/i.exec(line);
    const raw = match?.[1]?.split(/\s{2,}/, 1)[0]?.trim();
    const value = raw ? cleanEmployerCandidate(raw) : null;
    if (raw && value) return { confidence: 0.82, raw: raw.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160), value };
  }

  const cuitIndex = lines.slice(0, 16).findIndex((line) => /\bcuit\b/.test(fold(line)));
  if (cuitIndex < 1) return null;
  const legalSuffix = /\b(?:s\.?\s*a\.?|s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?\s*s\.?|sociedad\s+anonima|sociedad\s+de\s+responsabilidad\s+limitada)(?:\s|$)/;
  for (let index = cuitIndex - 1; index >= Math.max(0, cuitIndex - 5); index -= 1) {
    const segment = (lines[index] ?? '').trim().split(/\s{2,}/).find((part) => legalSuffix.test(fold(part)));
    const value = segment ? cleanEmployerCandidate(segment) : null;
    if (segment && value) return { confidence: 0.74, raw: segment.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160), value };
  }
  return null;
}

const basicAmountLabels = [/\b(?:sueldo|salario|haber|remuneracion)\s+basic[oa]\b/, /^\s*basico\b/];
const grossAmountLabels = [/\b(?:total\s+(?:de\s+)?(?:haberes|remuneraciones)|haberes\s+totales|total\s+bruto|sueldo\s+bruto|remuneracion\s+bruta|importe\s+bruto)\b/];
const netAmountLabels = [/\b(?:neto|liquido)\s+(?:a\s+)?(?:cobrar|pagar|percibir)\b/, /\b(?:total|importe|haber)\s+neto\b/, /\b(?:neto|liquido)\s+a\s*$/, /^\s*(?:neto|liquido)\s*$/];
const deductionAmountLabels = [/\b(?:total\s+(?:de\s+)?(?:descuentos|deducciones|retenciones)|(?:descuentos|deducciones|retenciones)\s+totales)\b/];
const settlementAmountLabels = [...basicAmountLabels, ...grossAmountLabels, ...netAmountLabels, ...deductionAmountLabels];

function extractAmount(lines: string[], labels: RegExp[]): Amount | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const normalized = fold(line);
    for (const label of labels) {
      const match = label.exec(normalized);
      if (!match) continue;
      const inlineNumber = /\d/.test(line.slice(match.index + match[0].length));
      for (const [offset, candidate] of [line, lines[index + 1] ?? '', lines[index + 2] ?? ''].entries()) {
        if (offset && (inlineNumber || settlementAmountLabels.some((candidateLabel) => candidateLabel.test(fold(candidate))))) break;
        const formattedAmounts = amountsInLine(candidate).filter(({ raw }) =>
          raw.includes('$') || /[.,]/.test(raw) || /\d[ \u00a0]\d{3}/.test(raw));
        if (formattedAmounts.length > 1) break;
        const raw = amountAtEnd.exec(candidate)?.[0]?.trim();
        const value = raw ? parseArgentineAmount(raw) : null;
        const formatted = raw && (raw.includes('$') || /[.,]/.test(raw) || /\d[ \u00a0]\d{3}/.test(raw));
        if (raw && value && formatted) return offset ? { confidence: 0.82, raw, value } : { raw, value };
      }
    }
  }
  return null;
}

function addAmounts(left: string, right: string): string | null {
  const cents = BigInt(left.replace('.', '')) + BigInt(right.replace('.', ''));
  const absolute = cents < 0n ? -cents : cents;
  const integer = String(absolute / 100n);
  return integer.length <= 18
    ? `${cents < 0n ? '-' : ''}${integer}.${String(absolute % 100n).padStart(2, '0')}`
    : null;
}

function subtractAmounts(left: string, right: string): string | null {
  return addAmounts(left, right.startsWith('-') ? right.slice(1) : `-${right}`);
}

function headerColumn(lines: string[], patterns: RegExp[]): number | null {
  for (const line of lines) {
    const normalized = fold(line);
    for (const pattern of patterns) {
      const match = pattern.exec(normalized);
      if (match) return match.index;
    }
  }
  return null;
}

function mapAmountsToColumns(amounts: PositionedAmount[], columns: number[]): Array<PositionedAmount | null> {
  const mapped: Array<PositionedAmount | null> = columns.map(() => null);
  for (const amount of amounts) {
    const amountEnd = amount.index + amount.raw.length;
    let nearest = 0;
    for (let position = 1; position < columns.length; position += 1) {
      if (Math.abs(amountEnd - columns[position]!) < Math.abs(amountEnd - columns[nearest]!)) nearest = position;
    }
    if (Math.abs(amountEnd - columns[nearest]!) > 32) continue;
    const current = mapped[nearest];
    if (!current || Math.abs(amountEnd - columns[nearest]!) < Math.abs(current.index + current.raw.length - columns[nearest]!)) {
      mapped[nearest] = amount;
    }
  }
  return mapped;
}

function findPayrollTable(lines: string[]): PayrollTable | null {
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLines = lines.slice(index, index + 3);
    const requiredColumns = [
      headerColumn(headerLines, [/\bhaberes?\s+con\b/, /(?<!no )\bremunerativ[oa]s?\b/]),
      headerColumn(headerLines, [/\bhaberes?\s+sin\b/, /\bno\s+remunerativ[oa]s?\b/]),
      headerColumn(headerLines, [/\b(?:descuentos?|deducciones?|retenciones?)\b/]),
    ];
    if (requiredColumns.some((column) => column === null) || requiredColumns.some((column, position) => position > 0 && column! <= requiredColumns[position - 1]!)) continue;
    const optionalColumn = headerColumn(headerLines, [/\b(?:contrib(?:uciones?)?|otros?)\b/]);
    if (optionalColumn !== null && optionalColumn <= requiredColumns[2]!) continue;
    const columns = optionalColumn === null ? requiredColumns as number[] : [...requiredColumns, optionalColumn] as number[];

    for (let row = index + 1; row < Math.min(lines.length, index + 64); row += 1) {
      if (!/\btotal(?:es)?\b/.test(fold(lines[row] ?? ''))) continue;
      const amounts = amountsInLine(lines[row] ?? '');
      if (amounts.length !== columns.length) continue;
      if (amounts.some((amount, position) => Math.abs(amount.index - columns[position]!) > (position ? 32 : 64))) continue;
      return {
        columns: amounts.map((amount) => amount.index + amount.raw.length),
        descriptionEnd: requiredColumns[0]!,
        headerIndex: index,
        totalIndex: row,
        totals: amounts,
      };
    }
  }
  return null;
}

function extractTotalsTable(table: PayrollTable | null): { deductions: Amount; gross: Amount } | null {
  if (!table) return null;
  const [remunerative, nonRemunerative, deductions] = table.totals;
  if (!remunerative || !nonRemunerative || !deductions) return null;
  const gross = addAmounts(remunerative.value, nonRemunerative.value);
  if (!gross || gross.startsWith('-')) return null;
  return {
    deductions: { ...deductions, confidence: 0.84 },
    gross: {
      confidence: 0.8,
      raw: `${remunerative.raw} + ${nonRemunerative.raw}`,
      source: 'RULE',
      value: gross,
    },
  };
}

function settlementType(text: string): PayrollExtraction['settlementType'] {
  const descriptors = text.split(/\r?\n/)
    .map((line) => fold(line).trim())
    .filter((line) => /^(?:tipo\s+(?:de\s+)?liquidacion|liquidacion|recibo\s+de)\b/.test(line)
      || /^(?:sac|aguinaldo|vacaciones|bono|retroactiv[oa]|comision(?:es)?|horas?\s+extra|indemnizacion|ajuste)$/.test(line))
    .join('\n');
  if (/\bliquidacion\s+final\b/.test(descriptors)) return 'LIQUIDACION_FINAL';
  if (/\bindemnizacion\b/.test(descriptors)) return 'INDEMNIZACION';
  if (/\b(?:sac|aguinaldo)\b/.test(descriptors)) return 'SAC';
  if (/\bvacaciones\b/.test(descriptors)) return 'VACACIONES';
  if (/\bbono\b/.test(descriptors)) return 'BONO';
  if (/\bretroactiv[oa]\b/.test(descriptors)) return 'RETROACTIVO';
  if (/\bcomision(?:es)?\b/.test(descriptors)) return 'COMISION';
  if (/\bhoras?\s+extra\b/.test(descriptors)) return 'HORAS_EXTRA';
  if (/\bajuste\b/.test(descriptors)) return 'AJUSTE';
  return 'NORMAL';
}

const concepts: Array<{
  code: string;
  pattern: RegExp;
  recurring: boolean;
  type: PayrollLineItem['itemType'];
}> = [
  { code: 'BASIC_SALARY', pattern: /sueldo\s+basico/, recurring: true, type: 'EARNING' },
  { code: 'SENIORITY', pattern: /antiguedad/, recurring: true, type: 'EARNING' },
  { code: 'ATTENDANCE', pattern: /presentismo/, recurring: true, type: 'EARNING' },
  { code: 'OVERTIME', pattern: /horas?\s+extra/, recurring: false, type: 'EARNING' },
  { code: 'BONUS', pattern: /\bbono\b/, recurring: false, type: 'EARNING' },
  { code: 'RETIREMENT', pattern: /jubilacion/, recurring: true, type: 'DEDUCTION' },
  { code: 'HEALTH_INSURANCE', pattern: /obra\s+social/, recurring: true, type: 'DEDUCTION' },
  { code: 'PAMI', pattern: /(?:ley\s*19\.?032|pami)/, recurring: true, type: 'DEDUCTION' },
  { code: 'INCOME_TAX', pattern: /(?:ganancias|impuesto\s+a\s+las\s+ganancias|(?:imp\.?|impuesto)\s+a\s+los\s+ingresos\s+personales)/, recurring: true, type: 'DEDUCTION' },
  { code: 'UNION_DUES', pattern: /(?:sindicato|cuota\s+sindical)/, recurring: true, type: 'DEDUCTION' },
];

function lineDescription(line: string, end: number): string | null {
  const description = line.slice(0, Math.max(1, end)).trim().slice(0, 240);
  return /\p{L}/u.test(description) ? description : null;
}

function extractLineItems(lines: string[], table: PayrollTable | null): PayrollLineItem[] {
  if (table) {
    const items: PayrollLineItem[] = [];
    for (let index = table.headerIndex; index < table.totalIndex; index += 1) {
      const line = lines[index] ?? '';
      const normalized = fold(line);
      const amounts = amountsInLine(line);
      const mapped = mapAmountsToColumns(amounts, table.columns);
      const rawDescription = lineDescription(line, table.descriptionEnd);
      if (!rawDescription) continue;
      const concept = concepts.find(({ pattern }) => pattern.test(normalized));
      const deduction = mapped[2];
      if (deduction) {
        items.push({
          amount: deduction.value,
          confidence: 0.86,
          isRecurring: null,
          itemType: 'DEDUCTION',
          normalizedConceptCode: null,
          rawDescription: 'Deducción',
        });
        continue;
      }
      if (concept?.type !== 'EARNING') continue;
      const earning = mapped[0] ?? mapped[1];
      if (!earning || earning.value.startsWith('-')) continue;
      items.push({
        amount: earning.value,
        confidence: 0.86,
        isRecurring: concept.recurring,
        itemType: 'EARNING',
        normalizedConceptCode: concept.code,
        rawDescription,
      });
    }
    return items;
  }

  const items: PayrollLineItem[] = [];
  for (const line of lines) {
    const normalized = fold(line);
    if (/^\s*contrib/.test(normalized)) continue;
    const concept = concepts.find(({ pattern }) => pattern.test(normalized));
    const rawAmount = concept ? amountAtEnd.exec(line)?.[0]?.trim() : undefined;
    const amount = rawAmount ? parseArgentineAmount(rawAmount) : null;
    if (!concept || !amount) continue;
    items.push({
      amount: amount.startsWith('-') ? amount.slice(1) : amount,
      confidence: 0.84,
      isRecurring: concept.type === 'DEDUCTION' ? null : concept.recurring,
      itemType: concept.type,
      normalizedConceptCode: concept.type === 'DEDUCTION' ? null : concept.code,
      rawDescription: concept.type === 'DEDUCTION'
        ? 'Deducción'
        : line.slice(0, Math.max(1, line.length - (rawAmount?.length ?? 0))).trim().slice(0, 240),
    });
  }
  return items;
}

function deductionsMatchTotal(lineItems: PayrollLineItem[], deductions: Amount | null): boolean {
  const items = lineItems.filter(({ itemType }) => itemType === 'DEDUCTION');
  if (!deductions) return items.length === 0;
  let total = '0.00';
  for (const item of items) {
    const next = addAmounts(total, item.amount);
    if (!next) return false;
    total = next;
  }
  return total === deductions.value;
}

function totalsBalance(gross: Amount | null, deductions: Amount | null, net: Amount | null): boolean {
  return Boolean(gross && deductions && net && subtractAmounts(gross.value, deductions.value) === net.value);
}

function hasAmountLabel(lines: string[], labels: RegExp[]): boolean {
  return lines.some((line) => labels.some((label) => label.test(fold(line))));
}

function missingField(fieldPath: string, fieldRecognized: boolean): ExtractedField {
  return {
    confidence: 0,
    fieldPath,
    interpretedValue: null,
    rawValue: '',
    signals: { missingReason: fieldRecognized ? 'VALUE_NOT_INTERPRETABLE' : 'LABEL_OR_LAYOUT_NOT_RECOGNIZED' },
    source: 'RULE',
  };
}

export function extractArgentinePayroll(text: string, source: Exclude<FieldSource, 'RULE'>): PayrollExtraction {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const period = extractPeriod(text);
  const payrollTable = findPayrollTable(lines);
  const table = extractTotalsTable(payrollTable);
  const basic = extractAmount(lines, basicAmountLabels);
  const gross = table?.gross ?? extractAmount(lines, grossAmountLabels) ?? null;
  const deductions = table?.deductions ?? extractAmount(lines, deductionAmountLabels) ?? null;
  const netLabelFound = hasAmountLabel(lines, netAmountLabels);
  const derivedNet = table && netLabelFound ? subtractAmounts(table.gross.value, table.deductions.value) : null;
  const net = extractAmount(lines, netAmountLabels) ?? (derivedNet ? {
    confidence: 0.8,
    raw: `${table!.gross.raw} - ${table!.deductions.raw}`,
    source: 'RULE' as const,
    value: derivedNet,
  } : null);
  const employer = extractEmployer(lines);
  const employerName = employer?.value ?? null;
  const type = settlementType(text);
  const fields: ExtractedField[] = [{
    confidence: 0.8,
    fieldPath: 'settlement.type',
    interpretedValue: type,
    rawValue: type,
    source: 'RULE',
  }];

  if (period) fields.push({ confidence: 0.92, fieldPath: 'settlement.payrollPeriod', interpretedValue: period.value, rawValue: period.raw, source });
  else fields.push(missingField('settlement.payrollPeriod', /\b(?:periodo(?:\s+de\s+liquidacion)?|mes)\b/.test(fold(text))));
  if (employer) fields.push({ confidence: employer.confidence, fieldPath: 'employer.name', interpretedValue: employer.value, rawValue: employer.raw, source });
  else fields.push(missingField('employer.name', lines.some((line) => /^\s*(?:empleador|razon\s+social|empresa)\s*[:\-]/.test(fold(line)))));
  for (const [fieldPath, amount, labelFound] of [
    ['settlement.basicAmount', basic, hasAmountLabel(lines, basicAmountLabels)],
    ['settlement.grossAmount', gross, Boolean(payrollTable) || hasAmountLabel(lines, grossAmountLabels)],
    ['settlement.netAmount', net, netLabelFound],
    ['settlement.deductionsAmount', deductions, Boolean(payrollTable) || hasAmountLabel(lines, deductionAmountLabels)],
  ] as const) {
    if (amount) {
      fields.push({
        confidence: amount.confidence ?? 0.88,
        fieldPath,
        interpretedValue: { amount: amount.value, currencyCode: 'ARS' },
        rawValue: amount.raw,
        source: amount.source ?? source,
      });
    } else {
      fields.push(missingField(fieldPath, labelFound));
    }
  }

  const lineItems = extractLineItems(lines, payrollTable);

  return {
    basicAmount: basic?.value ?? null,
    currencyCode: 'ARS',
    deductionsAmount: deductions?.value ?? null,
    employerName,
    fields,
    grossAmount: gross?.value ?? null,
    lineItems,
    needsReview: !period || !gross || !net || !deductions || !totalsBalance(gross, deductions, net)
      || !deductionsMatchTotal(lineItems, deductions),
    netAmount: net?.value ?? null,
    payrollPeriod: period?.value ?? null,
    settlementType: type,
  };
}
