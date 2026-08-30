import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "redis";

const origin = "http://localhost:3000";

function syntheticPayrollPdf(): Uint8Array<ArrayBuffer> {
  const lines = [
    "RECIBO DE SUELDO",
    "Empleador: Empresa Sintetica SA",
    "CUIL: 20-00000000-0",
    "Periodo de liquidacion: 08/2026",
    "Sueldo basico $ 1.234.567,89",
    "Presentismo $ 123.456,78",
    "Jubilacion $ 135.802,47",
    "Obra social $ 37.037,04",
    "Total bruto $ 1.358.024,67",
    "Total descuentos $ 172.839,51",
    "Neto a cobrar $ 1.185.185,16",
  ];
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const content = `BT\n/F1 11 Tf\n50 750 Td\n${escaped.map((line, index) => `${index ? "0 -18 Td\n" : ""}(${line}) Tj`).join("\n")}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("upload privado crea un único documento y un único intent durable", async (context) => {
  const [{ buildApp }, { loadConfig }, { pool }] = await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("@salarivo/database"),
  ]);
  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    PUBLIC_ORIGIN: origin,
  });
  const app = await buildApp(config, { provisionStorage: true });
  const redis = createClient({ url: process.env.QUEUE_URL ?? "redis://127.0.0.1:6379" });
  await redis.connect();
  context.after(async () => {
    await app.close();
    await redis.quit();
    await pool.end();
  });
  await app.ready();

  async function register(email: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin },
      payload: {
        displayName: "Persona Sintética",
        email,
        password: "frase local segura 2026",
        acceptedTerms: true,
        acknowledgedPrivacy: true,
        termsVersion: "1.0",
        privacyVersion: "1.0",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const cookie = response.headers["set-cookie"];
    assert.ok(cookie);
    return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";", 1)[0]!;
  }

  const suffix = crypto.randomUUID();
  const publicTerms = await app.inject({ method: "GET", url: "/api/v1/legal/terms" });
  assert.equal(publicTerms.statusCode, 200, publicTerms.body);
  assert.equal(publicTerms.json().data.version, "1.0");
  const historicalTerms = await app.inject({ method: "GET", url: "/api/v1/legal/terms?version=1.0" });
  assert.equal(historicalTerms.statusCode, 200, historicalTerms.body);
  await assert.rejects(
    () => pool.query("UPDATE legal_document_versions SET title = title WHERE document_type = 'TERMS' AND version = '1.0'"),
    /append-only/,
  );
  const productionApp = await buildApp({ ...config, appEnv: "production" }, { provisionStorage: false });
  await productionApp.ready();
  const blockedProductionRegistration = await productionApp.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin },
    payload: {
      email: `production-${suffix}@example.test`,
      password: "frase local segura 2026",
      acceptedTerms: true,
      acknowledgedPrivacy: true,
      termsVersion: "1.0",
      privacyVersion: "1.0",
    },
  });
  assert.equal(blockedProductionRegistration.statusCode, 503, blockedProductionRegistration.body);
  assert.equal(blockedProductionRegistration.json().error.code, "LEGAL_REVIEW_REQUIRED");
  await productionApp.close();
  const missingLegalAcceptance = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin },
    payload: { email: `missing-${suffix}@example.test`, password: "frase local segura 2026" },
  });
  assert.equal(missingLegalAcceptance.statusCode, 400, missingLegalAcceptance.body);
  const attemptedRoleEscalation = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin },
    payload: {
      email: `role-${suffix}@example.test`,
      password: "frase local segura 2026",
      acceptedTerms: true,
      acknowledgedPrivacy: true,
      termsVersion: "1.0",
      privacyVersion: "1.0",
      role: "ADMIN",
    },
  });
  assert.equal(attemptedRoleEscalation.statusCode, 400, attemptedRoleEscalation.body);
  const staleLegalVersion = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin },
    payload: {
      email: `stale-${suffix}@example.test`,
      password: "frase local segura 2026",
      acceptedTerms: true,
      acknowledgedPrivacy: true,
      termsVersion: "0.9",
      privacyVersion: "1.0",
    },
  });
  assert.equal(staleLegalVersion.statusCode, 409, staleLegalVersion.body);
  const cookieA = await register(`a-${suffix}@example.test`);
  const cookieB = await register(`b-${suffix}@example.test`);
  const meA = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieA } });
  assert.equal(meA.statusCode, 200, meA.body);
  assert.equal(meA.json().data.role, "USER");
  const userIdA = String(meA.json().data.id);
  const legalAcknowledgements = await pool.query(
    `SELECT version.document_type, version.version, acknowledgement.accepted_at
       FROM legal_acknowledgements acknowledgement
       JOIN legal_document_versions version ON version.id = acknowledgement.document_version_id
      WHERE acknowledgement.user_id = $1
      ORDER BY version.document_type`,
    [userIdA],
  );
  assert.deepEqual(
    legalAcknowledgements.rows.map((row) => [row.document_type, row.version]),
    [["PRIVACY_NOTICE", "1.0"], ["TERMS", "1.0"]],
  );
  assert.ok(legalAcknowledgements.rows.every((row) => row.accepted_at instanceof Date));
  const deniedAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieB } });
  assert.equal(deniedAdmin.statusCode, 403, deniedAdmin.body);
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = now() WHERE id = $1", [userIdA]);
  const adminOverview = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieA } });
  assert.equal(adminOverview.statusCode, 200, adminOverview.body);
  assert.equal(adminOverview.headers["cache-control"], "no-store");
  assert.ok(adminOverview.json().data.metrics.activeUsers >= 2);
  assert.deepEqual(
    Object.keys(adminOverview.json().data.metrics).sort(),
    ["activeImports", "activeUsers", "failedDocuments", "pendingReview", "totalDocuments", "totalUsers"].sort(),
  );
  for (const forbidden of ["password_hash", "original_filename", "gross_amount", "net_amount", "object_key"]) {
    assert.equal(adminOverview.body.includes(forbidden), false);
  }
  await pool.query("UPDATE users SET role = 'USER', updated_at = now() WHERE id = $1", [userIdA]);
  const revokedAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieA } });
  assert.equal(revokedAdmin.statusCode, 403, revokedAdmin.body);
  async function createEmployment(cookie: string, employerName: string) {
    const employer = await app.inject({
      method: "POST",
      url: "/api/v1/employers",
      headers: { origin, cookie },
      payload: { name: employerName, countryCode: "AR" },
    });
    assert.equal(employer.statusCode, 201, employer.body);
    const employment = await app.inject({
      method: "POST",
      url: "/api/v1/employments",
      headers: { origin, cookie },
      payload: {
        employerId: employer.json().data.id,
        startDate: "2026-01-01",
        countryCode: "AR",
        currencyCode: "ARS",
      },
    });
    assert.equal(employment.statusCode, 201, employment.body);
    return String(employment.json().data.id);
  }
  const employmentA = await createEmployment(cookieA, "Empresa Asociada A");
  const employmentB = await createEmployment(cookieB, "Empresa Ajena B");
  const itemKey = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const pdfBytes = syntheticPayrollPdf();
  const item = {
    clientItemKey: itemKey,
    originalFilename: "recibo-sintetico.pdf",
    declaredMimeType: "application/pdf",
    expectedSizeBytes: pdfBytes.byteLength,
  };
  const batch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [item] },
  });
  assert.equal(batch.statusCode, 201, batch.body);
  const batchData = batch.json().data as { id: string; items: Array<{ id: string }> };

  const activeBatch = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } });
  assert.equal(activeBatch.statusCode, 200, activeBatch.body);
  assert.equal(activeBatch.json().data.id, batchData.id);
  assert.deepEqual(activeBatch.json().data.progress, { total: 1, resolved: 0, percentage: 0 });
  const isolatedActiveBatch = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieB } });
  assert.equal(isolatedActiveBatch.json().data, null);

  const secondActiveBatch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID() }] },
  });
  assert.equal(secondActiveBatch.statusCode, 409, secondActiveBatch.body);

  const oversizedBatch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: Array.from({ length: 26 }, (_, index) => ({
      ...item,
      clientItemKey: crypto.randomUUID(),
      originalFilename: `recibo-grande-${index}.pdf`,
      expectedSizeBytes: 20 * 1024 * 1024,
    })) },
  });
  assert.equal(oversizedBatch.statusCode, 413, oversizedBatch.body);

  const foreignEmploymentAtImport = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), employmentId: employmentA }] },
  });
  assert.equal(foreignEmploymentAtImport.statusCode, 404, foreignEmploymentAtImport.body);

  const associatedAtImport = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), employmentId: employmentB }] },
  });
  assert.equal(associatedAtImport.statusCode, 201, associatedAtImport.body);
  assert.equal(associatedAtImport.json().data.items[0].employmentId, employmentB);
  const cancelledUploadSession = await app.inject({
    method: "POST",
    url: "/api/v1/upload-sessions",
    headers: { origin, cookie: cookieB },
    payload: { itemId: associatedAtImport.json().data.items[0].id },
  });
  assert.equal(cancelledUploadSession.statusCode, 201, cancelledUploadSession.body);
  const cancelledBatch = await app.inject({
    method: "POST",
    url: `/api/v1/imports/${associatedAtImport.json().data.id}/cancel`,
    headers: { origin, cookie: cookieB },
    payload: {},
  });
  assert.equal(cancelledBatch.statusCode, 200, cancelledBatch.body);
  assert.equal(cancelledBatch.json().data.status, "CANCELLED");
  assert.equal(cancelledBatch.json().data.items[0].status, "CANCELLED");
  assert.ok(
    ["EXPIRED", "CANCELLED"].includes(
      (await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [cancelledUploadSession.json().data.id])).rows[0].status,
    ),
  );

  const repeated = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [item] },
  });
  assert.equal(repeated.statusCode, 201, repeated.body);
  assert.equal(repeated.json().data.id, batchData.id);

  const reused = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [{ ...item, originalFilename: "otro.pdf" }] },
  });
  assert.equal(reused.statusCode, 409, reused.body);

  const sessionResponse = await app.inject({
    method: "POST",
    url: "/api/v1/upload-sessions",
    headers: { origin, cookie: cookieA },
    payload: { itemId: batchData.items[0]!.id },
  });
  assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
  const session = sessionResponse.json().data as {
    id: string;
    url: string;
    fields: Record<string, string>;
  };

  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/upload-sessions/${session.id}/complete`,
    headers: { origin, cookie: cookieB },
    payload: {},
  });
  assert.equal(denied.statusCode, 404, denied.body);

  const pdf = new Blob([pdfBytes], { type: "application/pdf" });
  assert.equal(pdf.size, item.expectedSizeBytes);
  const form = new FormData();
  for (const [name, value] of Object.entries(session.fields)) form.append(name, value);
  form.append("file", pdf, "recibo-sintetico.pdf");
  const upload = await fetch(session.url, { method: "POST", body: form });
  assert.equal(upload.status, 204, await upload.text());

  const complete = () => app.inject({
    method: "POST",
    url: `/api/v1/upload-sessions/${session.id}/complete`,
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  const confirmations = await Promise.all([complete(), complete()]);
  assert.deepEqual(confirmations.map((response) => response.statusCode), [200, 200]);
  assert.equal(confirmations[0]!.json().data.id, confirmations[1]!.json().data.id);
  const uploadReference = await pool.query(
    "SELECT object_key FROM upload_sessions WHERE id = $1",
    [session.id],
  );
  assert.match(String(uploadReference.rows[0].object_key), /^incoming\/[0-9a-f-]+\.pdf$/);

  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM documents WHERE import_batch_id = $1) AS documents,
       (SELECT count(*)::integer FROM processing_jobs job
          JOIN documents document ON document.id = job.document_id
         WHERE document.import_batch_id = $1 AND job.stage = 'SECURITY_VALIDATION') AS jobs,
       (SELECT min(job.state) FROM processing_jobs job
          JOIN documents document ON document.id = job.document_id
         WHERE document.import_batch_id = $1) AS job_state`,
    [batchData.id],
  );
  assert.deepEqual(counts.rows[0], { documents: 1, jobs: 1, job_state: "PENDING" });
  assert.equal(await redis.lLen("salarivo:processing-jobs:documents"), 0);

  const documentId = confirmations[0]!.json().data.id as string;
  const processingAssociation = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentA },
  });
  assert.equal(processingAssociation.statusCode, 409, processingAssociation.body);
  await pool.query(
    `UPDATE processing_jobs
        SET state = 'COMPLETED', completed_at = now()
      WHERE document_id = $1 AND stage = 'SECURITY_VALIDATION'`,
    [documentId],
  );
  await pool.query(
    `UPDATE documents
        SET processing_status = 'NEEDS_TYPE_CONFIRMATION', classification_status = 'NEEDS_CONFIRMATION'
      WHERE id = $1`,
    [documentId],
  );
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  await pool.query(
    "UPDATE import_batches SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
    [batchData.id],
  );
  const activeBlocker = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), originalFilename: "otro-recibo.pdf" }] },
  });
  assert.equal(activeBlocker.statusCode, 201, activeBlocker.body);
  const blockedTypeConfirmation = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/type-confirmation`,
    headers: { origin, cookie: cookieA },
    payload: { documentType: "PAYROLL" },
  });
  assert.equal(blockedTypeConfirmation.statusCode, 409, blockedTypeConfirmation.body);
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/api/v1/imports/${activeBlocker.json().data.id}/cancel`,
      headers: { origin, cookie: cookieA },
      payload: {},
    })).statusCode,
    200,
  );
  const typeConfirmation = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/type-confirmation`,
    headers: { origin, cookie: cookieA },
    payload: { documentType: "PAYROLL" },
  });
  assert.equal(typeConfirmation.statusCode, 201, typeConfirmation.body);
  const resumed = await pool.query(
    `SELECT stage, processing_version, state FROM processing_jobs
      WHERE document_id = $1 ORDER BY processing_version DESC LIMIT 1`,
    [documentId],
  );
  assert.deepEqual(resumed.rows[0], { stage: "TEXT_EXTRACTION", processing_version: 2, state: "PENDING" });
  assert.deepEqual(
    (await pool.query(
      `SELECT batch.status AS batch_status, item.status AS item_status
         FROM import_batches batch JOIN import_batch_items item ON item.batch_id = batch.id
        WHERE batch.id = $1 AND item.id = $2`,
      [batchData.id, batchData.items[0]!.id],
    )).rows[0],
    { batch_status: "ACTIVE", item_status: "PROCESSING" },
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } })).json().data.id,
    batchData.id,
  );

  const owner = await pool.query("SELECT user_id FROM documents WHERE id = $1", [documentId]);
  const userId = String(owner.rows[0].user_id);
  const runId = crypto.randomUUID();
  const settlementId = crypto.randomUUID();
  const deductionsFieldId = crypto.randomUUID();
  await pool.query(
    `UPDATE processing_jobs SET state = 'COMPLETED', completed_at = now() WHERE document_id = $1 AND processing_version = 2`,
    [documentId],
  );
  await pool.query(
    `UPDATE documents SET processing_status = 'COMPLETED', classification_status = 'SUPPORTED',
            document_type = 'PAYROLL', processed_at = now() WHERE id = $1`,
    [documentId],
  );
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at, confidence
     ) VALUES ($1, $2, $3, 2, 'COMPLETED', 'synthetic-test', '3', '3', '3', now(), 0.9)`,
    [runId, userId, documentId],
  );
  await pool.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version
     ) VALUES
       ($1, $2, $3, $4, 'employer.name', 'EMPLOYER', 'Empresa Sintética SA', $5::jsonb, 0.9, 'PDF_TEXT', '3'),
       ($6, $2, $3, $4, 'settlement.payrollPeriod', 'PAYROLL_SETTLEMENT', '08/2026', $7::jsonb, 0.9, 'PDF_TEXT', '3'),
       ($8, $2, $3, $4, 'settlement.deductionsAmount', 'PAYROLL_SETTLEMENT', '180.00', $9::jsonb, 0.9, 'RULE', '3')`,
    [
      crypto.randomUUID(), userId, documentId, runId, JSON.stringify("Empresa Sintética SA"),
      crypto.randomUUID(), JSON.stringify("2026-08"), deductionsFieldId,
      JSON.stringify({ amount: "180.00", currencyCode: "ARS" }),
    ],
  );
  await pool.query(
    `INSERT INTO payroll_settlements (
       id, user_id, document_id, extraction_run_id, settlement_ordinal,
       payroll_period, settlement_type, is_recurring, currency_code,
       gross_amount, net_amount, deductions_amount
     ) VALUES ($1, $2, $3, $4, 1, '2026-08-01', 'NORMAL', true, 'ARS', 1000.00, 820.00, 180.00)`,
    [settlementId, userId, documentId, runId],
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description,
       normalized_concept_code, amount, currency_code, item_type, confidence
     ) VALUES
       ($1, $2, $3, 1, 'Jubilación sintética', 'RETIREMENT', 110.00, 'ARS', 'DEDUCTION', 0.9),
       ($4, $2, $3, 2, 'Ingresos personales sintético', 'INCOME_TAX', 50.00, 'ARS', 'DEDUCTION', 0.9),
       ($5, $2, $3, 3, 'Seguro sintético', NULL, 20.00, 'ARS', 'DEDUCTION', 0.8)`,
    [crypto.randomUUID(), userId, settlementId, crypto.randomUUID(), crypto.randomUUID()],
  );

  await pool.query("UPDATE documents SET processing_status = 'NEEDS_REVIEW' WHERE id = $1", [documentId]);
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  const reviewDetail = await app.inject({ method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA } });
  assert.equal(reviewDetail.statusCode, 200, reviewDetail.body);
  const reviewFields = reviewDetail.json().data.extractedFields as Array<{ id: string | null; fieldPath: string; source: string }>;
  assert.deepEqual(
    reviewFields.filter(({ source }) => source === "MANUAL_REQUIRED").map(({ fieldPath }) => fieldPath).sort(),
    ["settlement.grossAmount", "settlement.netAmount"],
  );
  for (const [fieldPath, correctedValue] of [["settlement.grossAmount", "1000.00"], ["settlement.netAmount", "820.00"]]) {
    const manualCorrection = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/corrections`,
      headers: { origin, cookie: cookieA },
      payload: { fieldPath, correctedValue },
    });
    assert.equal(manualCorrection.statusCode, 201, manualCorrection.body);
  }
  const completedReview = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(completedReview.statusCode, 200, completedReview.body);
  assert.equal(completedReview.json().data.processingStatus, "COMPLETED");
  const completedBatch = await app.inject({ method: "GET", url: `/api/v1/imports/${batchData.id}`, headers: { cookie: cookieA } });
  assert.deepEqual(completedBatch.json().data.progress, { total: 1, resolved: 1, percentage: 100 });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } })).json().data, null);

  const documentsView = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie: cookieA } });
  assert.equal(documentsView.statusCode, 200, documentsView.body);
  assert.equal(documentsView.json().data[0].displayFilename, "2026-08 - Empresa Sintética SA.pdf");
  const settlementsView = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(settlementsView.statusCode, 200, settlementsView.body);
  assert.equal(settlementsView.json().data[0].employerName, "Empresa Sintética SA");
  assert.equal(settlementsView.json().data[0].deductionsPercentage, "18.00");
  assert.equal(settlementsView.json().data[0].deductionsMatchTotal, true);
  assert.equal(settlementsView.json().data[0].deductionsDifferenceKind, "MATCHED");
  assert.deepEqual(
    settlementsView.json().data[0].deductions.map((deduction: { amount: string; grossPercentage: string }) => [deduction.amount, deduction.grossPercentage]),
    [["110.00", "11.00"], ["50.00", "5.00"], ["20.00", "2.00"]],
  );

  const foreignEmployment = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentB },
  });
  assert.equal(foreignEmployment.statusCode, 404, foreignEmployment.body);
  const partialBatch = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId, crypto.randomUUID()], employmentId: employmentA },
  });
  assert.equal(partialBatch.statusCode, 404, partialBatch.body);
  const unchangedAssociation = await pool.query(
    "SELECT employment_id FROM documents WHERE id = $1",
    [documentId],
  );
  assert.equal(unchangedAssociation.rows[0].employment_id, null);

  const association = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentA },
  });
  assert.equal(association.statusCode, 200, association.body);
  assert.equal(association.json().data.updatedCount, 1);
  const associatedDocuments = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie: cookieA } });
  assert.equal(associatedDocuments.json().data[0].employmentId, employmentA);
  assert.equal(associatedDocuments.json().data[0].displayFilename, "2026-08 - Empresa Asociada A.pdf");
  const associatedSettlements = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(associatedSettlements.json().data[0].employerName, "Empresa Asociada A");
  const persistedAssociation = await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
      WHERE document.id = $1`,
    [documentId],
  );
  assert.equal(String(persistedAssociation.rows[0].document_employment_id), employmentA);
  assert.equal(String(persistedAssociation.rows[0].settlement_employment_id), employmentA);

  const disassociation = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: null },
  });
  assert.equal(disassociation.statusCode, 200, disassociation.body);
  const clearedAssociation = await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
      WHERE document.id = $1`,
    [documentId],
  );
  assert.equal(clearedAssociation.rows[0].document_employment_id, null);
  assert.equal(clearedAssociation.rows[0].settlement_employment_id, null);

  const correction = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: deductionsFieldId, correctedValue: "200.00" },
  });
  assert.equal(correction.statusCode, 201, correction.body);
  assert.equal(
    (await pool.query("SELECT processing_status FROM documents WHERE id = $1", [documentId])).rows[0].processing_status,
    "NEEDS_REVIEW",
  );
  const correctedSettlements = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(correctedSettlements.json().data[0].deductionsAmount, "200.00");
  assert.equal(correctedSettlements.json().data[0].deductionsMatchTotal, false);
  assert.equal(correctedSettlements.json().data[0].deductionsDifferenceKind, "MISSING_ITEMS");
  assert.equal(correctedSettlements.json().data[0].deductionsDifferenceAmount, "20.00");
  assert.equal(correctedSettlements.json().data[0].deductions.length, 3);

  const manualRunId = crypto.randomUUID();
  const manualGrossFieldId = crypto.randomUUID();
  const manualNetFieldId = crypto.randomUUID();
  const manualDeductionsFieldId = crypto.randomUUID();
  const manualTypeFieldId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at, confidence
     ) VALUES ($1, $2, $3, 3, 'COMPLETED', 'synthetic-test', '3', '3', '3', now(), 0.7)`,
    [manualRunId, userId, documentId],
  );
  await pool.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version
     ) VALUES
       ($1, $2, $3, $4, 'settlement.grossAmount', 'PAYROLL_SETTLEMENT', '1000.00', $5::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($6, $2, $3, $4, 'settlement.netAmount', 'PAYROLL_SETTLEMENT', '820.00', $7::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($8, $2, $3, $4, 'settlement.deductionsAmount', 'PAYROLL_SETTLEMENT', '180.00', $9::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($10, $2, $3, $4, 'settlement.type', 'PAYROLL_SETTLEMENT', 'BONO', $11::jsonb, 0.8, 'RULE', '3')`,
    [
      manualGrossFieldId, userId, documentId, manualRunId, JSON.stringify({ amount: "1000.00", currencyCode: "ARS" }),
      manualNetFieldId, JSON.stringify({ amount: "820.00", currencyCode: "ARS" }),
      manualDeductionsFieldId, JSON.stringify({ amount: "180.00", currencyCode: "ARS" }),
      manualTypeFieldId, JSON.stringify("BONO"),
    ],
  );
  await pool.query("UPDATE documents SET processing_status = 'NEEDS_REVIEW' WHERE id = $1", [documentId]);
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  await pool.query("UPDATE import_batches SET status = 'ACTIVE', completed_at = NULL WHERE id = $1", [batchData.id]);

  const periodReview = await app.inject({ method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA } });
  const periodFields = periodReview.json().data.extractedFields as Array<{
    id: string | null; fieldPath: string; correctedValue: string | null; source: string;
  }>;
  assert.deepEqual(
    periodFields.filter(({ source }) => source === "MANUAL_REQUIRED").map(({ fieldPath }) => fieldPath).sort(),
    ["settlement.deductionsAmount", "settlement.grossAmount", "settlement.netAmount", "settlement.payrollPeriod"],
  );
  const amountBeforePeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualGrossFieldId, correctedValue: "1000.00" },
  });
  assert.equal(amountBeforePeriod.statusCode, 409, amountBeforePeriod.body);
  const manualPeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { fieldPath: "settlement.payrollPeriod", correctedValue: "2026-09" },
  });
  assert.equal(manualPeriod.statusCode, 201, manualPeriod.body);
  const missingTotalSettlement = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(missingTotalSettlement.json().data[0].deductionsMatchTotal, false);
  assert.equal(missingTotalSettlement.json().data[0].deductionsDifferenceKind, "TOTAL_MISSING");
  assert.equal(missingTotalSettlement.json().data[0].deductionsDifferenceAmount, null);
  assert.equal(missingTotalSettlement.json().data[0].settlementType, "BONO");
  for (const [extractedFieldId, correctedValue] of [
    [manualGrossFieldId, "1000.00"],
    [manualNetFieldId, "820.00"],
    [manualDeductionsFieldId, "180.00"],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/corrections`,
      headers: { origin, cookie: cookieA },
      payload: { extractedFieldId, correctedValue },
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  const unconfirmedMismatch = await app.inject({
    method: "POST", url: `/api/v1/documents/${documentId}/review-complete`, headers: { origin, cookie: cookieA }, payload: {},
  });
  assert.equal(unconfirmedMismatch.statusCode, 409, unconfirmedMismatch.body);
  const acceptedMismatch = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: { acceptDeductionsMismatch: true },
  });
  assert.equal(acceptedMismatch.statusCode, 200, acceptedMismatch.body);
  const completedManualDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.deepEqual(
    completedManualDetail.json().data.extractedFields.find((field: { fieldPath: string }) => field.fieldPath === "settlement.payrollPeriod"),
    {
      id: null,
      fieldPath: "settlement.payrollPeriod",
      interpretedValue: null,
      correctedValue: "2026-09",
      confidence: "0",
      source: "MANUAL_REQUIRED",
    },
  );
  const editCompletedManualPeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { fieldPath: "settlement.payrollPeriod", correctedValue: "2026-10" },
  });
  assert.equal(editCompletedManualPeriod.statusCode, 201, editCompletedManualPeriod.body);
  assert.equal(
    (await pool.query("SELECT processing_status FROM documents WHERE id = $1", [documentId])).rows[0].processing_status,
    "NEEDS_REVIEW",
  );
  assert.equal(
    (await pool.query("SELECT to_char(payroll_period, 'YYYY-MM') AS period FROM payroll_settlements WHERE extraction_run_id = $1", [manualRunId])).rows[0].period,
    "2026-10",
  );
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/review-complete`,
      headers: { origin, cookie: cookieA },
      payload: { acceptDeductionsMismatch: true },
    })).statusCode,
    200,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO user_corrections (
         id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
         correction_version, extracted_value, corrected_value
       ) VALUES ($1, $2, $3, $4, $5, 'settlement.netAmount', 99, '{}'::jsonb, '{}'::jsonb)`,
      [crypto.randomUUID(), userId, manualGrossFieldId, documentId, manualRunId],
    ),
    /foreign key constraint/,
  );

  const isolatedView = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieB } });
  assert.deepEqual(isolatedView.json().data, []);

  const firstExport = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/exports",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(firstExport.statusCode, 201, firstExport.body);
  const secondExport = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/exports",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(secondExport.statusCode, 200, secondExport.body);
  assert.equal(secondExport.json().data.id, firstExport.json().data.id);
  const exportId = String(firstExport.json().data.id);
  const download = () => app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}/download`,
    headers: { cookie: cookieA },
  });
  const downloads = await Promise.all([download(), download()]);
  assert.deepEqual(downloads.map((response) => response.statusCode).sort(), [200, 409]);

  const wrongPassword = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieB },
    payload: { confirmation: "ELIMINAR", password: "contraseña deliberadamente incorrecta" },
  });
  assert.equal(wrongPassword.statusCode, 401, wrongPassword.body);
  const deleteB = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieB },
    payload: { confirmation: "ELIMINAR", password: "frase local segura 2026" },
  });
  assert.equal(deleteB.statusCode, 202, deleteB.body);

  if (process.env.KEEP_INTEGRATION_DATA === "1") return;
  const deleteA = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieA },
    payload: { confirmation: "ELIMINAR", password: "frase local segura 2026" },
  });
  assert.equal(deleteA.statusCode, 202, deleteA.body);
});
