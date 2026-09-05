import assert from "node:assert/strict";
import test from "node:test";
import { hasNewDocumentLayoutSql, validateLayoutAliases } from "../src/document-layouts.ts";

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
