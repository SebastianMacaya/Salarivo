import type { PoolClient } from "pg";
import { normalizeEmployerNameConservative } from "./employers.ts";
import { processingPipelineVersions } from "./processing.ts";

export const documentLayoutParserVersion = processingPipelineVersions.parser;

export const layoutAliasFields = [
  "settlement.basicAmount", "settlement.grossAmount", "settlement.netAmount",
  "settlement.remunerativeAmount", "settlement.nonRemunerativeAmount", "settlement.deductionsAmount",
  "settlement.payrollPeriod",
] as const;
export type LayoutAliasField = typeof layoutAliasFields[number];
export type LayoutAliases = Partial<Record<LayoutAliasField, string[]>>;
export type ApprovedDocumentLayout = {
  id: string; layoutId: string; version: number; fingerprint: string; fingerprintVersion: "1"; aliases: LayoutAliases;
  countryCode: string; documentType: 'PAYROLL'; parserVersion: string;
};

export function hasNewDocumentLayoutSql(runAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(runAlias)) throw new Error("INVALID_SQL_ALIAS");
  return `EXISTS (
    SELECT 1 FROM document_layouts layout
      JOIN employers employer ON employer.id = layout.employer_id
      JOIN LATERAL (SELECT id, enabled, approved_at FROM document_layout_versions
        WHERE layout_id = layout.id ORDER BY version DESC LIMIT 1) latest_layout ON true
     WHERE employer.status = 'VERIFIED' AND employer.country_code = layout.country_code
       AND layout.country_code = ${runAlias}.country_code AND layout.document_type = 'PAYROLL'
       AND layout.parser_version = '${processingPipelineVersions.parser}'
       AND layout.employer_id = ${runAlias}.detected_employer_id
       AND layout.fingerprint_version = ${runAlias}.layout_fingerprint_version
       AND layout.structural_fingerprint = ${runAlias}.layout_fingerprint
       AND latest_layout.enabled AND latest_layout.approved_at > ${runAlias}.started_at
       AND latest_layout.id IS DISTINCT FROM ${runAlias}.document_layout_version_id
  )`;
}

// Labels are literal, operator-authored configuration: no expressions, digits, URLs or source payloads.
export function validateLayoutAliases(value: unknown, enabled = true): LayoutAliases | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > layoutAliasFields.length || (enabled && entries.length === 0)) return null;
  const result: LayoutAliases = {};
  const seen = new Set<string>();
  for (const [field, aliases] of entries) {
    if (!(layoutAliasFields as readonly string[]).includes(field) || !Array.isArray(aliases) || aliases.length < 1 || aliases.length > 4) return null;
    const normalized: string[] = [];
    for (const alias of aliases) {
      if (typeof alias !== "string" || alias.length < 2 || alias.length > 60
        || !/^[\p{L}][\p{L} .():-]*[\p{L}.):]$/u.test(alias) || alias !== alias.trim()) return null;
      const key = alias.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").replace(/[.:]+$/, "");
      if (seen.has(key)) return null;
      seen.add(key);
      normalized.push(alias);
    }
    result[field as LayoutAliasField] = normalized;
  }
  return result;
}

export async function findApprovedDocumentLayout(
  client: Pick<PoolClient, "query">,
  input: { countryCode: string | null; employerName: string; fingerprint: string; fingerprintVersion?: "1";
    documentType?: 'PAYROLL'; parserVersion?: string },
): Promise<ApprovedDocumentLayout | null> {
  if (input.countryCode !== 'AR' || !/^[0-9a-f]{64}$/.test(input.fingerprint) || !input.employerName || input.employerName.length > 200) return null;
  // Match all live identities first: a pending namesake must make reuse ambiguous, too.
  const versions = await client.query(
    `WITH identities AS (SELECT DISTINCT employer.id, employer.status FROM employers employer
       LEFT JOIN employer_aliases alias ON alias.employer_id = employer.id
      WHERE employer.country_code = $4 AND employer.status IN ('PENDING', 'VERIFIED')
        AND (lower(btrim(regexp_replace(replace(normalize(employer.name, NFKC), '.', ''), '\\s+', ' ', 'g'))) = $1
          OR lower(btrim(regexp_replace(replace(normalize(alias.alias, NFKC), '.', ''), '\\s+', ' ', 'g'))) = $1)
      ORDER BY employer.id LIMIT 2)
     SELECT version.id, version.layout_id, version.version, version.aliases, version.enabled
       FROM document_layouts layout JOIN document_layout_versions version ON version.layout_id = layout.id
       JOIN identities employer ON employer.id = layout.employer_id
      WHERE employer.status = 'VERIFIED' AND (SELECT count(*) FROM identities) = 1
        AND layout.fingerprint_version = $2 AND layout.structural_fingerprint = $3
        AND layout.country_code = $4 AND layout.document_type = $5 AND layout.parser_version = $6
      ORDER BY version.version DESC LIMIT 1`,
    [normalizeEmployerNameConservative(input.employerName), input.fingerprintVersion ?? "1", input.fingerprint,
      input.countryCode, input.documentType ?? 'PAYROLL', input.parserVersion ?? processingPipelineVersions.parser],
  );
  const row = versions.rows[0];
  if (!row?.enabled) return null;
  const aliases = validateLayoutAliases(row.aliases);
  return aliases ? { id: String(row.id), layoutId: String(row.layout_id), version: Number(row.version),
    fingerprint: input.fingerprint, fingerprintVersion: "1", aliases, countryCode: input.countryCode,
    documentType: input.documentType ?? 'PAYROLL', parserVersion: input.parserVersion ?? processingPipelineVersions.parser } : null;
}
