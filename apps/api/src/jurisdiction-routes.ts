import { randomUUID } from "node:crypto";
import { lockEmployerMutation, pool, withTransaction, type PoolClient } from "@salarivo/database";
import { COUNTRIES, getCountry, suggestCountry } from "@salarivo/jurisdictions";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { calculateTerminationEstimate, TERMINATION_LEGAL_RULES, COLLECTIVE_AGREEMENT_VERSIONS, type TerminationEstimate, type TerminationOverrides, type TerminationSalarySettlement } from "./termination-calculator.ts";
import type { ApiConfig } from "./config.ts";

type Options = {
  config: ApiConfig;
  requireAuth(request: FastifyRequest): Promise<void>;
  ApiError: new (status: number, code: string, message: string) => Error;
};
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const money = { type: "string", pattern: "^(0|[1-9][0-9]{0,13})(\\.[0-9]{1,2})?$" };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const countryCode = { type: "string", enum: COUNTRIES.map(({ code }) => code) };
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const profileResponse = { type: "object", additionalProperties: false, properties: {
  data: { type: "object", additionalProperties: false, properties: {
    primaryCountryCode: nullableString, primaryCountryConfirmedAt: nullableString,
    suggestion: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: {
      countryCode, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] }, source: { type: "string" },
    } }] },
  } },
} };
const overridesSchema = { type: "object", additionalProperties: false, properties: {
  startDate: date, monthlyRemuneration: money,
  cctCode: { type: "string", minLength: 1, maxLength: 80 },
  cctCategory: { type: "string", minLength: 1, maxLength: 120 },
  probationWaived: { type: "boolean" }, employerEmployeeCount: { type: "integer", minimum: 1, maximum: 10_000_000 },
  vacationDaysTaken: money, priorVacationDays: money, pendingVacationDays: money, sacAlreadyPaid: money,
  deductionRatePercent: money, additionalWithholdings: money,
  cctCapVersion: { type: "object", additionalProperties: false,
    required: ["version", "cctCode", "effectiveFrom", "effectiveTo", "sourceUrl", "capAmount"], properties: {
      version: { type: "string", minLength: 1, maxLength: 80 },
      cctCode: { type: "string", minLength: 1, maxLength: 80 },
      category: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
      effectiveFrom: date, effectiveTo: date,
      sourceUrl: { type: "string", maxLength: 1000, pattern: "^https://" }, capAmount: money,
      probationMonths: { type: "integer", enum: [6, 8, 12] },
      noticeMonths: { type: "integer", minimum: 1, maximum: 12 },
      annualVacationDays: { type: "integer", minimum: 1, maximum: 366 },
      terminationSystem: { type: "string", enum: ["STANDARD", "CESSATION_FUND"] },
    } },
} };

function day(value: unknown): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null;
}

