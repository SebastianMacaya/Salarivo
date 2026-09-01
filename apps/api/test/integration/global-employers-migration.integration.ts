import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  loadMigrations,
  normalizeEmployerName,
  resolveEmployer,
  type Migration,
} from "@salarivo/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

type LegacySchema = Readonly<{ client: PoolClient; name: string }>;

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createLegacySchema(pool: Pool, migrations: readonly Migration[]): Promise<LegacySchema> {
  const name = `migration_019_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${name}"`);
  await client.query(`SET search_path TO "${name}", public`);
  for (const migration of migrations.filter(({ version }) => version <= 18)) {
    await applyMigration(client, migration);
  }
  return { client, name };
}

async function dropLegacySchema(pool: Pool, schema: LegacySchema): Promise<void> {
  assert.match(schema.name, /^migration_019_[0-9a-f]{32}$/);
  schema.client.release();
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA "${schema.name}" CASCADE`);
  } finally {
    client.release();
  }
}

async function insertLegacyUser(client: PoolClient, label: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, $2, $3)`,
    [id, `${label}-${randomUUID()}@example.test`, "synthetic-password-hash-for-migration"],
  );
  return id;
}

async function insertLegacyEmployer(client: PoolClient, userId: string, name: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employers (id, user_id, name, country_code)
     VALUES ($1, $2, $3, 'AR')`,
    [id, userId, name],
  );
  return id;
}

async function insertLegacyEmployment(
  client: PoolClient,
  userId: string,
  employerId: string,
  id = randomUUID(),
): Promise<string> {
  await client.query(
    `INSERT INTO employments (
       id, user_id, employer_id, status, start_date, role, category, modality,
       country_code, currency_code, created_at
     ) VALUES ($1, $2, $3, 'ACTIVE', '2024-11-01', 'Analista', 'STAFF',
       'REMOTE', 'AR', 'ARS', '2026-01-01T00:00:00Z')`,
    [id, userId, employerId],
  );
  return id;
}

async function insertLegacyDocument(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    documentEmploymentId: string | null;
    itemEmploymentId: string | null;
    settlementEmploymentId: string | null;
    employerName: string;
    payrollPeriod?: string;
  }>,
): Promise<{ documentId: string; itemId: string; settlementId: string }> {
  const batchId = randomUUID();
  const itemId = randomUUID();
  const uploadId = randomUUID();
  const documentId = randomUUID();
  const runId = randomUUID();
  const settlementId = randomUUID();
  const marker = randomUUID();
  await client.query(
    `INSERT INTO import_batches (id, user_id, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4)`,
    [batchId, input.userId, `migration-019-${marker}`, createHash("sha256").update(marker).digest("hex")],
  );
  await client.query(
    `INSERT INTO import_batch_items (
       id, user_id, batch_id, employment_id, client_item_key, ordinal,
       original_filename, declared_mime_type, expected_size_bytes, status
     ) VALUES ($1, $2, $3, $4, $5, 0, 'synthetic.pdf', 'application/pdf', 128, 'COMPLETED')`,
    [itemId, input.userId, batchId, input.itemEmploymentId, `synthetic-${marker}`],
  );
  await client.query(
    `INSERT INTO upload_sessions (
       id, user_id, batch_id, item_id, object_key, expected_size_bytes,
       expected_mime_type, status, expires_at, confirmed_at
     ) VALUES ($1, $2, $3, $4, $5, 128, 'application/pdf', 'CONFIRMED',
       now() + interval '1 hour', now())`,
    [uploadId, input.userId, batchId, itemId, `migration-019/${marker}/synthetic.pdf`],
  );
  await client.query(
    `INSERT INTO documents (
       id, user_id, import_batch_id, import_batch_item_id, upload_session_id,
       employment_id, object_key, original_filename, declared_mime_type,
       detected_mime_type, size_bytes, page_count, security_status,
       classification_status, document_type, classification_confidence,
       processing_status, retention_policy, processed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'synthetic.pdf', 'application/pdf',
       'application/pdf', 128, 1, 'CLEAN', 'SUPPORTED', 'PAYROLL', 1,
       'COMPLETED', 'KEEP_ORIGINAL', now())`,
    [documentId, input.userId, batchId, itemId, uploadId, input.documentEmploymentId,
      `migration-019/${marker}/canonical.pdf`],
  );
  await client.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at
     ) VALUES ($1, $2, $3, 1, 'COMPLETED', 'synthetic', '1', '1', '1', now())`,
    [runId, input.userId, documentId],
  );
  await client.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version
     ) VALUES ($1, $2, $3, $4, 'employer.name', 'EMPLOYER', 'synthetic-employer',
       $5::jsonb, 1, 'RULE', '1')`,
    [randomUUID(), input.userId, documentId, runId, JSON.stringify(input.employerName)],
  );
  await client.query(
    `INSERT INTO payroll_settlements (
       id, user_id, document_id, extraction_run_id, employment_id,
       settlement_ordinal, payroll_period, settlement_type, is_recurring, currency_code
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, 'NORMAL', true, 'ARS')`,
    [settlementId, input.userId, documentId, runId, input.settlementEmploymentId,
      input.payrollPeriod ?? "2026-07-01"],
  );
  return { documentId, itemId, settlementId };
}

async function salaryStructure(client: PoolClient, userId: string): Promise<unknown> {
  const result = await client.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object(
       'settlements', COALESCE((
         SELECT jsonb_agg(to_jsonb(settlement) - 'employment_id' ORDER BY settlement.id)
           FROM payroll_settlements settlement WHERE settlement.user_id = $1
       ), '[]'::jsonb),
       'lineItems', COALESCE((
         SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
           FROM payroll_line_items item WHERE item.user_id = $1
       ), '[]'::jsonb)
     ) AS snapshot`,
    [userId],
  );
  return result.rows[0]!.snapshot;
}

