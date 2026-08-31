export type DocumentLocation = {
  documentId: string;
  evidenceId?: string;
  page?: number;
};

export type CursorDocumentPage<T> = {
  items: T[];
  nextCursor: string | null;
  pendingReview: number;
  total: number;
};

export type NormalizedRegion = {
  height: number;
  origin: 'TOP_LEFT';
  space: 'PAGE_NORMALIZED';
  version: 1;
  width: number;
  x: number;
  y: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amountField = /^settlement\..+Amount$/;

export async function fetchDocumentPrefix<T>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<CursorDocumentPage<T>>,
  targetCount: number,
  pageSize = 100,
): Promise<CursorDocumentPage<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  let lastPage: CursorDocumentPage<T> | undefined;
  while (items.length < Math.max(1, targetCount)) {
    const page = await fetchPage(cursor, Math.min(pageSize, Math.max(1, targetCount - items.length)));
    items.push(...page.items);
    lastPage = page;
    if (!page.nextCursor || page.nextCursor === cursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  if (!lastPage) throw new Error('DOCUMENT_PAGE_MISSING');
  return { ...lastPage, items };
}

function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseNormalizedRegion(input: unknown): NormalizedRegion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || value.space !== 'PAGE_NORMALIZED' || value.origin !== 'TOP_LEFT'
    || !finiteUnit(value.x) || !finiteUnit(value.y) || !finiteUnit(value.width) || !finiteUnit(value.height)
    || value.width <= 0 || value.height <= 0 || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) {
    return null;
  }
  return {
    version: 1,
    space: 'PAGE_NORMALIZED',
    origin: 'TOP_LEFT',
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

export function rotateNormalizedRegion(region: NormalizedRegion, rotation: 0 | 90 | 180 | 270): NormalizedRegion {
  if (rotation === 90) return { ...region, x: 1 - region.y - region.height, y: region.x, width: region.height, height: region.width };
  if (rotation === 180) return { ...region, x: 1 - region.x - region.width, y: 1 - region.y - region.height };
  if (rotation === 270) return { ...region, x: region.y, y: 1 - region.x - region.width, width: region.height, height: region.width };
  return region;
}

export function regionPixels(
  region: NormalizedRegion,
  viewportWidth: number,
  viewportHeight: number,
  rotation: 0 | 90 | 180 | 270 = 0,
) {
  const rotated = rotateNormalizedRegion(region, rotation);
  return {
    height: rotated.height * viewportHeight,
    left: rotated.x * viewportWidth,
    top: rotated.y * viewportHeight,
    width: rotated.width * viewportWidth,
  };
}

export function safeCanvasScale(
  baseWidth: number,
  baseHeight: number,
  desiredScale: number,
  pixelRatio: number,
  maxDimension = 8192,
  maxPixels = 16_777_216,
): number | null {
  if (![baseWidth, baseHeight, desiredScale, pixelRatio].every((value) => Number.isFinite(value) && value > 0)) return null;
  const dimensionScale = Math.min(maxDimension / (baseWidth * pixelRatio), maxDimension / (baseHeight * pixelRatio));
  const areaScale = Math.sqrt(maxPixels / (baseWidth * baseHeight * pixelRatio * pixelRatio));
  const scale = Math.min(desiredScale, dimensionScale, areaScale);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

export function evidenceIdForPage(
  evidenceId: string | undefined,
  page: number,
  fields: Array<{ id: string | null; pageNumber: number | null }>,
): string | undefined {
  return fields.some((field) => field.id === evidenceId && field.pageNumber === page) ? evidenceId : undefined;
}

export function extractionRunChanged(editingRunId: string | null, currentRunId: string | null): boolean {
  return editingRunId !== currentRunId;
}

export function readDocumentLocation(search: string): DocumentLocation | null {
  const params = new URLSearchParams(search);
  const documentId = params.get('document');
  if (!documentId || !uuid.test(documentId)) return null;
  const rawPage = params.get('page');
  const parsedPage = rawPage === null ? undefined : Number(rawPage);
  const evidenceId = params.get('evidence');
  return {
    documentId,
    ...(Number.isInteger(parsedPage) && parsedPage! >= 1 && parsedPage! <= 500 ? { page: parsedPage } : {}),
    ...(evidenceId && uuid.test(evidenceId) ? { evidenceId } : {}),
  };
}

export function writeDocumentLocation(_search: string, location: DocumentLocation | null): string {
  const params = new URLSearchParams();
  if (location && uuid.test(location.documentId)) {
    params.set('document', location.documentId);
    if (Number.isInteger(location.page) && location.page! > 1 && location.page! <= 500) params.set('page', String(location.page));
    if (location.evidenceId && uuid.test(location.evidenceId)) params.set('evidence', location.evidenceId);
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

export function normalizeReviewValue(fieldPath: string, input: string): string {
  const value = input.trim();
  if (amountField.test(fieldPath)) {
    let compact = value.replace(/[$\s\u00a0]/g, '');
    compact = compact.includes(',')
      ? compact.replaceAll('.', '').replace(',', '.')
      : /^-?\d{1,3}(?:\.\d{3})+$/.test(compact)
        ? compact.replaceAll('.', '')
        : compact;
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(compact);
    if (!match?.[2]) return value;
    return `${match[1]}${match[2].replace(/^0+(?=\d)/, '')}.${(match[3] ?? '').padEnd(2, '0') || '00'}`;
  }
  if (fieldPath === 'settlement.type') return value.toUpperCase();
  if (fieldPath === 'settlement.payrollPeriod') return value.slice(0, 7);
  return value.replace(/\s+/g, ' ');
}

export function reviewValueChanged(fieldPath: string, draft: string, saved: string): boolean {
  return normalizeReviewValue(fieldPath, draft) !== normalizeReviewValue(fieldPath, saved);
}