export async function registerJurisdictionRoutes(app: FastifyInstance, { requireAuth, ApiError, config }: Options) {
  app.get("/api/v1/termination-rules", { preHandler: requireAuth }, async () => ({
    data: { rules: TERMINATION_LEGAL_RULES, collectiveAgreements: COLLECTIVE_AGREEMENT_VERSIONS },
  }));
  app.patch<{ Params: { id: string }; Body: { countryCode: string; extractionRunId: string; expectedCountryCode: string | null } }>(
    "/api/v1/documents/:id/country", { preHandler: requireAuth, schema: {
      params: { type: "object", additionalProperties: false, required: ["id"], properties: { id: uuid } },
      body: { type: "object", additionalProperties: false, required: ["countryCode", "extractionRunId", "expectedCountryCode"],
        properties: { countryCode, extractionRunId: uuid, expectedCountryCode: { anyOf: [countryCode, { type: "null" }] } } },
    } }, async (request) => withTransaction(async (client) => {
      await lockEmployerMutation(client);
      const userId = request.authUser!.id;
      const document = await client.query(`SELECT country_code, active_extraction_run_id, employment_id, processing_status
        FROM documents WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, [request.params.id, userId]);
      if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = document.rows[0];
      if (row.active_extraction_run_id !== request.body.extractionRunId || row.country_code !== request.body.expectedCountryCode) {
        throw new ApiError(409, "STALE_EXTRACTION_RUN", "El documento cambió; recargalo antes de confirmar el país.");
      }
      const jobs = await client.query(`SELECT 1 FROM processing_jobs WHERE document_id=$1 AND user_id=$2
        AND (state IN ('PENDING','PUBLISHED','RUNNING','RETRYABLE') OR execution_owner IS NOT NULL) LIMIT 1`, [request.params.id, userId]);
      if (jobs.rowCount || !["COMPLETED", "NEEDS_REVIEW"].includes(row.processing_status)) {
        throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para confirmar el país.");
      }
      if (row.employment_id) {
        const employment = await client.query(`SELECT country_code FROM employments WHERE id=$1 AND user_id=$2
          AND country_confirmed_at IS NOT NULL`, [row.employment_id, userId]);
        if (employment.rowCount && employment.rows[0].country_code !== request.body.countryCode) {
          throw new ApiError(409, "COUNTRY_EMPLOYMENT_CONFLICT", "El país elegido difiere del empleo confirmado. Revisá primero la asociación laboral.");
        }
      }
      await client.query(`INSERT INTO user_corrections(id,user_id,document_id,extraction_run_id,field_path,
        correction_version,extracted_value,corrected_value)
        SELECT $1,$2,$3,$4,'document.countryCode',COALESCE(max(correction_version),0)+1,$5::jsonb,$6::jsonb
        FROM user_corrections WHERE user_id=$2 AND extraction_run_id=$4 AND field_path='document.countryCode'`,
        [randomUUID(), userId, request.params.id, request.body.extractionRunId, JSON.stringify(row.country_code), JSON.stringify(request.body.countryCode)]);
      const updated = await client.query(`UPDATE documents SET country_code=$3,country_source='USER_CONFIRMED',
        country_confidence='HIGH',country_snapshot_at=now() WHERE id=$1 AND user_id=$2 RETURNING country_snapshot_at`,
        [request.params.id, userId, request.body.countryCode]);
      await client.query(`INSERT INTO audit_events(id,user_id,actor_user_id,action,resource_type,resource_id,result,metadata_no_sensitive)
        VALUES($1,$2,$2,'DOCUMENT_COUNTRY_CONFIRMED','DOCUMENT',$3,'SUCCESS','{}'::jsonb)`, [randomUUID(), userId, request.params.id]);
      return { data: { countryCode: request.body.countryCode, countrySource: "USER_CONFIRMED", countryConfidence: "HIGH",
        countrySnapshotAt: updated.rows[0].country_snapshot_at } };
    }));
  app.get<{ Querystring: { browserLocale?: string; timezone?: string } }>("/api/v1/profile/country", {
    preHandler: requireAuth, schema: { querystring: { type: "object", additionalProperties: false, properties: {
      browserLocale: { type: "string", maxLength: 100 }, timezone: { type: "string", maxLength: 100 },
    } }, response: { 200: profileResponse } },
  }, async (request) => {
    const result = await pool.query(`SELECT primary_country_code, primary_country_confirmed_at, suggested_country_code,
      COALESCE((SELECT country_code FROM employments WHERE user_id = users.id AND country_confirmed_at IS NOT NULL
                ORDER BY start_date DESC, id LIMIT 1),
               (SELECT country_code FROM documents WHERE user_id = users.id AND deleted_at IS NULL AND country_code IS NOT NULL
                AND country_confidence = 'HIGH' AND security_status = 'CLEAN'
                ORDER BY country_snapshot_at DESC, id LIMIT 1)) AS evidence_country
      FROM users WHERE id = $1 AND status = 'ACTIVE'`, [request.authUser!.id]);
    const row = result.rows[0];
    if (!row) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
    return { data: { primaryCountryCode: row.primary_country_code, primaryCountryConfirmedAt: row.primary_country_confirmed_at,
      suggestion: suggestCountry({ confirmedCountryCode: row.primary_country_code, evidenceCountryCode: row.evidence_country,
        googleLocale: row.suggested_country_code ? `und-${row.suggested_country_code}` : null,
        browserLocale: request.query.browserLocale ?? null, timezone: request.query.timezone ?? null }) } };
  });
  app.patch<{ Body: { primaryCountryCode: string } }>("/api/v1/profile/country", {
    preHandler: requireAuth, schema: { body: { type: "object", additionalProperties: false,
      required: ["primaryCountryCode"], properties: { primaryCountryCode: countryCode } }, response: { 200: profileResponse } },
  }, async (request) => {
    const code = request.body.primaryCountryCode;
    if (!getCountry(code)) throw new ApiError(400, "VALIDATION_ERROR", "Seleccioná un país del catálogo.");
    const result = await pool.query(`UPDATE users SET primary_country_code = $2,
      primary_country_confirmed_at = now(), updated_at = now() WHERE id = $1 AND status = 'ACTIVE'
      RETURNING primary_country_code, primary_country_confirmed_at`, [request.authUser!.id, code]);
    if (!result.rowCount) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
    return { data: { primaryCountryCode: code, primaryCountryConfirmedAt: result.rows[0].primary_country_confirmed_at,
      suggestion: suggestCountry({ confirmedCountryCode: code }) } };
  });

  app.post<{ Params: { id: string }; Body: { terminationDate?: string; terminationType?: string; salaryMode?: "SIMPLE" | "DOCUMENTS"; overrides?: TerminationOverrides } }>(
    "/api/v1/employments/:id/termination-estimate", {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { params: { type: "object", required: ["id"], additionalProperties: false,
        properties: { id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } } },
      body: { type: "object", additionalProperties: false, properties: { terminationDate: date,
        terminationType: { type: "string", enum: ["DISMISSAL_WITHOUT_CAUSE"] },
        salaryMode: { type: "string", enum: ["SIMPLE", "DOCUMENTS"] }, overrides: overridesSchema } } },
    }, async (request) => {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const terminationDate = request.body.terminationDate ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(terminationDate) || !Number.isFinite(Date.parse(`${terminationDate}T00:00:00Z`))
          || new Date(`${terminationDate}T00:00:00Z`).toISOString().slice(0, 10) !== terminationDate) {
        throw new ApiError(400, "VALIDATION_ERROR", "La fecha de desvinculación no es válida.");
      }
      // Repeatable read keeps the employment, active runs and corrections in one coherent response snapshot.
      return withTransaction(async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const employment = await client.query(`SELECT employment.*, employer.name AS employer_name
          FROM employments employment JOIN employers employer ON employer.id = employment.employer_id
          WHERE employment.id = $1 AND employment.user_id = $2`, [request.params.id, request.authUser!.id]);
        if (!employment.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = employment.rows[0];
        const cutoff = terminationDate < today ? terminationDate : today;
        const result = await client.query(`SELECT settlement.id, settlement.document_id, settlement.employment_id,
            settlement.currency_code, to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
            settlement.settlement_type, settlement.is_recurring, settlement.basic_amount, settlement.gross_amount,
            settlement.remunerative_amount, settlement.non_remunerative_amount,
            COALESCE(settlement.issue_date, settlement.payment_date)::text AS known_on,
            COALESCE(earnings.items, '[]'::jsonb) AS earnings
          FROM documents document JOIN extraction_runs run
            ON run.id = document.active_extraction_run_id AND run.user_id = document.user_id AND run.document_id = document.id
          JOIN payroll_settlements settlement ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
          LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('code', COALESCE(item.normalized_concept_code, 'UNKNOWN'),
              'lineItemId', item.id, 'sourceDescription', item.raw_description,
              'sourceField', CASE WHEN item.source_field IN ('settlement.remunerativeAmount', 'settlement.nonRemunerativeAmount')
                THEN item.source_field ELSE NULL END,
              'amount', item.amount::text, 'isRecurring', item.is_recurring) ORDER BY item.item_ordinal) AS items
            FROM payroll_line_items item WHERE item.user_id = settlement.user_id AND item.settlement_id = settlement.id
              AND item.item_type = 'EARNING') earnings ON true
          WHERE document.user_id = $1 AND document.employment_id = $2 AND settlement.employment_id = $2
            AND document.deleted_at IS NULL AND document.security_status = 'CLEAN'
            AND document.document_type = 'PAYROLL' AND document.processing_status = 'COMPLETED'
            AND settlement.currency_code = $4
            AND (document.country_code IS NULL OR document.country_code = $6)
            AND settlement.payroll_period <= $3::date
            AND settlement.payroll_period >= date_trunc('month', $3::date) - interval '12 months'
            AND (COALESCE(settlement.issue_date, settlement.payment_date) IS NULL
                 OR COALESCE(settlement.issue_date, settlement.payment_date) <= $3::date)
          ORDER BY settlement.payroll_period DESC, settlement.id LIMIT $5`,
          [request.authUser!.id, request.params.id, cutoff, row.currency_code, config.maxTerminationSettlements + 1, row.country_code]);
        if (result.rows.length > config.maxTerminationSettlements) throw new ApiError(409, "ESTIMATE_DATA_LIMIT", "Hay demasiadas liquidaciones en el período; revisá duplicados antes de simular.");
        const settlements: TerminationSalarySettlement[] = result.rows.map((salary) => ({
          id: salary.id, documentId: salary.document_id, employmentId: salary.employment_id,
          currencyCode: salary.currency_code, payrollPeriod: salary.payroll_period, settlementType: salary.settlement_type,
          isRecurring: salary.is_recurring, basicAmount: salary.basic_amount, grossAmount: salary.gross_amount,
          remunerativeAmount: salary.remunerative_amount, nonRemunerativeAmount: salary.non_remunerative_amount,
          knownOn: day(salary.known_on), earnings: salary.earnings.map((item: { lineItemId: string; code: string; amount: string; isRecurring: boolean | null; sourceField: string | null }) => ({
            lineItemId: item.lineItemId, code: item.code, amount: item.amount, isRecurring: item.isRecurring, sourceField: item.sourceField,
          })),
        }));
        let estimate: TerminationEstimate;
        try { estimate = calculateTerminationEstimate({
          employment: { id: row.id, employerName: row.employer_name, countryCode: row.country_code,
            currencyCode: row.currency_code, subdivisionCode: row.subdivision_code, legalRegimeCode: row.legal_regime_code,
            countryConfirmedAt: row.country_confirmed_at?.toISOString() ?? null, startDate: day(row.start_date),
            startDateSource: row.start_date_confirmed_at ? "CONFIRMED" : "UNKNOWN" },
          today, terminationDate, settlements,
          ...(request.body.terminationType ? { terminationType: request.body.terminationType } : {}),
          ...(request.body.salaryMode ? { salaryMode: request.body.salaryMode } : {}),
          ...(request.body.overrides ? { overrides: request.body.overrides } : {}),
        }); } catch (error) {
          if (error instanceof TypeError && /^(INVALID_|TERMINATION_BEFORE_START)/.test(error.message)) {
            const messages: Record<string, string> = {
              INVALID_DEDUCTION_RATE: "El porcentaje de aportes debe estar entre 0 y 100.",
              INVALID_VACATION_DAYS: "Los días de vacaciones deben estar entre 0 y 366.",
              INVALID_VACATION_DAYS_COMBINATION: "Ingresá el total de vacaciones pendientes o los días gozados y saldos anteriores, sin combinar ambas opciones.",
              INVALID_ADDITIONAL_WITHHOLDINGS: "Las otras retenciones no pueden superar el total neto de ninguno de los escenarios.",
            };
            throw new ApiError(400, "VALIDATION_ERROR", messages[error.message] ?? "Revisá fechas, importes y vigencia del convenio de la simulación.");
          }
          throw error;
        }
        // Original labels identify source rows in the owner UI only; never enter calculation inputs.
        const sourceDescriptions = new Map<string, string>(result.rows.flatMap(salary => salary.earnings.map(
          (item: { lineItemId: string; sourceDescription: string }) => [item.lineItemId, item.sourceDescription] as const)));
        for (const entry of estimate.salaryBase.trace) {
          const description = entry.lineItemId ? sourceDescriptions.get(entry.lineItemId) : undefined;
          if (description) entry.sourceDescription = description;
        }
        if (row.employment_type !== "DEPENDENT") {
          estimate.status = "UNSUPPORTED"; estimate.scenarios = [];
          estimate.warnings.unshift("Confirmá que este empleo es una relación de dependencia para simular su desvinculación.");
        }
        if (!row.status_confirmed_at || row.status === "UNKNOWN") {
          estimate.confidence = "LOW";
          estimate.warnings.unshift("El estado laboral está pendiente de confirmación; un recibo no demuestra que el empleo siga activo.");
        }
        return { data: estimate };
      });
    });
}

export async function inheritDocumentCountries(client: PoolClient, userId: string, employmentId: string,
  documentIds: string[], ApiError: Options["ApiError"]): Promise<void> {
  const employment = await client.query(`SELECT country_code, country_confirmed_at FROM employments
    WHERE id = $1 AND user_id = $2 FOR SHARE`, [employmentId, userId]);
  if (!employment.rowCount) throw new ApiError(404, "NOT_FOUND", "Empleo no encontrado.");
  const row = employment.rows[0];
  if (!row.country_confirmed_at) return;
  const conflict = await client.query(`SELECT 1 FROM documents WHERE user_id = $1 AND id = ANY($2::uuid[])
    AND country_code IS NOT NULL AND country_code <> $3 LIMIT 1`, [userId, documentIds, row.country_code]);
  if (conflict.rowCount) throw new ApiError(409, "COUNTRY_EMPLOYMENT_CONFLICT", "El país histórico del documento difiere del empleo. Revisá la jurisdicción antes de asociarlo.");
  await client.query(`UPDATE documents SET country_code = $3, country_source = 'EMPLOYMENT_CONFIRMED',
    country_confidence = 'HIGH', country_snapshot_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND country_code IS NULL`,
    [userId, documentIds, row.country_code]);
}
