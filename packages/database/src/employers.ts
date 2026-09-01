import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export const employerStatuses = ["PENDING", "VERIFIED", "MERGED", "REJECTED"] as const;
export const employerSources = ["LEGACY", "MANUAL", "DOCUMENT", "ADMIN"] as const;

export type EmployerStatus = typeof employerStatuses[number];
export type EmployerSource = typeof employerSources[number];
export type EmployerResolutionOutcome = "CREATED" | "IDENTIFIER" | "ALIAS" | "NAME";
export type EmployerResolutionErrorCode = "AMBIGUOUS" | "REJECTED_IDENTIFIER" | "INVALID_NAME";

export class EmployerResolutionError extends Error {
  readonly code: EmployerResolutionErrorCode;

  constructor(code: EmployerResolutionErrorCode) {
    super(code);
    this.code = code;
  }
}

export type ResolvedEmployer = Readonly<{
  id: string;
  name: string;
  normalizedName: string;
  countryCode: string;
  status: Exclude<EmployerStatus, "MERGED" | "REJECTED">;
  createdSource: EmployerSource;
}>;

export type ProtectedEmployerIdentifier = Readonly<{
  countryCode: string;
  type: string;
  fingerprint: string;
  ciphertext: Uint8Array;
  keyVersion: string;
  maskedSuffix: string;
}>;

export type ResolveEmployerInput = Readonly<{
  name: string;
  countryCode: string;
  createdByUserId: string | null;
  createdSource: EmployerSource;
  identifier?: ProtectedEmployerIdentifier;
  preferredEmployerId?: string;
}>;

export type EmployerResolution = ResolvedEmployer & Readonly<{
  outcome: EmployerResolutionOutcome;
}>;

type EmployerRow = {
  id: string;
  name: string;
  normalized_name: string;
  country_code: string;
  status: EmployerStatus;
  created_source: EmployerSource;
  merged_into_employer_id: string | null;
};

export function normalizeEmployerName(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(".", "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function normalizeEmployerNameConservative(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(".", "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export async function normalizeEmployerNameInDatabase(
  client: PoolClient,
  value: string,
): Promise<string> {
  const normalized = await client.query<{ normalized_name: string }>(
    "SELECT normalize_employer_name($1) AS normalized_name",
    [value],
  );
  return normalized.rows[0]?.normalized_name ?? "";
}

export async function lockEmployerMutation(client: PoolClient): Promise<void> {
  // ponytail: one global lock is safer than multi-identity lock choreography; partition only after measured contention.
  await client.query("SELECT pg_advisory_xact_lock(713, 12013)");
}

function validateInput(input: ResolveEmployerInput): void {
  const normalizedName = normalizeEmployerName(input.name);
  if (!normalizedName || input.name.length > 200 || !/^[A-Z]{2}$/.test(input.countryCode)) {
    throw new EmployerResolutionError("INVALID_NAME");
  }
  if (!employerSources.includes(input.createdSource)) throw new Error("Invalid employer source");
  if (!input.identifier) return;
  const identifier = input.identifier;
  if (
    identifier.countryCode !== input.countryCode
    || !/^[A-Z]{2}$/.test(identifier.countryCode)
    || identifier.type.length < 1
    || identifier.type.length > 32
    || !/^[0-9a-f]{64}$/.test(identifier.fingerprint)
    || identifier.ciphertext.byteLength === 0
    || identifier.keyVersion.length < 1
    || identifier.keyVersion.length > 64
    || !/^[A-Za-z0-9]{2,8}$/.test(identifier.maskedSuffix)
  ) {
    throw new Error("Invalid protected employer identifier");
  }
}

function employerFrom(row: EmployerRow): ResolvedEmployer {
  if (row.status === "MERGED" || row.status === "REJECTED") {
    throw new Error("Employer is not canonical");
  }
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    countryCode: row.country_code,
    status: row.status,
    createdSource: row.created_source,
  };
}

export async function followMergedEmployer(
  client: PoolClient,
  employerId: string,
): Promise<ResolvedEmployer | null> {
  const visited = new Set<string>();
  let currentId = employerId;
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(currentId)) throw new Error("Employer merge cycle detected");
    visited.add(currentId);
    const result = await client.query<EmployerRow>(
      `SELECT id, name, normalized_name, country_code, status, created_source,
              merged_into_employer_id
         FROM employers
        WHERE id = $1
        FOR KEY SHARE`,
      [currentId],
    );
    const row = result.rows[0];
    if (!row || row.status === "REJECTED") return null;
    if (row.status !== "MERGED") return employerFrom(row);
    if (!row.merged_into_employer_id) throw new Error("Merged employer has no target");
    currentId = row.merged_into_employer_id;
  }
  throw new Error("Employer merge chain is too deep");
}

