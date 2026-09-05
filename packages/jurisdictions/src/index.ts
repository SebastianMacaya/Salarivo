// ISO 3166-1 alpha-2. Country availability is separate from parser/legal support.
const countryCodes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
const defaults: Record<string, [string, string]> = {
  AR: ["ARS", "es-AR"], US: ["USD", "en-US"], ES: ["EUR", "es-ES"],
  BR: ["BRL", "pt-BR"], CL: ["CLP", "es-CL"], UY: ["UYU", "es-UY"],
  GB: ["GBP", "en-GB"], CA: ["CAD", "en-CA"], AU: ["AUD", "en-AU"],
  MX: ["MXN", "es-MX"], CO: ["COP", "es-CO"], PE: ["PEN", "es-PE"],
  PY: ["PYG", "es-PY"], BO: ["BOB", "es-BO"], EC: ["USD", "es-EC"],
  FR: ["EUR", "fr-FR"], DE: ["EUR", "de-DE"], IT: ["EUR", "it-IT"],
  PT: ["EUR", "pt-PT"], JP: ["JPY", "ja-JP"], CN: ["CNY", "zh-CN"],
};
export const COUNTRIES = Object.freeze(countryCodes.map((code) => Object.freeze({
  code, currencyCode: defaults[code]?.[0] ?? null,
  locale: defaults[code]?.[1] ?? new Intl.Locale(`und-${code}`).maximize().toString(),
})));
export function getCountry(code: string) { return COUNTRIES.find((country) => country.code === code); }
export function countryName(code: string, locale = "es"): string {
  if (!getCountry(code)) return code;
  try { return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code; }
  catch { return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code; }
}
export type CountrySuggestion = {
  countryCode: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  source: "CONFIRMED" | "DOCUMENT" | "GOOGLE_LOCALE" | "BROWSER_LOCALE" | "TIMEZONE" | "CURRENCY" | "LANGUAGE";
};
export function countryFromLocale(locale?: string | null): string | null {
  if (!locale || locale.length > 100) return null;
  try {
    const region = new Intl.Locale(locale.replaceAll("_", "-")).region;
    return region && getCountry(region) ? region : null;
  } catch { return null; }
}
export function suggestCountry(signals: {
  confirmedCountryCode?: string | null; evidenceCountryCode?: string | null;
  googleLocale?: string | null; browserLocale?: string | null; timezone?: string | null;
  currencyCode?: string | null; language?: string | null;
}): CountrySuggestion | null {
  const candidates: [string | null | undefined, CountrySuggestion["confidence"], CountrySuggestion["source"]][] = [
    [signals.confirmedCountryCode, "HIGH", "CONFIRMED"],
    [signals.evidenceCountryCode, "HIGH", "DOCUMENT"],
    [countryFromLocale(signals.googleLocale), "MEDIUM", "GOOGLE_LOCALE"],
    [countryFromLocale(signals.browserLocale), "MEDIUM", "BROWSER_LOCALE"],
  ];
  const zones: Record<string, string> = {
    "America/Buenos_Aires": "AR", "America/Cordoba": "AR", "America/Mendoza": "AR",
    "America/Sao_Paulo": "BR", "America/Santiago": "CL", "America/Montevideo": "UY",
    "Europe/Madrid": "ES", "Atlantic/Canary": "ES", "America/New_York": "US", "America/Los_Angeles": "US",
  };
  candidates.push([signals.timezone?.startsWith("America/Argentina/") ? "AR" : zones[signals.timezone ?? ""], "LOW", "TIMEZONE"]);
  // Only unambiguous currency signals are useful; USD/EUR and language alone are not.
  const currencies: Record<string, string> = { ARS: "AR", BRL: "BR", CLP: "CL", UYU: "UY", MXN: "MX", COP: "CO", PEN: "PE" };
  candidates.push([currencies[signals.currencyCode ?? ""], "LOW", "CURRENCY"]);
  const candidate = candidates.find(([code]) => code && getCountry(code));
  return candidate ? { countryCode: candidate[0]!, confidence: candidate[1], source: candidate[2] } : null;
}
