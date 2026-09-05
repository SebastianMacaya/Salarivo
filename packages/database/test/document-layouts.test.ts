import assert from "node:assert/strict";
import test from "node:test";
import { findApprovedDocumentLayout, hasNewDocumentLayoutSql, validateLayoutAliases } from "../src/document-layouts.ts";

test("reviewed layout labels accept only bounded literal configuration", () => {
  const aliases = { "settlement.basicAmount": ["Haber garantizado", "Asignación fija"], "settlement.payrollPeriod": ["Mes liquidado"] };
  assert.deepEqual(validateLayoutAliases(aliases), aliases);
  assert.deepEqual(validateLayoutAliases({}, false), {});
  for (const invalid of [
    null, [], {}, { "employer.name": ["Nombre"] },
    { "settlement.basicAmount": ["Haber.*"] }, { "settlement.basicAmount": ["Haber\\s"] },
    { "settlement.basicAmount": ["12345678900"] }, { "settlement.basicAmount": ["https://example.test"] },
    { "settlement.basicAmount": ["Haber\nsecreto"] }, { "settlement.basicAmount": ["Haber <script>"] },
    { "settlement.basicAmount": ["Sueldo 1000"] }, { "settlement.basicAmount": [" x "] },
    { "settlement.basicAmount": ["a".repeat(61)] }, { "settlement.basicAmount": ["Uno", "Dos", "Tres", "Cuatro", "Cinco"] },
    { "settlement.basicAmount": ["Básico"], "settlement.netAmount": ["BASICO:"] },
    JSON.parse('{"__proto__":["Haber"]}') as unknown,
  ]) assert.equal(validateLayoutAliases(invalid), null, JSON.stringify(invalid));
  assert.throws(() => hasNewDocumentLayoutSql("run); DROP TABLE users; --"), /INVALID_SQL_ALIAS/);
});

test('layout lookup scopes country, document type and parser version before reuse', async () => {
  let queries = 0;
  const client = { query: async (sql: string, values: unknown[]) => {
    queries++;
    assert.match(sql, /layout.country_code = \$4 AND layout.document_type = \$5 AND layout.parser_version = \$6/);
    assert.deepEqual(values.slice(3), ['AR', 'PAYROLL', '8']);
    return { rows: [{ id: 'version', layout_id: 'layout', version: 1, enabled: true,
      aliases: { 'settlement.basicAmount': ['Asignación fija'] } }] };
  } } as unknown as Parameters<typeof findApprovedDocumentLayout>[0];
  const input = { employerName: 'Empresa Sintética', fingerprint: 'a'.repeat(64) };
  assert.equal(await findApprovedDocumentLayout(client, { ...input, countryCode: null }), null);
  assert.equal(await findApprovedDocumentLayout(client, { ...input, countryCode: 'US' }), null);
  assert.equal(queries, 0);
  const profile = await findApprovedDocumentLayout(client, { ...input, countryCode: 'AR' });
  assert.equal(profile?.countryCode, 'AR');
  assert.equal(profile?.documentType, 'PAYROLL');
  assert.equal(profile?.parserVersion, '8');
  assert.equal(queries, 1);
});
