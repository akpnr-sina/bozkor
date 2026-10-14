// ISO 639-2 three-letter language codes, as TED sends them in
// "official-language", to the ISO 639-1 two-letter codes profiles filter on.
// TED uses the terminology form (DEU); the bibliographic form (GER) is
// accepted too.
const ALPHA3_TO_ALPHA2: ReadonlyMap<string, string> = new Map([
  // EU official languages
  ["BUL", "BG"], ["CES", "CS"], ["CZE", "CS"], ["DAN", "DA"], ["DEU", "DE"], ["GER", "DE"],
  ["ELL", "EL"], ["GRE", "EL"], ["ENG", "EN"], ["EST", "ET"], ["FIN", "FI"], ["FRA", "FR"],
  ["FRE", "FR"], ["GLE", "GA"], ["HRV", "HR"], ["HUN", "HU"], ["ITA", "IT"], ["LAV", "LV"],
  ["LIT", "LT"], ["MLT", "MT"], ["NLD", "NL"], ["DUT", "NL"], ["POL", "PL"], ["POR", "PT"],
  ["RON", "RO"], ["RUM", "RO"], ["SLK", "SK"], ["SLO", "SK"], ["SLV", "SL"], ["SPA", "ES"],
  ["SWE", "SV"],
  // EEA. Bokmål and Nynorsk count as Norwegian: profiles have one code for it.
  ["ISL", "IS"], ["ICE", "IS"], ["NOR", "NO"], ["NOB", "NO"], ["NNO", "NO"],
  // Co-official in member states
  ["CAT", "CA"], ["EUS", "EU"], ["BAQ", "EU"], ["GLG", "GL"], ["LTZ", "LB"],
  // Candidate countries and neighbours
  ["BOS", "BS"], ["KAT", "KA"], ["GEO", "KA"], ["MKD", "MK"], ["MAC", "MK"], ["RUS", "RU"],
  ["SQI", "SQ"], ["ALB", "SQ"], ["SRP", "SR"], ["TUR", "TR"], ["UKR", "UK"],
]);

const KNOWN_ALPHA2 = new Set(ALPHA3_TO_ALPHA2.values());

/**
 * TED language code to uppercase ISO 639-1, e.g. "ENG" -> "EN". A code that
 * is already one of those two-letter codes comes back as is; anything else,
 * including "MUL" (several languages), is null.
 */
export function languageToAlpha2(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (KNOWN_ALPHA2.has(upper)) return upper;
  return ALPHA3_TO_ALPHA2.get(upper) ?? null;
}