async function resolveInSchema(
  pool: Pool,
  schemaName: string,
  input: Parameters<typeof resolveEmployer>[1],
) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}", public`);
    await client.query("BEGIN");
    const employer = await resolveEmployer(client, input);
    await client.query("COMMIT");
    return employer;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test("migration 019 upgrades legacy data fail-closed and keeps employer resolution deterministic", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const migrations = await loadMigrations();
  const migration019 = migrations.find(({ version }) => version === 19);
  assert.ok(migration019);
  const schemas: LegacySchema[] = [];
  try {
    const successful = await createLegacySchema(pool, migrations);
    schemas.push(successful);
    const userId = await insertLegacyUser(successful.client, "migration-success");
    const secondUserId = await insertLegacyUser(successful.client, "migration-shared");
    const employerId = await insertLegacyEmployer(successful.client, userId, "Empresa Provincial Sintética S.A.");
    const firstEmploymentId = "00000000-0000-4000-8000-000000000101";
    const secondEmploymentId = "00000000-0000-4000-8000-000000000102";
    await insertLegacyEmployment(successful.client, userId, employerId, firstEmploymentId);
    await insertLegacyEmployment(successful.client, userId, employerId, secondEmploymentId);
    const duplicateDocument = await insertLegacyDocument(successful.client, {
      userId,
      documentEmploymentId: secondEmploymentId,
      itemEmploymentId: secondEmploymentId,
      settlementEmploymentId: secondEmploymentId,
      employerName: "Empresa Provincial Sintética S.A.",
    });
    const detectedDocument = await insertLegacyDocument(successful.client, {
      userId,
      documentEmploymentId: null,
      itemEmploymentId: null,
      settlementEmploymentId: null,
      employerName: "Empresa Provincial Sintética SA",
    });
    await successful.client.query(
      `UPDATE payroll_settlements
          SET payment_date = '2026-07-31', issue_date = '2026-07-29',
              basic_amount = 123456.78, gross_amount = 150000.00, net_amount = 120000.00,
              remunerative_amount = 140000.00, non_remunerative_amount = 10000.00,
              deductions_amount = 30000.00
        WHERE id = $1`,
      [detectedDocument.settlementId],
    );
    await successful.client.query(
      `INSERT INTO payroll_line_items (
         id, user_id, settlement_id, item_ordinal, raw_description, normalized_concept_code,
         amount, currency_code, item_type, is_recurring, confidence, source_page, source_field
       ) VALUES
         ($1, $3, $4, 1, 'Sueldo básico sintético', 'BASIC_SALARY', 123456.78, 'ARS', 'EARNING', true, 0.9900, 1, 'basic'),
         ($2, $3, $4, 2, 'Deducción', NULL, 30000.00, 'ARS', 'DEDUCTION', NULL, 0.9800, 1, NULL)`,
      [randomUUID(), randomUUID(), userId, detectedDocument.settlementId],
    );
    const salaryStructureBefore = await salaryStructure(successful.client, userId);
    const salaryStructureHashBefore = createHash("sha256").update(JSON.stringify(salaryStructureBefore)).digest("hex");

    await applyMigration(successful.client, migration019);

    const salaryStructureAfter = await salaryStructure(successful.client, userId);
    assert.deepEqual(salaryStructureAfter, salaryStructureBefore);
    assert.equal(
      createHash("sha256").update(JSON.stringify(salaryStructureAfter)).digest("hex"),
      salaryStructureHashBefore,
    );

    const surviving = await successful.client.query<{ id: string }>(
      "SELECT id FROM employments WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    assert.deepEqual(surviving.rows.map(({ id }) => id), [firstEmploymentId]);
    for (const fixture of [duplicateDocument, detectedDocument]) {
      const references = await successful.client.query(
        `SELECT document.employment_id AS document_employment_id,
                document.detected_employer_id, item.employment_id AS item_employment_id,
                settlement.employment_id AS settlement_employment_id
           FROM documents AS document
           JOIN import_batch_items AS item ON item.id = document.import_batch_item_id
           JOIN payroll_settlements AS settlement ON settlement.document_id = document.id
          WHERE document.id = $1`,
        [fixture.documentId],
      );
      assert.equal(references.rows[0].document_employment_id, firstEmploymentId);
      assert.equal(references.rows[0].item_employment_id, firstEmploymentId);
      assert.equal(references.rows[0].settlement_employment_id, firstEmploymentId);
      assert.equal(references.rows[0].detected_employer_id, employerId);
    }
    const migrationAudit = await successful.client.query<{ metadata_no_sensitive: unknown }>(
      `SELECT metadata_no_sensitive FROM audit_events
        WHERE action = 'EMPLOYMENT_AUTO_ASSOCIATED' AND resource_id = $1`,
      [detectedDocument.documentId],
    );
    assert.equal(migrationAudit.rowCount, 1);
    const auditText = JSON.stringify(migrationAudit.rows[0]!.metadata_no_sensitive);
    assert.doesNotMatch(auditText, /Provincial|synthetic-employer|salary|ocr|gross|net/i);

    const normalizationCorpus = [
      "ACME S.A.", "\tACME S.A.\n", "Empresa+Norte", "Empresa$Norte", "Marca×Sur", "Marca©Sur",
    ];
    for (const sample of normalizationCorpus) {
      const sql = await successful.client.query<{ normalized: string }>(
        "SELECT normalize_employer_name($1) AS normalized",
        [sample],
      );
      assert.equal(normalizeEmployerName(sample), sql.rows[0]!.normalized);
    }

    const [sharedOne, sharedTwo] = await Promise.all([
      resolveInSchema(pool, successful.name, {
        name: "Empresa Compartida SA", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
      }),
      resolveInSchema(pool, successful.name, {
        name: "EMPRESA COMPARTIDA S.A.", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
      }),
    ]);
    assert.equal(sharedOne.id, sharedTwo.id);
    assert.equal((await successful.client.query(
      "SELECT count(*)::integer AS count FROM employers WHERE normalized_name = normalize_employer_name('Empresa Compartida SA')",
    )).rows[0].count, 1);
    const whitespacePlain = await resolveInSchema(pool, successful.name, {
      name: "Empresa Con Bordes", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
    });
    const whitespacePadded = await resolveInSchema(pool, successful.name, {
      name: "\tEmpresa Con Bordes\n", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    assert.equal(whitespacePadded.id, whitespacePlain.id);
    assert.equal(whitespacePlain.name, "Empresa Con Bordes");

    const preferredEmployerId = randomUUID();
    const homonymEmployerId = randomUUID();
    await successful.client.query(
      `INSERT INTO employers (id, created_by_user_id, name, country_code, status, created_source)
       VALUES ($1, $3, 'Empresa Homónima Sintética SA', 'AR', 'PENDING', 'MANUAL'),
              ($2, $4, 'Empresa Homónima Sintética SA', 'AR', 'PENDING', 'MANUAL')`,
      [preferredEmployerId, homonymEmployerId, userId, secondUserId],
    );
    await assert.rejects(
      resolveInSchema(pool, successful.name, {
        name: "Empresa Homónima Sintética SA", countryCode: "AR",
        createdByUserId: userId, createdSource: "DOCUMENT",
      }),
      /AMBIGUOUS/,
    );
    const preferredHomonym = await resolveInSchema(pool, successful.name, {
      name: "Empresa Homónima Sintética SA", countryCode: "AR",
      createdByUserId: userId, createdSource: "DOCUMENT", preferredEmployerId,
    });
    assert.equal(preferredHomonym.id, preferredEmployerId);
    await assert.rejects(
      resolveInSchema(pool, successful.name, {
        name: "Empresa Homónima Sintética SA", countryCode: "AR",
        createdByUserId: userId, createdSource: "DOCUMENT", preferredEmployerId: whitespacePlain.id,
      }),
      /AMBIGUOUS/,
    );

    const mergedPreferredSourceId = randomUUID();
    const mergedPreferredHomonymId = randomUUID();
    await successful.client.query(
      `INSERT INTO employers (
         id, created_by_user_id, name, country_code, status, created_source, merged_into_employer_id
       ) VALUES ($1, $3, 'Empresa Histórica Sintética SA', 'AR', 'MERGED', 'ADMIN', $4),
                ($2, $3, 'Empresa Histórica Sintética SA', 'AR', 'PENDING', 'MANUAL', NULL)`,
      [mergedPreferredSourceId, mergedPreferredHomonymId, userId, preferredEmployerId],
    );
    const preferredThroughMerge = await resolveInSchema(pool, successful.name, {
      name: "Empresa Histórica Sintética SA", countryCode: "AR",
      createdByUserId: userId, createdSource: "DOCUMENT", preferredEmployerId,
    });
    assert.equal(preferredThroughMerge.id, preferredEmployerId);

    const plus = await resolveInSchema(pool, successful.name, {
      name: "Empresa+Norte", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
    });
    const dash = await resolveInSchema(pool, successful.name, {
      name: "Empresa-Norte", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
    });
    const dashAgain = await resolveInSchema(pool, successful.name, {
      name: "EMPRESA-NORTE", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    assert.notEqual(plus.id, dash.id);
    assert.equal(dash.id, dashAgain.id);

    const identifierFingerprint = createHash("sha256").update(randomUUID()).digest("hex");
    await successful.client.query(
      `INSERT INTO employer_identifiers (
         id, employer_id, country_code, identifier_type, identifier_ciphertext,
         identifier_fingerprint, identifier_key_version, masked_suffix,
         created_source, created_by_user_id
       ) VALUES ($1, $2, 'AR', 'CUIT', $3, $4, 'test-v1', '1234', 'ADMIN', $5)`,
      [randomUUID(), plus.id, Buffer.from("synthetic-encrypted-identifier"), identifierFingerprint, userId],
    );
    await assert.rejects(
      successful.client.query(
        `INSERT INTO employer_identifiers (
           id, employer_id, country_code, identifier_type, identifier_ciphertext,
           identifier_fingerprint, identifier_key_version, masked_suffix,
           created_source, created_by_user_id
         ) VALUES ($1, $2, 'AR', 'CUIT', $3, $4, 'test-v1', '5678', 'ADMIN', $5)`,
        [
          randomUUID(), plus.id, Buffer.from("synthetic-second-encrypted-identifier"),
          createHash("sha256").update(randomUUID()).digest("hex"), userId,
        ],
      ),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23505",
    );
    const strongMatch = await resolveInSchema(pool, successful.name, {
      name: "Empresa-Norte",
      countryCode: "AR",
      createdByUserId: userId,
      createdSource: "DOCUMENT",
      identifier: {
        countryCode: "AR", type: "CUIT", fingerprint: identifierFingerprint,
        ciphertext: Buffer.from("synthetic-encrypted-identifier"), keyVersion: "test-v1", maskedSuffix: "1234",
      },
    });
    assert.equal(strongMatch.id, plus.id);
    assert.equal((await successful.client.query(
      "SELECT count(*)::integer AS count FROM employer_aliases WHERE employer_id = $1 AND normalized_alias = normalize_employer_name('Empresa-Norte')",
      [plus.id],
    )).rows[0].count, 0);
    await successful.client.query(
      `INSERT INTO employer_aliases (id, employer_id, alias, created_source, created_by_user_id)
       VALUES ($1, $2, 'Alias+Norte', 'ADMIN', $3)`,
      [randomUUID(), plus.id, userId],
    );
    const unsafeAliasVariant = await resolveInSchema(pool, successful.name, {
      name: "Alias-Norte", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    const exactAlias = await resolveInSchema(pool, successful.name, {
      name: "Alias+Norte", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    assert.notEqual(unsafeAliasVariant.id, plus.id);
    assert.equal(exactAlias.id, plus.id);

    const fiscalFingerprintA = createHash("sha256").update(`fiscal-a-${randomUUID()}`).digest("hex");
    const fiscalFingerprintB = createHash("sha256").update(`fiscal-b-${randomUUID()}`).digest("hex");
    const fiscalA = await resolveInSchema(pool, successful.name, {
      name: "Identidad Fiscal Homónima", countryCode: "AR", createdByUserId: userId, createdSource: "DOCUMENT",
      identifier: {
        countryCode: "AR", type: "CUIT", fingerprint: fiscalFingerprintA,
        ciphertext: Buffer.from("synthetic-fiscal-a"), keyVersion: "test-v1", maskedSuffix: "1001",
      },
    });
    const fiscalB = await resolveInSchema(pool, successful.name, {
      name: "Identidad Fiscal Homónima", countryCode: "AR", createdByUserId: secondUserId, createdSource: "DOCUMENT",
      identifier: {
        countryCode: "AR", type: "CUIT", fingerprint: fiscalFingerprintB,
        ciphertext: Buffer.from("synthetic-fiscal-b"), keyVersion: "test-v1", maskedSuffix: "2002",
      },
    });
    assert.notEqual(fiscalA.id, fiscalB.id);
    const fiscalIdentifiers = (await successful.client.query(
      `SELECT employer_id, identifier_fingerprint FROM employer_identifiers
        WHERE identifier_fingerprint = ANY($1::text[])`,
      [[fiscalFingerprintA, fiscalFingerprintB]],
    )).rows;
    assert.equal(fiscalIdentifiers.find((row) => row.identifier_fingerprint === fiscalFingerprintA)?.employer_id, fiscalA.id);
    assert.equal(fiscalIdentifiers.find((row) => row.identifier_fingerprint === fiscalFingerprintB)?.employer_id, fiscalB.id);

    const enrichable = await resolveInSchema(pool, successful.name, {
      name: "Empresa Enriquecible", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
    });
    const enrichableFingerprint = createHash("sha256").update(`enrich-${randomUUID()}`).digest("hex");
    const enriched = await resolveInSchema(pool, successful.name, {
      name: "Empresa Enriquecible", countryCode: "AR", createdByUserId: userId, createdSource: "DOCUMENT",
      identifier: {
        countryCode: "AR", type: "CUIT", fingerprint: enrichableFingerprint,
        ciphertext: Buffer.from("synthetic-enrichable"), keyVersion: "test-v1", maskedSuffix: "3003",
      },
    });
    assert.equal(enriched.id, enrichable.id);

    const legacyIdentified = await resolveInSchema(pool, successful.name, {
      name: "Empresa Con Identificador Legacy", countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
    });
    const legacyIdentifierId = randomUUID();
    await successful.client.query(
      `INSERT INTO employer_identifiers (
         id, employer_id, country_code, identifier_type, identifier_ciphertext,
         identifier_key_version, created_source, created_by_user_id
       ) VALUES ($1, $2, 'AR', 'CUIT', $3, 'legacy-v1', 'LEGACY', $4)`,
      [legacyIdentifierId, legacyIdentified.id, Buffer.from("synthetic-legacy-ciphertext"), userId],
    );
    const newFingerprint = createHash("sha256").update(`legacy-new-${randomUUID()}`).digest("hex");
    const separatedFromLegacy = await resolveInSchema(pool, successful.name, {
      name: "Empresa Con Identificador Legacy", countryCode: "AR", createdByUserId: secondUserId, createdSource: "DOCUMENT",
      identifier: {
        countryCode: "AR", type: "CUIT", fingerprint: newFingerprint,
        ciphertext: Buffer.from("synthetic-new-ciphertext"), keyVersion: "test-v1", maskedSuffix: "4004",
      },
    });
    assert.notEqual(separatedFromLegacy.id, legacyIdentified.id);
    assert.deepEqual((await successful.client.query(
      `SELECT employer_id, identifier_fingerprint, masked_suffix
         FROM employer_identifiers WHERE id = $1`,
      [legacyIdentifierId],
    )).rows[0], {
      employer_id: legacyIdentified.id,
      identifier_fingerprint: null,
      masked_suffix: null,
    });
    assert.equal((await successful.client.query(
      "SELECT employer_id FROM employer_identifiers WHERE identifier_fingerprint = $1",
      [newFingerprint],
    )).rows[0].employer_id, separatedFromLegacy.id);

    const mergedSourceId = randomUUID();
    await successful.client.query(
      `INSERT INTO employers (
         id, created_by_user_id, name, country_code, status, created_source, merged_into_employer_id
       ) VALUES ($1, $2, 'Empresa Compartida Histórica', 'AR', 'MERGED', 'ADMIN', $3)`,
      [mergedSourceId, userId, sharedOne.id],
    );
    const redirected = await resolveInSchema(pool, successful.name, {
      name: "Empresa Compartida Histórica", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    assert.equal(redirected.id, sharedOne.id);

    const rejectedId = randomUUID();
    await successful.client.query(
      `INSERT INTO employers (id, created_by_user_id, name, country_code, status, created_source)
       VALUES ($1, $2, 'Empresa Rechazada', 'AR', 'REJECTED', 'ADMIN')`,
      [rejectedId, userId],
    );
    await successful.client.query(
      `INSERT INTO employer_aliases (id, employer_id, alias, created_source, created_by_user_id)
       VALUES ($1, $2, 'Alias Rechazado', 'ADMIN', $3)`,
      [randomUUID(), rejectedId, userId],
    );
    const rejectedAliasResolution = await resolveInSchema(pool, successful.name, {
      name: "Alias Rechazado", countryCode: "AR", createdByUserId: secondUserId, createdSource: "MANUAL",
    });
    assert.notEqual(rejectedAliasResolution.id, rejectedId);
    assert.equal(rejectedAliasResolution.status, "PENDING");

    const emptyNormalization = await createLegacySchema(pool, migrations);
    schemas.push(emptyNormalization);
    const emptyUser = await insertLegacyUser(emptyNormalization.client, "migration-empty");
    await insertLegacyEmployer(emptyNormalization.client, emptyUser, "...");
    await assert.rejects(applyMigration(emptyNormalization.client, migration019), /GLOBAL_EMPLOYER_EMPTY_NORMALIZATION/);
    assert.equal((await emptyNormalization.client.query(
      `SELECT count(*)::integer AS count FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'employers' AND column_name = 'created_by_user_id'`,
    )).rows[0].count, 0);
    await emptyNormalization.client.query(
      "UPDATE employers SET name = $1 WHERE user_id = $2",
      ["ﬃ".repeat(100), emptyUser],
    );
    await assert.rejects(applyMigration(emptyNormalization.client, migration019), /GLOBAL_EMPLOYER_NORMALIZATION_TOO_LONG/);
    await assert.rejects(
      resolveInSchema(pool, successful.name, {
        name: "ﬃ".repeat(100), countryCode: "AR", createdByUserId: userId, createdSource: "MANUAL",
      }),
      /INVALID_NAME/,
    );

    const conflicting = await createLegacySchema(pool, migrations);
    schemas.push(conflicting);
    const conflictUser = await insertLegacyUser(conflicting.client, "migration-conflict");
    const conflictEmployer = await insertLegacyEmployer(conflicting.client, conflictUser, "Empresa Conflictiva");
    const employmentA = await insertLegacyEmployment(conflicting.client, conflictUser, conflictEmployer);
    const employmentB = await insertLegacyEmployment(
      conflicting.client,
      conflictUser,
      conflictEmployer,
      randomUUID(),
    );
    await conflicting.client.query(
      "UPDATE employments SET role = 'Otro rol' WHERE id = $1",
      [employmentB],
    );
    const conflictingDocument = await insertLegacyDocument(conflicting.client, {
      userId: conflictUser,
      documentEmploymentId: employmentA,
      itemEmploymentId: employmentA,
      settlementEmploymentId: employmentB,
      employerName: "Empresa Conflictiva",
    });
    await assert.rejects(applyMigration(conflicting.client, migration019), /GLOBAL_EMPLOYMENT_REFERENCE_CONFLICT/);
    assert.equal((await conflicting.client.query(
      "SELECT count(*)::integer AS count FROM employers WHERE user_id = $1",
      [conflictUser],
    )).rows[0].count, 1);
    await conflicting.client.query(
      "UPDATE payroll_settlements SET employment_id = $1 WHERE id = $2",
      [employmentA, conflictingDocument.settlementId],
    );
    await conflicting.client.query(
      "UPDATE import_batch_items SET employment_id = $1 WHERE id = $2",
      [employmentB, conflictingDocument.itemId],
    );
    await assert.rejects(applyMigration(conflicting.client, migration019), /GLOBAL_EMPLOYMENT_REFERENCE_CONFLICT/);
    await conflicting.client.query(
      "UPDATE documents SET employment_id = NULL WHERE id = $1",
      [conflictingDocument.documentId],
    );
    await assert.rejects(applyMigration(conflicting.client, migration019), /GLOBAL_EMPLOYMENT_REFERENCE_AMBIGUOUS/);
    assert.equal((await conflicting.client.query(
      `SELECT count(*)::integer AS count FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'detected_employer_id'`,
    )).rows[0].count, 0);
  } finally {
    for (const schema of schemas.reverse()) await dropLegacySchema(pool, schema);
    await pool.end();
  }
});
