import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

const origin = "http://localhost:3000";

test("admin employers conserva evidencia y fusiona referencias sin exponer identificadores", { timeout: 15_000 }, async (context) => {
  const [
    { buildApp }, { loadConfig }, { followMergedEmployer, pool, resolveEmployer, withTransaction },
    { opaqueToken, sessionCookieName, tokenHash },
  ] = await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("@salarivo/database"),
    import("../../src/security.ts"),
  ]);
  const config = loadConfig({ ...process.env, APP_ENV: "test", LOG_LEVEL: "silent", PUBLIC_ORIGIN: origin });
  const app = await buildApp(config);
  await app.ready();

  const suffix = randomUUID();
  const userId = randomUUID();
  const sourceOnlyUserId = randomUUID();
  const factorId = randomUUID();
  const sessionId = randomUUID();
  const targetEmployerId = randomUUID();
  const sourceEmployerId = randomUUID();
  const rejectedEmployerId = randomUUID();
  const approvalEmployerId = randomUUID();
  const orphanEmployerId = randomUUID();
  const unusedEmployerId = randomUUID();
  const mergedChildEmployerId = randomUUID();
  const conflictEmployerId = randomUUID();
  const duplicateAEmployerId = randomUUID();
  const duplicateBEmployerId = randomUUID();
  const duplicateCEmployerId = randomUUID();
  const targetEmploymentId = randomUUID();
  const sourceEmploymentId = randomUUID();
  const movedEmploymentId = randomUUID();
  const sourceOnlyEmploymentId = randomUUID();
  const rejectedEmploymentId = randomUUID();
  const batchId = randomUUID();
  const itemId = randomUUID();
  const uploadId = randomUUID();
  const documentId = randomUUID();
  const extractionId = randomUUID();
  const provenanceExtractionId = randomUUID();
  const failedProvenanceExtractionId = randomUUID();
  const provenanceFieldId = randomUUID();
  const provenanceCorrectionId = randomUUID();
  const settlementId = randomUUID();
  context.after(async () => {
    try {
      await pool.query("DELETE FROM import_batches WHERE id = $1", [batchId]);
      await pool.query("DELETE FROM users WHERE id = $1", [sourceOnlyUserId]);
      await pool.query("DELETE FROM employments WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM employers WHERE id = ANY($1::uuid[])", [[
        sourceEmployerId, targetEmployerId, rejectedEmployerId, approvalEmployerId, orphanEmployerId,
        unusedEmployerId, mergedChildEmployerId, conflictEmployerId, duplicateAEmployerId,
        duplicateBEmployerId, duplicateCEmployerId,
      ]]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    } finally {
      await app.close();
      await pool.end();
    }
  });
  const sessionToken = opaqueToken();
  const cookie = `${sessionCookieName(config.appEnv)}=${sessionToken}`;
  const reason = { reasonCode: "OPERATIONAL_RECOVERY", reference: `TEST-${suffix}` };
  const firstCuit = "30-71234567-1";
  const correctedCuit = "30-54321098-2";
  const conflictingCuit = "33-67890123-2";
  const adminEmail = `admin-employers-${suffix}@example.test`;
  const rawOcrSentinel = `OCR-PRIVADO-${suffix}`;
  const sourceRegionSentinel = `REGION-PRIVADA-${suffix}`;
  const extractorSentinel = `EXTRACTOR-PRIVADO-${suffix}`;
  const salarySentinel = "9876543.21";

  await pool.query(
    `INSERT INTO users (
       id, email, password_hash, status, role, admin_role,
       email_verified_at, onboarding_completed_at, last_login_at
     ) VALUES ($1, $2, NULL, 'ACTIVE', 'ADMIN', 'READ_ONLY', now(), now(), now())`,
    [userId, adminEmail],
  );
  await pool.query(
    `INSERT INTO users (
       id, email, password_hash, status, onboarding_completed_at, last_login_at
     ) VALUES ($1, $2, NULL, 'ACTIVE', now(), now())`,
    [sourceOnlyUserId, `favorite-source-only-${suffix}@example.test`],
  );
  await pool.query(
    `INSERT INTO auth_accounts (id, user_id, provider, provider_account_id)
     VALUES ($1, $2, 'GOOGLE', $3)`,
    [randomUUID(), userId, `admin-employers-${suffix}`],
  );
  const acknowledgements = await pool.query(
    `INSERT INTO legal_acknowledgements (user_id, document_version_id)
     SELECT $1, version.id
       FROM (
         SELECT DISTINCT ON (document_type) id, document_type
           FROM legal_document_versions
          WHERE document_type IN ('TERMS', 'PRIVACY_NOTICE')
            AND locale = 'es-AR' AND published_at <= now() AND effective_at <= now()
          ORDER BY document_type, effective_at DESC, published_at DESC
       ) AS version`,
    [userId],
  );
  assert.equal(acknowledgements.rowCount, 2);
  await pool.query(
    `INSERT INTO sessions (
       id, user_id, token_hash, expires_at, mfa_verified_at, step_up_expires_at
     ) VALUES ($1, $2, $3, now() + interval '1 hour', now(), NULL)`,
    [sessionId, userId, tokenHash(sessionToken)],
  );
  await pool.query(
    `INSERT INTO mfa_factors (
       id, user_id, status, encrypted_secret, key_version, enabled_at
     ) VALUES ($1, $2, 'ACTIVE', $3, 1, now())`,
    [factorId, userId, "synthetic-encrypted-mfa-secret-0001"],
  );
  await pool.query(
    `INSERT INTO employers (id, created_by_user_id, name, country_code, status, created_source)
     VALUES
       ($1, $11, 'Empresa Sintética Canonical SA', 'AR', 'PENDING', 'ADMIN'),
       ($2, $11, 'Empresa Sintética Duplicada SA', 'AR', 'PENDING', 'DOCUMENT'),
       ($3, $11, 'Detección Sintética Inválida', 'AR', 'PENDING', 'DOCUMENT'),
       ($4, $11, 'Empresa Pendiente Para Aprobar', 'AR', 'PENDING', 'DOCUMENT'),
       ($5, $11, 'Destino Histórico Sintético', 'AR', 'PENDING', 'DOCUMENT'),
       ($6, $11, 'Detección Huérfana Inválida', 'AR', 'PENDING', 'DOCUMENT'),
       ($7, $11, 'Empresa En Conflicto', 'AR', 'PENDING', 'DOCUMENT'),
       ($8, $11, 'Empresa Triple Homónima', 'AR', 'PENDING', 'DOCUMENT'),
       ($9, $11, 'Empresa Triple Homónima', 'AR', 'PENDING', 'DOCUMENT'),
       ($10, $11, 'Empresa Triple Homónima', 'AR', 'PENDING', 'DOCUMENT')`,
    [
      targetEmployerId, sourceEmployerId, rejectedEmployerId, approvalEmployerId,
      orphanEmployerId, unusedEmployerId, conflictEmployerId, duplicateAEmployerId,
      duplicateBEmployerId, duplicateCEmployerId, userId,
    ],
  );
  await pool.query(
    `INSERT INTO employers (
       id, created_by_user_id, name, country_code, status, created_source, merged_into_employer_id
     ) VALUES ($1, $2, 'Referencia Histórica Sintética', 'AR', 'MERGED', 'ADMIN', $3)`,
    [mergedChildEmployerId, userId, orphanEmployerId],
  );
  await pool.query(
    `INSERT INTO employer_aliases (id, employer_id, alias, created_source, created_by_user_id)
     VALUES
       ($1, $4, 'Empresa Compartida', 'ADMIN', $6),
       ($2, $5, 'EMPRESA COMPARTIDA', 'DOCUMENT', $6),
       ($3, $5, 'Empresa Duplicada Corta', 'DOCUMENT', $6)`,
    [randomUUID(), randomUUID(), randomUUID(), targetEmployerId, sourceEmployerId, userId],
  );
  const identifierFingerprint = createHash("sha256").update(`synthetic-${suffix}`).digest("hex");
  await pool.query(
    `INSERT INTO employer_identifiers (
       id, employer_id, country_code, identifier_type, identifier_ciphertext,
       identifier_fingerprint, identifier_key_version, masked_suffix, created_source, created_by_user_id
     ) VALUES ($1, $2, 'AR', 'CUIT', $3, $4, 'test-v1', '7890', 'ADMIN', $5)`,
    [randomUUID(), sourceEmployerId, Buffer.from("synthetic-encrypted-identifier"), identifierFingerprint, userId],
  );
  await pool.query(
    `INSERT INTO employer_identifiers (
       id, employer_id, country_code, identifier_type, identifier_ciphertext,
       identifier_key_version, created_source, created_by_user_id
     ) VALUES ($1, $2, 'AR', 'CUIT', $3, 'legacy-v1', 'LEGACY', $4)`,
    [randomUUID(), orphanEmployerId, Buffer.from("synthetic-legacy-encrypted-identifier"), userId],
  );
  await pool.query(
    `INSERT INTO employments (
       id, user_id, employer_id, status, start_date, role, category, modality, country_code, currency_code
     ) VALUES
       ($1, $4, $5, 'ACTIVE', '2024-01-01', 'Analista', 'STAFF', 'REMOTE', 'AR', 'ARS'),
       ($2, $4, $6, 'ACTIVE', '2024-01-01', 'Analista', 'STAFF', 'REMOTE', 'AR', 'ARS'),
       ($3, $4, $7, 'ACTIVE', '2025-01-01', 'Tester', 'STAFF', 'REMOTE', 'AR', 'ARS')`,
    [targetEmploymentId, sourceEmploymentId, rejectedEmploymentId, userId, targetEmployerId, sourceEmployerId, rejectedEmployerId],
  );
  await pool.query(
    `INSERT INTO employments (
       id, user_id, employer_id, status, start_date, role, category, modality, country_code, currency_code
     ) VALUES ($1, $2, $3, 'ACTIVE', '2023-01-01', 'Especialista', 'STAFF', 'REMOTE', 'AR', 'ARS')`,
    [movedEmploymentId, userId, sourceEmployerId],
  );
  await pool.query(
    `INSERT INTO employments (
       id, user_id, employer_id, status, start_date, role, country_code, currency_code
     ) VALUES ($1, $2, $3, 'ACTIVE', '2022-01-01', 'Operador', 'AR', 'ARS')`,
    [sourceOnlyEmploymentId, sourceOnlyUserId, sourceEmployerId],
  );
  await pool.query(
    `INSERT INTO import_batches (id, user_id, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4)`,
    [batchId, userId, `admin-employer-${suffix}`, "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO import_batch_items (
       id, user_id, batch_id, employment_id, client_item_key, ordinal,
       original_filename, declared_mime_type, expected_size_bytes, status
     ) VALUES ($1, $2, $3, $4, 'synthetic-item', 0, 'synthetic.pdf', 'application/pdf', 128, 'COMPLETED')`,
    [itemId, userId, batchId, sourceEmploymentId],
  );
  await pool.query(
    `INSERT INTO upload_sessions (
       id, user_id, batch_id, item_id, object_key, expected_size_bytes,
       expected_mime_type, status, expires_at, confirmed_at
     ) VALUES ($1, $2, $3, $4, $5, 128, 'application/pdf', 'CONFIRMED', now() + interval '1 hour', now())`,
    [uploadId, userId, batchId, itemId, `tests/${suffix}/synthetic.pdf`],
  );
  await pool.query(
    `INSERT INTO documents (
       id, user_id, import_batch_id, import_batch_item_id, upload_session_id,
       employment_id, detected_employer_id, object_key, original_filename,
       declared_mime_type, detected_mime_type, size_bytes, page_count,
       security_status, classification_status, document_type, classification_confidence,
       processing_status, retention_policy, processed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'synthetic.pdf',
       'application/pdf', 'application/pdf', 128, 1, 'CLEAN', 'SUPPORTED',
       'PAYROLL', 1, 'COMPLETED', 'KEEP_ORIGINAL', now()
     )`,
    [documentId, userId, batchId, itemId, uploadId, sourceEmploymentId, sourceEmployerId, `tests/${suffix}/canonical.pdf`],
  );
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at
     ) VALUES ($1, $2, $3, 1, 'COMPLETED', 'synthetic', '1', '1', '1', now())`,
    [extractionId, userId, documentId],
  );
  await pool.query(
    "UPDATE documents SET active_extraction_run_id = $1 WHERE id = $2",
    [extractionId, documentId],
  );
  await pool.query(
    `INSERT INTO payroll_settlements (
       id, user_id, document_id, extraction_run_id, employment_id,
       settlement_ordinal, payroll_period, settlement_type, is_recurring, currency_code
     ) VALUES ($1, $2, $3, $4, $5, 1, '2026-01-01', 'NORMAL', true, 'ARS')`,
    [settlementId, userId, documentId, extractionId, sourceEmploymentId],
  );

  const deniedByCapability = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${rejectedEmployerId}/reject`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(deniedByCapability.statusCode, 403, deniedByCapability.body);
  assert.equal(deniedByCapability.json().error.code, "ADMIN_PERMISSION_REQUIRED");
  assert.equal((await pool.query("SELECT status FROM employers WHERE id = $1", [rejectedEmployerId])).rows[0].status, "PENDING");
  const deniedCuitByCapability = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: firstCuit },
  });
  assert.equal(deniedCuitByCapability.statusCode, 403, deniedCuitByCapability.body);
  assert.equal(deniedCuitByCapability.json().error.code, "ADMIN_PERMISSION_REQUIRED");

  await pool.query("UPDATE users SET admin_role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1", [userId]);
  const deniedWithoutStepUp = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${rejectedEmployerId}/reject`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(deniedWithoutStepUp.statusCode, 403, deniedWithoutStepUp.body);
  assert.equal(deniedWithoutStepUp.json().error.code, "STEP_UP_REQUIRED");
  const deniedCuitWithoutStepUp = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: firstCuit },
  });
  assert.equal(deniedCuitWithoutStepUp.statusCode, 403, deniedCuitWithoutStepUp.body);
  assert.equal(deniedCuitWithoutStepUp.json().error.code, "STEP_UP_REQUIRED");

  await pool.query("UPDATE sessions SET step_up_expires_at = now() + interval '10 minutes' WHERE id = $1", [sessionId]);
  const invalidCuit = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: "30-71234567-2" },
  });
  assert.equal(invalidCuit.statusCode, 400, invalidCuit.body);
  assert.equal(invalidCuit.json().error.code, "INVALID_CUIT");
  const addedCuit = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: firstCuit },
  });
  assert.equal(addedCuit.statusCode, 200, addedCuit.body);
  assert.equal(addedCuit.json().data.maskedValue, "***5671");
  assert.equal(addedCuit.body.includes(firstCuit), false);
  const approved = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/approve`,
    headers: { origin, cookie }, payload: { ...reason, name: "Empresa Sintética Aprobada SA" },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().data.status, "VERIFIED");
  assert.equal(approved.json().data.normalizedName, "empresa sintética aprobada sa");
  const correctedIdentifier = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: correctedCuit },
  });
  assert.equal(correctedIdentifier.statusCode, 200, correctedIdentifier.body);
  assert.equal(correctedIdentifier.json().data.id, addedCuit.json().data.id);
  assert.equal(correctedIdentifier.json().data.maskedValue, "***0982");
  assert.equal(correctedIdentifier.body.includes(correctedCuit), false);
  const protectedCuit = await pool.query(
    `SELECT identifier_ciphertext, identifier_fingerprint, identifier_key_version, masked_suffix
       FROM employer_identifiers
      WHERE employer_id = $1 AND country_code = 'AR' AND identifier_type = 'CUIT'`,
    [approvalEmployerId],
  );
  assert.equal(protectedCuit.rowCount, 1);
  assert.equal(Buffer.from(protectedCuit.rows[0].identifier_ciphertext).includes(Buffer.from("30543210982")), false);
  assert.match(String(protectedCuit.rows[0].identifier_fingerprint), /^[0-9a-f]{64}$/);
  assert.equal(protectedCuit.rows[0].identifier_key_version, "1");
  assert.equal(protectedCuit.rows[0].masked_suffix, "0982");
  const duplicateCuit = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${targetEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: correctedCuit },
  });
  assert.equal(duplicateCuit.statusCode, 409, duplicateCuit.body);
  assert.equal(duplicateCuit.json().error.code, "EMPLOYER_IDENTIFIER_CONFLICT");
  const otherCuit = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${conflictEmployerId}/identifiers/cuit`,
    headers: { origin, cookie }, payload: { ...reason, cuit: conflictingCuit },
  });
  assert.equal(otherCuit.statusCode, 200, otherCuit.body);
  const conflictingIdentifierMerge = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${conflictEmployerId}/merge`,
    headers: { origin, cookie }, payload: { ...reason, targetEmployerId: approvalEmployerId },
  });
  assert.equal(conflictingIdentifierMerge.statusCode, 409, conflictingIdentifierMerge.body);
  assert.equal(conflictingIdentifierMerge.json().error.code, "EMPLOYER_IDENTIFIER_CONFLICT");
  const legacyIdentifierMerge = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${orphanEmployerId}/merge`,
    headers: { origin, cookie }, payload: { ...reason, targetEmployerId },
  });
  assert.equal(legacyIdentifierMerge.statusCode, 409, legacyIdentifierMerge.body);
  assert.equal(legacyIdentifierMerge.json().error.code, "EMPLOYER_IDENTIFIER_REVIEW_REQUIRED");
  const protectedIdentifierSecrets = await pool.query(
    `SELECT identifier_fingerprint, encode(identifier_ciphertext, 'base64') AS ciphertext_base64
       FROM employer_identifiers
      WHERE employer_id = ANY($1::uuid[])`,
    [[approvalEmployerId, conflictEmployerId]],
  );
  const forbiddenIdentifierValues = [
    firstCuit, correctedCuit, conflictingCuit, "30712345671", "30543210982", "33678901232",
    ...protectedIdentifierSecrets.rows.flatMap((row) => [String(row.identifier_fingerprint), String(row.ciphertext_base64)]),
  ];
  const identifierHttpPayload = [
    deniedCuitByCapability, deniedCuitWithoutStepUp, invalidCuit, addedCuit, correctedIdentifier,
    duplicateCuit, otherCuit, conflictingIdentifierMerge, legacyIdentifierMerge,
  ].map((response) => response.body).join("\n");
  for (const forbidden of forbiddenIdentifierValues) assert.equal(identifierHttpPayload.includes(forbidden), false);
  const approvalDetail = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${approvalEmployerId}`, headers: { cookie },
  });
  assert.equal(approvalDetail.statusCode, 200, approvalDetail.body);
  assert.deepEqual(
    approvalDetail.json().data.identifiers.map((identifier: { maskedValue: string }) => identifier.maskedValue),
    ["***0982"],
  );
  for (const forbidden of forbiddenIdentifierValues) assert.equal(approvalDetail.body.includes(forbidden), false);
  const oversizedNormalizedAlias = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/aliases`,
    headers: { origin, cookie }, payload: { ...reason, alias: "ﬃ".repeat(100) },
  });
  assert.equal(oversizedNormalizedAlias.statusCode, 400, oversizedNormalizedAlias.body);
  assert.equal(oversizedNormalizedAlias.json().error.code, "VALIDATION_ERROR");
  const aliasAdded = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/aliases`,
    headers: { origin, cookie }, payload: { ...reason, alias: "Empresa Aprobada Alternativa" },
  });
  assert.equal(aliasAdded.statusCode, 200, aliasAdded.body);
  assert.equal(aliasAdded.json().data.normalizedAlias, "empresa aprobada alternativa");
  const renamed = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/rename`,
    headers: { origin, cookie }, payload: { ...reason, name: "Empresa Sintética Renombrada SA" },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().data.name, "Empresa Sintética Renombrada SA");
  assert.equal(renamed.json().data.normalizedName, "empresa sintética renombrada sa");
  const rejectedUnused = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${unusedEmployerId}/reject`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(rejectedUnused.statusCode, 200, rejectedUnused.body);
  assert.equal(rejectedUnused.json().data.status, "REJECTED");
  const rejectedMergeTarget = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${orphanEmployerId}/reject`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(rejectedMergeTarget.statusCode, 409, rejectedMergeTarget.body);
  assert.equal(rejectedMergeTarget.json().error.code, "EMPLOYER_IN_USE");
  assert.deepEqual(
    (await pool.query(
      `SELECT source.status AS source_status, source.merged_into_employer_id, target.status AS target_status
         FROM employers source JOIN employers target ON target.id = source.merged_into_employer_id
        WHERE source.id = $1`,
      [mergedChildEmployerId],
    )).rows,
    [{ source_status: "MERGED", merged_into_employer_id: orphanEmployerId, target_status: "PENDING" }],
  );
  const homonymousApproval = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${conflictEmployerId}/approve`,
    headers: { origin, cookie }, payload: { ...reason, name: "Empresa Sintética Renombrada SA" },
  });
  assert.equal(homonymousApproval.statusCode, 200, homonymousApproval.body);
  assert.equal(homonymousApproval.json().data.status, "VERIFIED");
  assert.equal(
    (await pool.query(
      "SELECT count(*)::integer AS count FROM employers WHERE country_code = 'AR' AND normalized_name = $1",
      ["empresa sintética renombrada sa"],
    )).rows[0].count,
    2,
  );
  const unsafeHomonymApproval = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${duplicateAEmployerId}/approve`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(unsafeHomonymApproval.statusCode, 409, unsafeHomonymApproval.body);
  assert.equal(unsafeHomonymApproval.json().error.code, "EMPLOYER_NAME_CONFLICT");
  const conflictingRename = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/rename`,
    headers: { origin, cookie }, payload: { ...reason, name: "Empresa Sintética Canonical SA" },
  });
  assert.equal(conflictingRename.statusCode, 409, conflictingRename.body);
  assert.equal(conflictingRename.json().error.code, "EMPLOYER_NAME_CONFLICT");
  const conflictingAlias = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${approvalEmployerId}/aliases`,
    headers: { origin, cookie }, payload: { ...reason, alias: "Empresa Sintética Canonical SA" },
  });
  assert.equal(conflictingAlias.statusCode, 409, conflictingAlias.body);
  assert.equal(conflictingAlias.json().error.code, "EMPLOYER_NAME_CONFLICT");
  const aliasCandidateDetail = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${targetEmployerId}`, headers: { cookie },
  });
  assert.equal(aliasCandidateDetail.statusCode, 200, aliasCandidateDetail.body);
  assert.deepEqual(aliasCandidateDetail.json().data.possibleMatches, [{
    id: sourceEmployerId,
    name: "Empresa Sintética Duplicada SA",
    status: "PENDING",
    matchReason: "EXACT_NORMALIZED_ALIAS",
    employmentCount: 3,
    userCount: 2,
    documentCount: 1,
  }]);
  assert.equal(aliasCandidateDetail.body.includes(identifierFingerprint), false);
  assert.equal(aliasCandidateDetail.body.includes("synthetic-encrypted-identifier"), false);
  const sourceOriginWithoutField = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${sourceEmployerId}`, headers: { cookie },
  });
  assert.equal(sourceOriginWithoutField.statusCode, 200, sourceOriginWithoutField.body);
  assert.equal(sourceOriginWithoutField.json().data.employer.normalizedName, "empresa sintética duplicada sa");
  assert.equal(sourceOriginWithoutField.json().data.detectionOrigins.length, 1);
  assert.deepEqual(
    {
      ...sourceOriginWithoutField.json().data.detectionOrigins[0],
      detectedAt: typeof sourceOriginWithoutField.json().data.detectionOrigins[0].detectedAt,
    },
    {
      documentId, importBatchId: batchId, employerName: null, confidence: null,
      source: null, detectedAt: "string",
    },
  );
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, ocr_provider, ocr_version,
       finished_at, confidence
     ) VALUES
       ($1, $3, $4, 2, 'COMPLETED', $5, '2', '2', '2', 'synthetic-private-ocr', '1', now(), 0.8123),
       ($2, $3, $4, 3, 'FAILED', 'failed-private-extractor', '3', '3', '3', NULL, NULL, now(), NULL)`,
    [provenanceExtractionId, failedProvenanceExtractionId, userId, documentId, extractorSentinel],
  );
  await pool.query(
    "UPDATE documents SET active_extraction_run_id = $1 WHERE id = $2",
    [provenanceExtractionId, documentId],
  );
  await pool.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, page_number, source_region,
       extractor_version, signals
     ) VALUES (
       $1, $2, $3, $4, 'employer.name', 'EMPLOYER', $5, $6::jsonb,
       0.8123, 'OCR', 1, $7::jsonb, '2', $8::jsonb
     )`,
    [
      provenanceFieldId, userId, documentId, provenanceExtractionId, rawOcrSentinel,
      JSON.stringify("Empresa Detectada Sintética SA"),
      JSON.stringify({ privateRegion: sourceRegionSentinel }),
      JSON.stringify({ privateSignal: sourceRegionSentinel }),
    ],
  );
  await pool.query("UPDATE payroll_settlements SET gross_amount = $2 WHERE id = $1", [settlementId, salarySentinel]);
  const sourceDetectedOrigin = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${sourceEmployerId}`, headers: { cookie },
  });
  assert.equal(sourceDetectedOrigin.statusCode, 200, sourceDetectedOrigin.body);
  assert.deepEqual(sourceDetectedOrigin.json().data.detectionOrigins, [{
    documentId,
    importBatchId: batchId,
    employerName: "Empresa Detectada Sintética SA",
    confidence: 0.8123,
    source: "OCR",
    detectedAt: sourceDetectedOrigin.json().data.detectionOrigins[0].detectedAt,
  }]);
  assert.equal(typeof sourceDetectedOrigin.json().data.detectionOrigins[0].detectedAt, "string");
  await pool.query(
    `INSERT INTO user_corrections (
       id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
       correction_version, extracted_value, corrected_value
     ) VALUES ($1, $2, $3, $4, $5, 'employer.name', 1, $6::jsonb, $7::jsonb)`,
    [
      provenanceCorrectionId, userId, provenanceFieldId, documentId, provenanceExtractionId,
      JSON.stringify("Empresa Detectada Sintética SA"), JSON.stringify("Empresa Corregida Sintética SA"),
    ],
  );
  const sourceCorrectedOrigin = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${sourceEmployerId}`, headers: { cookie },
  });
  assert.equal(sourceCorrectedOrigin.statusCode, 200, sourceCorrectedOrigin.body);
  assert.deepEqual(sourceCorrectedOrigin.json().data.detectionOrigins, [{
    documentId,
    importBatchId: batchId,
    employerName: "Empresa Corregida Sintética SA",
    confidence: null,
    source: "HUMAN_CORRECTION",
    detectedAt: sourceCorrectedOrigin.json().data.detectionOrigins[0].detectedAt,
  }]);
  for (const forbidden of [userId, adminEmail, rawOcrSentinel, sourceRegionSentinel, extractorSentinel, salarySentinel, "synthetic.pdf"]) {
    assert.equal(sourceCorrectedOrigin.body.includes(forbidden), false);
  }
  const canonicalCandidateDetail = await app.inject({
    method: "GET", url: `/api/v1/admin/employers/${duplicateAEmployerId}`, headers: { cookie },
  });
  assert.equal(canonicalCandidateDetail.statusCode, 200, canonicalCandidateDetail.body);
  assert.deepEqual(
    canonicalCandidateDetail.json().data.possibleMatches.map((match: { id: string; matchReason: string }) => ({
      id: match.id,
      matchReason: match.matchReason,
    })),
    [duplicateBEmployerId, duplicateCEmployerId]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, matchReason: "EXACT_NORMALIZED_NAME" })),
  );
  const mergedAIntoB = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${duplicateAEmployerId}/merge`,
    headers: { origin, cookie }, payload: { ...reason, targetEmployerId: duplicateBEmployerId },
  });
  assert.equal(mergedAIntoB.statusCode, 200, mergedAIntoB.body);
  assert.equal(mergedAIntoB.json().data.mergedIntoEmployerId, duplicateBEmployerId);
  const mergedBIntoC = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${duplicateBEmployerId}/merge`,
    headers: { origin, cookie }, payload: { ...reason, targetEmployerId: duplicateCEmployerId },
  });
  assert.equal(mergedBIntoC.statusCode, 200, mergedBIntoC.body);
  assert.equal(mergedBIntoC.json().data.mergedIntoEmployerId, duplicateCEmployerId);
  const resolvedDuplicate = await withTransaction((client) => followMergedEmployer(client, duplicateAEmployerId));
  assert.equal(resolvedDuplicate?.id, duplicateCEmployerId);
  assert.deepEqual(
    (await pool.query(
      `SELECT id, status, merged_into_employer_id
         FROM employers WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[duplicateAEmployerId, duplicateBEmployerId, duplicateCEmployerId]],
    )).rows,
    [
      { id: duplicateAEmployerId, status: "MERGED", merged_into_employer_id: duplicateBEmployerId },
      { id: duplicateBEmployerId, status: "MERGED", merged_into_employer_id: duplicateCEmployerId },
      { id: duplicateCEmployerId, status: "PENDING", merged_into_employer_id: null },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  const rejected = await app.inject({
    method: "POST", url: `/api/v1/admin/employers/${rejectedEmployerId}/reject`,
    headers: { origin, cookie }, payload: reason,
  });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error.code, "EMPLOYER_IN_USE");
  assert.deepEqual(
    (await pool.query(
      `SELECT employer.status, employment.employer_id
         FROM employers employer
         JOIN employments employment ON employment.employer_id = employer.id
        WHERE employer.id = $1`,
      [rejectedEmployerId],
    )).rows,
    [{ status: "PENDING", employer_id: rejectedEmployerId }],
  );

  await pool.query(
    `INSERT INTO user_favorite_employers (user_id, employer_id)
     VALUES ($1, $3), ($1, $4), ($2, $3)`,
    [userId, sourceOnlyUserId, sourceEmployerId, targetEmployerId],
  );

  const [concurrentResolution, merged] = await Promise.all([
    withTransaction(async (client) => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '4s'");
      return resolveEmployer(client, {
        name: "Empresa Sintética Duplicada SA", countryCode: "AR", createdByUserId: userId, createdSource: "DOCUMENT",
        identifier: {
          countryCode: "AR", type: "CUIT", fingerprint: identifierFingerprint,
          ciphertext: Buffer.from("synthetic-encrypted-identifier"), keyVersion: "test-v1", maskedSuffix: "7890",
        },
      });
    }),
    app.inject({
      method: "POST", url: `/api/v1/admin/employers/${sourceEmployerId}/merge`,
      headers: { origin, cookie }, payload: { ...reason, targetEmployerId },
    }),
  ]);
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(merged.json().data.status, "MERGED");
  assert.equal(merged.json().data.mergedIntoEmployerId, targetEmployerId);
  assert.equal(merged.json().data.movedEmploymentCount, 2);
  assert.equal(merged.json().data.consolidatedEmploymentCount, 1);
  assert.equal(merged.json().data.relinkedImportItemCount, 1);
  assert.equal(merged.json().data.relinkedDocumentCount, 1);
  assert.equal(merged.json().data.relinkedSettlementCount, 1);
  assert.equal(merged.json().data.movedDetectedDocumentCount, 1);
  const finalResolution = await withTransaction((client) => followMergedEmployer(client, concurrentResolution.id));
  assert.equal(finalResolution?.id, targetEmployerId);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT employment_id FROM import_batch_items WHERE id = $1) AS item_employment_id,
         (SELECT employment_id FROM documents WHERE id = $2) AS document_employment_id,
         (SELECT detected_employer_id FROM documents WHERE id = $2) AS detected_employer_id,
         (SELECT employment_id FROM payroll_settlements WHERE id = $3) AS settlement_employment_id,
         (SELECT user_id FROM documents WHERE id = $2) AS document_user_id`,
      [itemId, documentId, settlementId],
    )).rows[0],
    {
      item_employment_id: targetEmploymentId,
      document_employment_id: targetEmploymentId,
      detected_employer_id: targetEmployerId,
      settlement_employment_id: targetEmploymentId,
      document_user_id: userId,
    },
  );
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM employments WHERE id = $1", [sourceEmploymentId])).rows[0].count, 0);
  assert.equal(
    (await pool.query("SELECT employer_id FROM employments WHERE id = $1", [movedEmploymentId])).rows[0].employer_id,
    targetEmployerId,
  );
  assert.deepEqual(
    (await pool.query("SELECT status, merged_into_employer_id FROM employers WHERE id = $1", [sourceEmployerId])).rows,
    [{ status: "MERGED", merged_into_employer_id: targetEmployerId }],
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT user_id, employer_id FROM user_favorite_employers
        WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
      [[userId, sourceOnlyUserId]],
    )).rows,
    [
      { user_id: sourceOnlyUserId, employer_id: targetEmployerId },
      { user_id: userId, employer_id: targetEmployerId },
    ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
  );
  const mergeAudit = await pool.query(
    `SELECT result, reason_code, reference, metadata_no_sensitive
       FROM admin_audit_events
      WHERE actor_user_id = $1 AND resource_id = $2 AND action = 'EMPLOYER_MERGED'`,
    [userId, sourceEmployerId],
  );
  assert.equal(mergeAudit.rowCount, 1);
  assert.equal(mergeAudit.rows[0].result, "SUCCESS");
  assert.equal(mergeAudit.rows[0].reason_code, reason.reasonCode);
  assert.equal(mergeAudit.rows[0].reference, reason.reference);
  const auditMetadata = JSON.stringify(mergeAudit.rows[0].metadata_no_sensitive);
  for (const forbidden of [identifierFingerprint, "synthetic-encrypted-identifier", "salary", "ocr"]) {
    assert.equal(auditMetadata.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  const duplicateMergeAudits = await pool.query(
    `SELECT resource_id, result, metadata_no_sensitive
       FROM admin_audit_events
      WHERE actor_user_id = $1 AND resource_id = ANY($2::uuid[])
        AND action = 'EMPLOYER_MERGED' ORDER BY resource_id`,
    [userId, [duplicateAEmployerId, duplicateBEmployerId]],
  );
  assert.equal(duplicateMergeAudits.rowCount, 2);
  assert.deepEqual(duplicateMergeAudits.rows.map((row) => row.result), ["SUCCESS", "SUCCESS"]);
  assert.equal(JSON.stringify(duplicateMergeAudits.rows).includes(identifierFingerprint), false);
  for (const [action, resourceId] of [
    ["EMPLOYER_APPROVED", approvalEmployerId],
    ["EMPLOYER_ALIAS_ADDED", approvalEmployerId],
    ["EMPLOYER_RENAMED", approvalEmployerId],
    ["EMPLOYER_REJECTED", unusedEmployerId],
  ] as const) {
    const event = await pool.query(
      `SELECT result, metadata_no_sensitive
         FROM admin_audit_events
        WHERE actor_user_id = $1 AND resource_id = $2 AND action = $3 AND result = 'SUCCESS'`,
      [userId, resourceId, action],
    );
    assert.equal(event.rowCount, 1);
    assert.equal(event.rows[0].result, "SUCCESS");
    const metadata = JSON.stringify(event.rows[0].metadata_no_sensitive).toLowerCase();
    for (const forbidden of [identifierFingerprint, "salary", "ocr"]) assert.equal(metadata.includes(forbidden), false);
  }
  const identifierAudits = await pool.query(
    `SELECT result, metadata_no_sensitive
       FROM admin_audit_events
      WHERE actor_user_id = $1 AND action = 'EMPLOYER_IDENTIFIER_SET'
      ORDER BY created_at, id`,
    [userId],
  );
  assert.equal(identifierAudits.rows.filter((event) => event.result === "SUCCESS").length, 3);
  const identifierAuditPayload = JSON.stringify(identifierAudits.rows);
  for (const forbidden of forbiddenIdentifierValues) assert.equal(identifierAuditPayload.includes(forbidden), false);
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count
         FROM admin_audit_events
        WHERE actor_user_id = $1 AND resource_id = $2
          AND action = 'EMPLOYER_REJECTED' AND result = 'DENIED'`,
      [userId, rejectedEmployerId],
    )).rows[0].count,
    3,
  );

  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/employers/${targetEmployerId}`, headers: { cookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().data.identifiers.map((identifier: { maskedValue: string }) => identifier.maskedValue), ["***7890"]);
  assert.equal(detail.body.includes(identifierFingerprint), false);
  assert.equal(detail.body.includes("synthetic-encrypted-identifier"), false);
  assert.equal(new Set(detail.json().data.aliases.map((alias: { normalizedAlias: string }) => alias.normalizedAlias)).size,
    detail.json().data.aliases.length);
  assert.deepEqual(detail.json().data.possibleMatches, []);

  const list = await app.inject({
    method: "GET", url: `/api/v1/admin/employers?search=${targetEmployerId}&status=PENDING`, headers: { cookie },
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data.items[0].employmentCount, 3);
  assert.equal(list.json().data.items[0].userCount, 2);
  assert.equal(list.json().data.items[0].documentCount, 1);
  const aliasSearch = await app.inject({
    method: "GET", url: "/api/v1/admin/employers?search=empresa%20duplicada%20corta", headers: { cookie },
  });
  assert.equal(aliasSearch.statusCode, 200, aliasSearch.body);
  assert.deepEqual(aliasSearch.json().data.items.map((employer: { id: string }) => employer.id), [targetEmployerId]);
  const wildcardSearch = await app.inject({
    method: "GET", url: "/api/v1/admin/employers?search=%25", headers: { cookie },
  });
  assert.equal(wildcardSearch.statusCode, 200, wildcardSearch.body);
  assert.deepEqual(wildcardSearch.json().data.items, []);

});