async function uniqueCanonicalEmployer(
  client: PoolClient,
  employerIds: readonly string[],
): Promise<{ kind: "none" } | { kind: "one"; employer: ResolvedEmployer } | { kind: "ambiguous" }> {
  if (employerIds.length === 0) return { kind: "none" };
  const candidates = new Map<string, ResolvedEmployer>();
  for (const employerId of employerIds) {
    const employer = await followMergedEmployer(client, employerId);
    if (employer) candidates.set(employer.id, employer);
    if (candidates.size > 1) return { kind: "ambiguous" };
  }
  const employer = candidates.values().next().value;
  return employer ? { kind: "one", employer } : { kind: "none" };
}

async function preferredCanonicalCandidate(
  client: PoolClient,
  employerIds: readonly string[],
  preferredEmployerId: string | undefined,
): Promise<ResolvedEmployer | null> {
  if (!preferredEmployerId || employerIds.length === 0) return null;
  const preferred = await followMergedEmployer(client, preferredEmployerId);
  if (!preferred) return null;
  if (employerIds.includes(preferredEmployerId) || employerIds.includes(preferred.id)) return preferred;
  const merged = await client.query<{ id: string }>(
    "SELECT id FROM employers WHERE id = ANY($1::uuid[]) AND status = 'MERGED'",
    [employerIds],
  );
  for (const candidate of merged.rows) {
    if ((await followMergedEmployer(client, candidate.id))?.id === preferred.id) return preferred;
  }
  return null;
}

async function nameCandidates(
  client: PoolClient,
  countryCode: string,
  normalizedName: string,
  rawName: string,
  conservativeCanonicalNames: boolean,
): Promise<Array<{ employer_id: string; match_kind: "ALIAS" | "NAME" }>> {
  const matched = await client.query<{ employer_id: string; match_kind: "ALIAS" | "NAME" }>(
    `SELECT candidate.employer_id, candidate.match_kind
       FROM (
         SELECT alias.employer_id, 'ALIAS'::text AS match_kind
           FROM employer_aliases AS alias
           JOIN employers AS employer ON employer.id = alias.employer_id
          WHERE employer.country_code = $1 AND alias.normalized_alias = $2
            AND employer.status <> 'REJECTED'
            AND ($3::boolean = false OR normalize_employer_name_conservative(alias.alias)
              = normalize_employer_name_conservative($4))
         UNION ALL
         SELECT employer.id AS employer_id, 'NAME'::text AS match_kind
           FROM employers AS employer
          WHERE employer.country_code = $1 AND employer.normalized_name = $2
            AND employer.status <> 'REJECTED'
            AND ($3::boolean = false OR normalize_employer_name_conservative(employer.name)
              = normalize_employer_name_conservative($4))
       ) AS candidate
      ORDER BY candidate.employer_id`,
    [countryCode, normalizedName, conservativeCanonicalNames, rawName],
  );
  return matched.rows;
}

async function addProtectedIdentifier(
  client: PoolClient,
  employerId: string,
  input: ResolveEmployerInput,
): Promise<void> {
  const identifier = input.identifier;
  if (!identifier) return;
  await client.query(
    `INSERT INTO employer_identifiers (
       id, employer_id, country_code, identifier_type, identifier_ciphertext,
       identifier_fingerprint, identifier_key_version, masked_suffix,
       created_source, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (country_code, identifier_type, identifier_fingerprint)
       WHERE identifier_fingerprint IS NOT NULL
     DO NOTHING`,
    [
      randomUUID(), employerId, identifier.countryCode, identifier.type,
      Buffer.from(identifier.ciphertext), identifier.fingerprint, identifier.keyVersion,
      identifier.maskedSuffix, input.createdSource, input.createdByUserId,
    ],
  );
}

