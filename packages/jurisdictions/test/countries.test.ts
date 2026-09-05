import assert from "node:assert/strict";
import test from "node:test";
import { COUNTRIES, countryName, getCountry, suggestCountry } from "../src/index.ts";

test("ISO catalog and suggestions never turn weak signals into confirmed jurisdiction", () => {
  assert.equal(COUNTRIES.length, 249);
  assert.equal(new Set(COUNTRIES.map(({ code }) => code)).size, 249);
  assert.equal(getCountry("ZZ"), undefined);
  assert.equal(countryName("AR"), "Argentina");
  assert.equal(suggestCountry({ confirmedCountryCode: "US", evidenceCountryCode: "AR" })?.countryCode, "US");
  assert.equal(suggestCountry({ evidenceCountryCode: "AR", googleLocale: "en-US" })?.source, "DOCUMENT");
  assert.deepEqual(suggestCountry({ googleLocale: "es_AR" }), { countryCode: "AR", source: "GOOGLE_LOCALE", confidence: "MEDIUM" });
  assert.equal(suggestCountry({ browserLocale: "es", timezone: "America/Argentina/Buenos_Aires" })?.countryCode, "AR");
  assert.equal(suggestCountry({ browserLocale: "garbage_", currencyCode: "USD", language: "es" }), null);
});
