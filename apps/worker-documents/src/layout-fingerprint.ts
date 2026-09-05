import { createHash } from 'node:crypto';

export const layoutFingerprintVersion = '1' as const;

// The serialized input contains only closed structural labels, never source values or identities.
const anchors = [
  ['title', /\brecibo\s+(?:de\s+)?(?:sueldo|haberes)\b/g],
  ['employer', /^(?:empleador|empresa|razon social)\b/g],
  ['employee', /^(?:empleado|trabajador|apellido y nombre)\b/g],
  ['period', /^(?:periodo|mes)\b/g],
  ['basic', /^(?:sueldo basico|basico)\b/g],
  ['gross', /^(?:total bruto|bruto|total haberes)\b/g],
  ['net', /^(?:neto|total neto|liquido a cobrar)\b/g],
  ['deductions', /^(?:total descuentos|descuentos|deducciones)\b/g],
  ['nonremunerative', /^(?:total no remunerativo|no remunerativo)\b/g],
  ['remunerative', /^(?:total remunerativo|remunerativo)\b/g],
  ['code-column', /\b(?:codigo|cod\.)\b/g],
  ['concept-column', /\b(?:concepto|descripcion)\b/g],
  ['units-column', /\b(?:unidades|cantidad)\b/g],
  ['earnings-column', /\bhaberes\b/g],
  ['deductions-column', /\b(?:retenciones|descuentos)\b/g],
] as const;

export function fingerprintLayout(text: string, pageCount: number): string | null {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100 || text.length > 2_000_000) return null;
  const structure: string[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const normalized = rawLine.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
    // Identity headers contribute only their closed label, regardless of the name that follows.
    const identity = /^(empleador|empresa|razon social|empleado|trabajador|apellido y nombre)\b/.exec(normalized);
    const line = identity ? identity[0] : normalized.split(':', 1)[0]!;
    const labels = anchors.flatMap(([id, pattern]) => [...line.matchAll(pattern)].map((match) => ({ id, index: match.index })));
    const columnCount = new Set(labels.filter(({ id }) => id.endsWith('-column')).map(({ id }) => id)).size;
    const structuralLabels = labels.filter(({ id }) => !id.endsWith('-column') || columnCount >= 2);
    if (structuralLabels.length) structure.push(structuralLabels.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id)).map(({ id }) => id));
    if (structure.length > 500) return null;
  }
  if (new Set(structure.flat()).size < 3) return null;
  return createHash('sha256').update(JSON.stringify({ version: layoutFingerprintVersion, pageCount, structure })).digest('hex');
}