async function addAliasForStrongMatch(
  client: PoolClient,
  employer: ResolvedEmployer,
  input: ResolveEmployerInput,
  normalizedName: string,
): Promise<void> {
  if (!input.identifier || employer.normalizedName === normalizedName) return;
  const candidates = await nameCandidates(client, input.countryCode, normalizedName, input.name, false);
  const canonical = await uniqueCanonicalEmployer(client, candidates.map(({ employer_id }) => employer_id));
  if (canonical.kind === "ambiguous" || (canonical.kind === "one" && canonical.employer.id !== employer.id)) return;
  await client.query(
    `INSERT INTO employer_aliases (
       id, employer_id, alias, created_source, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employer_id, normalized_alias) DO NOTHING`,
    [randomUUID(), employer.id, input.name.trim(), input.createdSource, input.createdByUserId],
  );
}

export async function resolveEmployer(
  client: PoolClient,
  input: ResolveEmployerInput,
): Promise<EmployerResolution> {
  const normalizedInput: ResolveEmployerInput = { ...input, name: input.name.trim() };
  validateInput(normalizedInput);
  await lockEmployerMutation(client);
  const normalizedName = await normalizeEmployerNameInDatabase(client, normalizedInput.name);
  if (!normalizedName || [...normalizedName].length > 200) {
    throw new EmployerResolutionError("INVALID_NAME");
  }

  if (normalizedInput.identifier) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `employer-identifier:${normalizedInput.identifier.countryCode}:${normalizedInput.identifier.type}:${normalizedInput.identifier.fingerprint}`,
    ]);
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `employer-name:${normalizedInput.countryCode}:${normalizedName}`,
  ]);

  if (normalizedInput.identifier) {
    const identified = await client.query<{ employer_id: string }>(
      `SELECT employer_id
         FROM employer_identifiers
        WHERE country_code = $1 AND identifier_type = $2 AND identifier_fingerprint = $3`,
      [normalizedInput.identifier.countryCode, normalizedInput.identifier.type, normalizedInput.identifier.fingerprint],
    );
    const employer = identified.rows[0]
      ? await followMergedEmployer(client, identified.rows[0].employer_id)
      : null;
    if (identified.rows[0] && !employer) {
      throw new EmployerResolutionError("REJECTED_IDENTIFIER");
    }
    if (employer) {
      await addAliasForStrongMatch(client, employer, normalizedInput, normalizedName);
      return { ...employer, outcome: "IDENTIFIER" };
    }
  }

  const matched = await nameCandidates(
    client, normalizedInput.countryCode, normalizedName, normalizedInput.name, true,
  );
  const matchedIds = matched.map(({ employer_id }) => employer_id);
  const preferred = await preferredCanonicalCandidate(client, matchedIds, normalizedInput.preferredEmployerId);
  const exactMatch = preferred
    ? { kind: "one" as const, employer: preferred }
    : await uniqueCanonicalEmployer(client, matchedIds);
  if (exactMatch.kind === "ambiguous") throw new EmployerResolutionError("AMBIGUOUS");
  if (exactMatch.kind === "one") {
    const conflictingIdentifier = normalizedInput.identifier ? await client.query(
      `SELECT 1 FROM employer_identifiers
        WHERE employer_id = $1 AND country_code = $2 AND identifier_type = $3
          AND (identifier_fingerprint IS NULL OR identifier_fingerprint <> $4)
        LIMIT 1`,
      [
        exactMatch.employer.id,
        normalizedInput.identifier.countryCode,
        normalizedInput.identifier.type,
        normalizedInput.identifier.fingerprint,
      ],
    ) : null;
    if (!conflictingIdentifier?.rowCount) {
      await addProtectedIdentifier(client, exactMatch.employer.id, normalizedInput);
      const directNameMatch = matched.some(({ employer_id, match_kind }) =>
        match_kind === "NAME" && employer_id === exactMatch.employer.id);
      return { ...exactMatch.employer, outcome: directNameMatch ? "NAME" : "ALIAS" };
    }
  }

  const inserted = await client.query<EmployerRow>(
    `INSERT INTO employers (
       id, created_by_user_id, name, country_code, status, created_source
     ) VALUES ($1, $2, $3, $4, 'PENDING', $5)
     RETURNING id, name, normalized_name, country_code, status, created_source,
               merged_into_employer_id`,
    [
      randomUUID(), normalizedInput.createdByUserId, normalizedInput.name,
      normalizedInput.countryCode, normalizedInput.createdSource,
    ],
  );
  const employer = employerFrom(inserted.rows[0]!);
  await addProtectedIdentifier(client, employer.id, normalizedInput);
  return { ...employer, outcome: "CREATED" };
}
