import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

test("jurisdictions preserve legacy evidence, isolate owners and derive reproducible estimates", { timeout: 60_000 }, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: databaseUrl });
  const client = await admin.connect();
  const schema = `jurisdiction_test_${randomUUID().replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof import("../../src/app.ts")["buildApp"]>> | undefined;
  let database: typeof import("@salarivo/database") | undefined;
  try {
    assert.match(schema, /^jurisdiction_test_[a-f0-9]{32}$/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    const { loadMigrations } = await import(new URL("../../../../packages/database/src/migrations.ts", import.meta.url).href);
    const migrations = await loadMigrations();
    for (const migration of migrations.filter(({ version }: {version:number}) => version < 28)) {
      await client.query("BEGIN"); await client.query(migration.sql); await client.query("COMMIT");
    }
    const owner = randomUUID(), other = randomUUID(), employer = randomUUID(), legacy = randomUUID();
    await client.query(`INSERT INTO users(id,email,status) VALUES($1,$2,'ACTIVE'),($3,$4,'ACTIVE')`,
      [owner, `${owner}@example.test`, other, `${other}@example.test`]);
    await client.query(`INSERT INTO employers(id,name,country_code,created_by_user_id) VALUES($1,'Empresa Sintetica','AR',$2)`, [employer, owner]);
    await client.query(`INSERT INTO employments(id,user_id,employer_id,status,start_date,country_code,currency_code)
      VALUES($1,$2,$3,'ACTIVE','2019-07-01','AR','ARS')`, [legacy, owner, employer]);
    await client.query("BEGIN"); await client.query(migrations.find(({ version }: {version:number}) => version === 28)!.sql); await client.query("COMMIT");
    for (const migration of migrations.filter(({ version }: {version:number}) => version > 28)) {
      await client.query("BEGIN"); await client.query(migration.sql); await client.query("COMMIT");
    }
    const preserved = (await client.query("SELECT * FROM employments WHERE id=$1", [legacy])).rows[0];
    assert.equal(preserved.country_code, "AR"); assert.equal(preserved.country_source, "LEGACY");
    assert.equal(preserved.country_confirmed_at, null); assert.equal(preserved.status_confirmed_at, null);
    assert.equal(preserved.employment_type, "UNKNOWN");
    assert.equal((await client.query("SELECT primary_country_code FROM users WHERE id=$1", [owner])).rows[0].primary_country_code, null);
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    process.env.DATABASE_URL = isolatedUrl.href;
    database = await import("@salarivo/database");
    const [{ buildApp }, { loadConfig }, security] = await Promise.all([
      import("../../src/app.ts"), import("../../src/config.ts"), import("../../src/security.ts"),
    ]);
    app = await buildApp(loadConfig({ ...process.env, APP_ENV: "test", LOG_LEVEL: "silent" }), { provisionStorage: false });
    await app.ready();
    const cookies: string[] = [];
    for (const userId of [owner, other]) {
      await client.query(`INSERT INTO auth_accounts(id,user_id,provider,provider_account_id) VALUES($1,$2,'GOOGLE',$3)`, [randomUUID(), userId, userId]);
      await client.query(`INSERT INTO legal_acknowledgements(user_id,document_version_id)
        SELECT $1,id FROM (SELECT DISTINCT ON(document_type) id FROM legal_document_versions
          WHERE effective_at<=now() AND published_at<=now() ORDER BY document_type,effective_at DESC,published_at DESC) versions`, [userId]);
      const token = security.opaqueToken();
      await client.query(`INSERT INTO sessions(id,user_id,token_hash,expires_at,step_up_expires_at)
        VALUES($1,$2,$3,now()+interval '1 hour',now()+interval '10 minutes')`, [randomUUID(), userId, security.tokenHash(token)]);
      cookies.push(`${security.sessionCookieName("test")}=${token}`);
    }
    const headers = { cookie: cookies[0]!, origin: "http://localhost:3000" };
    const estimateUrl = `/api/v1/employments/${legacy}/termination-estimate`;
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers: { origin: headers.origin }, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers: { ...headers, cookie: cookies[1]! }, payload: {} })).statusCode, 404);
    const suggestion = await app.inject({ method: "GET", url: "/api/v1/profile/country?browserLocale=es-AR", headers });
    assert.deepEqual(suggestion.json().data.suggestion, { countryCode: "AR", source: "BROWSER_LOCALE", confidence: "MEDIUM" });
    assert.equal(suggestion.json().data.primaryCountryCode, null);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/profile/country", headers, payload: { primaryCountryCode: "ZZ" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/profile/country", headers, payload: { primaryCountryCode: "US" } })).statusCode, 200);
    assert.equal((await client.query("SELECT country_code FROM employments WHERE id=$1", [legacy])).rows[0].country_code, "AR");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers })).json().data.primaryCountryCode, "US");
    const confirmation = await app.inject({ method: "PATCH", url: `/api/v1/employments/${legacy}`, headers,
      payload: { countryCode: "AR", legalRegimeCode: "AR_LCT_GENERAL", status: "ACTIVE", employmentType: "DEPENDENT", startDate: "2019-07-01" } });
    assert.equal(confirmation.statusCode, 200, confirmation.body);
    assert.ok(confirmation.json().data.countryConfirmedAt); assert.ok(confirmation.json().data.statusConfirmedAt);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/employments/${legacy}`, headers, payload: { subdivisionCode: "US-CA" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/employments/${legacy}`, headers, payload: { status: "ENDED" } })).statusCode, 400);
    const base = { terminationDate: "2024-12-15", overrides: { monthlyRemuneration: "1000000.00" } };
    const first = await app.inject({ method: "POST", url: estimateUrl, headers, payload: base });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.status, "AVAILABLE");
    assert.equal(first.json().data.scenarios.length, 2);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.deepEqual((await app.inject({ method: "POST", url: estimateUrl, headers, payload: base })).json(), first.json());
    async function addSalary(country: string | null, period: string, amount: string, status = "COMPLETED", reviewReady = false) {
      const documentId = randomUUID(), runId = randomUUID(), settlementId = randomUUID();
      const batchId = randomUUID(), uploadId = randomUUID();
      await client.query(`INSERT INTO import_batches(id,user_id,idempotency_key,request_fingerprint)
        VALUES($1::uuid,$2,$1::text,$3)`, [batchId, owner, "a".repeat(64)]);
      await client.query(`INSERT INTO import_batch_items(id,user_id,batch_id,employment_id,client_item_key,ordinal,original_filename,declared_mime_type,expected_size_bytes)
        VALUES($1::uuid,$2,$3,$4,$1::text,0,'salary-synthetic.pdf','application/pdf',128)`, [documentId, owner, batchId, legacy]);
      await client.query(`INSERT INTO upload_sessions(id,user_id,batch_id,item_id,object_key,expected_size_bytes,expected_mime_type,expires_at)
        VALUES($1,$2,$3,$4,$5,128,'application/pdf',now()+interval '1 hour')`, [uploadId, owner, batchId, documentId, `synthetic/${documentId}`]);
      await client.query(`INSERT INTO documents(id,user_id,import_batch_id,import_batch_item_id,upload_session_id,employment_id,
        object_key,original_filename,declared_mime_type,size_bytes,security_status,classification_status,document_type,processing_status,
        retention_policy,country_code,country_source,country_confidence,country_snapshot_at)
        VALUES($1,$2,$3,$1,$4,$5,$6,'salary-synthetic.pdf','application/pdf',128,'CLEAN','SUPPORTED','PAYROLL',$7,
        'KEEP_ORIGINAL',$8,CASE WHEN $8::text IS NULL THEN NULL ELSE 'DOCUMENT_DETECTION' END,
        CASE WHEN $8::text IS NULL THEN NULL ELSE 'HIGH' END,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)`,
        [documentId, owner, batchId, uploadId, legacy, `synthetic/${documentId}`, status, country]);
      await client.query(`INSERT INTO extraction_runs(id,user_id,document_id,processing_version,status,extractor_name,extractor_version,
        parser_version,normalizer_version,pipeline_fingerprint,finished_at)
        VALUES($1,$2,$3,1,$4,'synthetic','7','8','6',$5,now())`,
        [runId, owner, documentId, reviewReady ? "REVIEW_REQUIRED" : "COMPLETED", database!.currentPipelineFingerprint]);
      await client.query("UPDATE documents SET active_extraction_run_id=$1 WHERE id=$2", [runId, documentId]);
      await client.query(`INSERT INTO payroll_settlements(id,user_id,document_id,extraction_run_id,employment_id,settlement_ordinal,
        payroll_period,issue_date,payment_date,settlement_type,is_recurring,currency_code,basic_amount,remunerative_amount,
        non_remunerative_amount,gross_amount,net_amount,deductions_amount)
        VALUES($1,$2,$3,$4,$5,1,$6,'2024-12-05','2024-12-20','NORMAL',true,'ARS',$7,$7,
          CASE WHEN $8::boolean THEN 0 ELSE NULL END,$7::numeric,CASE WHEN $8::boolean THEN $7::numeric ELSE 42::numeric END,
          CASE WHEN $8::boolean THEN 0 ELSE NULL END)`,
        [settlementId, owner, documentId, runId, legacy, `${period}-01`, amount, reviewReady]);
      await client.query(`INSERT INTO payroll_line_items(id,user_id,settlement_id,item_ordinal,raw_description,normalized_concept_code,amount,currency_code,item_type,is_recurring)
        VALUES($1,$2,$3,1,'Synthetic base','BASIC_SALARY',$4,'ARS','EARNING',true)`, [randomUUID(), owner, settlementId, amount]);
      if (reviewReady) {
        const money = JSON.stringify({ amount, currencyCode: "ARS" });
        await client.query(`INSERT INTO extracted_fields(id,user_id,document_id,extraction_run_id,field_path,entity_type,
          raw_value,interpreted_value,confidence,source,extractor_version) VALUES
          ($1,$2,$3,$4,'settlement.payrollPeriod','PAYROLL_SETTLEMENT',$5,$6::jsonb,1,'RULE','7'),
          ($7,$2,$3,$4,'settlement.grossAmount','PAYROLL_SETTLEMENT',$8,$9::jsonb,1,'RULE','7'),
          ($10,$2,$3,$4,'settlement.netAmount','PAYROLL_SETTLEMENT',$8,$9::jsonb,1,'RULE','7'),
          ($11,$2,$3,$4,'settlement.deductionsAmount','PAYROLL_SETTLEMENT','0.00',$12::jsonb,1,'RULE','7')`, [
          randomUUID(), owner, documentId, runId, period, JSON.stringify(period),
          randomUUID(), amount, money, randomUUID(), randomUUID(), JSON.stringify({ amount: "0.00", currencyCode: "ARS" }),
        ]);
      }
      return { documentId, runId };
    }
    const eligible = await addSalary("AR", "2024-11", "900000.00");
    await addSalary("US", "2024-11", "1900000.00");
    await addSalary("AR", "2024-11", "2900000.00", "NEEDS_REVIEW");
    await addSalary("AR", "2024-12", "3900000.00");
    const fromSalary = await app.inject({ method: "POST", url: estimateUrl, headers, payload: { terminationDate: "2024-12-15" } });
    assert.equal(fromSalary.statusCode, 200, fromSalary.body);
    assert.equal(fromSalary.json().data.salaryBase.amount, "900000.00");
    assert.deepEqual(fromSalary.json().data.salaryBase.analyzedDocumentIds, [eligible.documentId]);
    assert.equal(JSON.stringify(fromSalary.json()).includes('"netAmount"'), false);
    assert.equal(fromSalary.json().data.salaryBase.trace[0].sourceDescription, "Synthetic base");
    assert.ok(fromSalary.json().data.salaryBase.trace[0].lineItemId);
    assert.equal(JSON.stringify(fromSalary.json().data.inputs).includes("Synthetic base"), false);
    assert.equal(JSON.stringify(fromSalary.json().data.inputs).includes("sourceDescription"), false);
    const incorrectCountry = await addSalary("US", "2024-10", "100.00");
    const conflict = await app.inject({ method: "PATCH", url: "/api/v1/documents/employment", headers,
      payload: { employmentId: legacy, documentIds: [incorrectCountry.documentId] } });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, "COUNTRY_EMPLOYMENT_CONFLICT");
    const countryUrl = `/api/v1/documents/${incorrectCountry.documentId}/country`;
    const countryBody = { countryCode: "AR", extractionRunId: incorrectCountry.runId, expectedCountryCode: "US" };
    assert.equal((await app.inject({ method: "PATCH", url: countryUrl, headers: { ...headers, cookie: cookies[1]! }, payload: countryBody })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: countryUrl, headers, payload: { ...countryBody, expectedCountryCode: null } })).statusCode, 409);
    const countryConfirmed = await app.inject({ method: "PATCH", url: countryUrl, headers, payload: countryBody });
    assert.equal(countryConfirmed.statusCode, 200, countryConfirmed.body);
    assert.equal(countryConfirmed.json().data.countrySource, "USER_CONFIRMED");
    assert.equal((await client.query("SELECT country_code FROM extraction_runs WHERE id=$1", [incorrectCountry.runId])).rows[0].country_code, null);
    const countryHistory = (await client.query("SELECT extracted_value,corrected_value FROM user_corrections WHERE document_id=$1 AND field_path='document.countryCode'", [incorrectCountry.documentId])).rows;
    assert.deepEqual(countryHistory, [{ extracted_value: "US", corrected_value: "AR" }]);
    assert.equal((await app.inject({ method: "PATCH", url: countryUrl, headers, payload: countryBody })).statusCode, 409);
    await client.query("UPDATE employments SET country_source='LEGACY',country_confidence=NULL,country_confirmed_at=NULL WHERE id=$1", [legacy]);
    const inheritedReview = await addSalary(null, "2024-08", "800000.00", "NEEDS_REVIEW", true);
    const conflictingReview = await addSalary(null, "2024-07", "700000.00", "NEEDS_REVIEW", true);
    await client.query(`INSERT INTO extraction_run_issues(id,user_id,document_id,extraction_run_id,code,severity,recoverable) VALUES
      ($1,$2,$3,$4,'COUNTRY_UNCONFIRMED','ERROR',true),
      ($5,$2,$6,$7,'COUNTRY_UNCONFIRMED','ERROR',true),
      ($8,$2,$6,$7,'COUNTRY_EMPLOYMENT_CONFLICT','ERROR',false)`, [
      randomUUID(), owner, inheritedReview.documentId, inheritedReview.runId,
      randomUUID(), conflictingReview.documentId, conflictingReview.runId, randomUUID(),
    ]);
    const confirmedWithDocuments = await app.inject({
      method: "PATCH", url: `/api/v1/employments/${legacy}`, headers, payload: { countryCode: "AR" },
    });
    assert.equal(confirmedWithDocuments.statusCode, 200, confirmedWithDocuments.body);
    assert.deepEqual((await client.query(
      "SELECT country_code,country_source,country_confidence FROM documents WHERE id=$1",
      [inheritedReview.documentId],
    )).rows[0], { country_code: "AR", country_source: "EMPLOYMENT_CONFIRMED", country_confidence: "HIGH" });
    const inheritedDetail = await app.inject({ method: "GET", url: `/api/v1/documents/${inheritedReview.documentId}`, headers });
    assert.equal(inheritedDetail.statusCode, 200, inheritedDetail.body);
    assert.equal(inheritedDetail.json().data.analysis.issues.some(({ code }: { code: string }) => code === "COUNTRY_UNCONFIRMED"), false);
    assert.equal((await client.query(
      "SELECT count(*)::integer AS count FROM extraction_run_issues WHERE extraction_run_id=$1 AND code='COUNTRY_UNCONFIRMED'",
      [inheritedReview.runId],
    )).rows[0].count, 1, "the resolved issue remains as audit evidence");
    const completedInheritedReview = await app.inject({
      method: "POST", url: `/api/v1/documents/${inheritedReview.documentId}/review-complete`, headers,
      payload: { extractionRunId: inheritedReview.runId },
    });
    assert.equal(completedInheritedReview.statusCode, 200, completedInheritedReview.body);
    assert.equal((await client.query("SELECT status FROM extraction_runs WHERE id=$1", [inheritedReview.runId])).rows[0].status, "COMPLETED");
    const completedInheritedDetail = await app.inject({ method: "GET", url: `/api/v1/documents/${inheritedReview.documentId}`, headers });
    assert.equal(completedInheritedDetail.json().data.analysis.status, "COMPLETED");
    assert.deepEqual(completedInheritedDetail.json().data.analysis.issues, []);
    const blockedConflictReview = await app.inject({
      method: "POST", url: `/api/v1/documents/${conflictingReview.documentId}/review-complete`, headers,
      payload: { extractionRunId: conflictingReview.runId },
    });
    assert.equal(blockedConflictReview.statusCode, 409, blockedConflictReview.body);
    assert.equal(blockedConflictReview.json().error.code, "COUNTRY_REVIEW_REQUIRED");
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers, payload: { terminationDate: "2026-02-30" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers, payload: { overrides: { monthlyRemuneration: "-1" } } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers, payload: { overrides: { vacationDaysTaken: "367" } } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: estimateUrl, headers, payload: { terminationDate: "2018-01-01" } })).statusCode, 400);
    const usEmployment = await app.inject({ method: "POST", url: "/api/v1/employments", headers,
      payload: { employerId: employer, startDate: "2020-01-01", countryCode: "US", subdivisionCode: "US-CA", currencyCode: "USD", status: "ACTIVE", employmentType: "DEPENDENT" } });
    assert.equal(usEmployment.statusCode, 201, usEmployment.body);
    const otherSubdivision = await app.inject({ method: "POST", url: "/api/v1/employments", headers,
      payload: { employerId: employer, startDate: "2020-01-01", countryCode: "US", subdivisionCode: "US-NY", currencyCode: "USD", status: "ACTIVE", employmentType: "DEPENDENT" } });
    assert.equal(otherSubdivision.statusCode, 201, otherSubdivision.body);
    assert.notEqual(otherSubdivision.json().data.id, usEmployment.json().data.id);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/employments/${otherSubdivision.json().data.id}`, headers,
      payload: { subdivisionCode: "US-CA" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/employments", headers,
      payload: { employerId: employer, startDate: "2020-01-01", countryCode: "US", subdivisionCode: "US-CA", currencyCode: "USD", status: "UNKNOWN", employmentType: "DEPENDENT" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/employments/${usEmployment.json().data.id}/termination-estimate`, headers, payload: {} })).json().data.status, "UNSUPPORTED");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/termination-rules", headers })).json().data.rules.length >= 2, true);
    const audit = JSON.stringify((await client.query("SELECT metadata_no_sensitive FROM audit_events WHERE user_id=$1", [owner])).rows);
    assert.equal(audit.includes("1000000"), false);
  } finally {
    await client.query("ROLLBACK");
    await app?.close(); await database?.pool.end();
    process.env.DATABASE_URL = databaseUrl;
    assert.match(schema, /^jurisdiction_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release(); await admin.end();
  }
});
