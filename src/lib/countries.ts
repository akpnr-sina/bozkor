const ALIASES: Record<string, string> = {
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  turkey: "TR",
};

// Region codes that Intl knows but that are not countries.
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "ZZ"]);

/** Deprecated codes map to their successor, e.g. DD -> DE, UK -> GB. */
function canonicalRegion(code: string): string | null {
  try {
    return new Intl.Locale(`und-${code}`).region ?? null;
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let byName: Map<string, string> | null = null;

function nameIndex(): Map<string, string> {
  if (byName) return byName;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const index = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (!name || name === code) continue;
      const canonical = canonicalRegion(code);
      if (!canonical || NOT_COUNTRIES.has(canonical)) continue;
      const key = normalizeName(name);
      if (!index.has(key)) index.set(key, canonical);
    }
  }
  byName = index;
  return index;
}

/** English country name to ISO 3166 alpha-2, e.g. "United Kingdom" -> "GB". */
export function countryNameToAlpha2(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = normalizeName(name);
  if (!key) return null;
  return ALIASES[key] ?? nameIndex().get(key) ?? null;
}

/** Accepts an alpha-2 code in any case; returns it uppercased or null if malformed. */
export function normalizeAlpha2(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (upper === "UK") return "GB";
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

let countryCodes: Set<string> | null = null;

/** Whether `code` is a canonical ISO 3166 alpha-2 country code: "GB" is, "UK", "EU" and "EN" are not. */
export function isCountryCode(code: string): boolean {
  countryCodes ??= new Set(nameIndex().values());
  return countryCodes.has(code);
}

// ISO 3166-1 alpha-3 to alpha-2 for all 249 officially assigned codes. TED
// (eForms) sends alpha-3; the platform stores alpha-2.
export const ALPHA3_TO_ALPHA2: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ABW: "AW", AFG: "AF", AGO: "AO", AIA: "AI", ALA: "AX", ALB: "AL", AND: "AD", ARE: "AE", ARG: "AR", ARM: "AM",
    ASM: "AS", ATA: "AQ", ATF: "TF", ATG: "AG", AUS: "AU", AUT: "AT", AZE: "AZ", BDI: "BI", BEL: "BE", BEN: "BJ",
    BES: "BQ", BFA: "BF", BGD: "BD", BGR: "BG", BHR: "BH", BHS: "BS", BIH: "BA", BLM: "BL", BLR: "BY", BLZ: "BZ",
    BMU: "BM", BOL: "BO", BRA: "BR", BRB: "BB", BRN: "BN", BTN: "BT", BVT: "BV", BWA: "BW", CAF: "CF", CAN: "CA",
    CCK: "CC", CHE: "CH", CHL: "CL", CHN: "CN", CIV: "CI", CMR: "CM", COD: "CD", COG: "CG", COK: "CK", COL: "CO",
    COM: "KM", CPV: "CV", CRI: "CR", CUB: "CU", CUW: "CW", CXR: "CX", CYM: "KY", CYP: "CY", CZE: "CZ", DEU: "DE",
    DJI: "DJ", DMA: "DM", DNK: "DK", DOM: "DO", DZA: "DZ", ECU: "EC", EGY: "EG", ERI: "ER", ESH: "EH", ESP: "ES",
    EST: "EE", ETH: "ET", FIN: "FI", FJI: "FJ", FLK: "FK", FRA: "FR", FRO: "FO", FSM: "FM", GAB: "GA", GBR: "GB",
    GEO: "GE", GGY: "GG", GHA: "GH", GIB: "GI", GIN: "GN", GLP: "GP", GMB: "GM", GNB: "GW", GNQ: "GQ", GRC: "GR",
    GRD: "GD", GRL: "GL", GTM: "GT", GUF: "GF", GUM: "GU", GUY: "GY", HKG: "HK", HMD: "HM", HND: "HN", HRV: "HR",
    HTI: "HT", HUN: "HU", IDN: "ID", IMN: "IM", IND: "IN", IOT: "IO", IRL: "IE", IRN: "IR", IRQ: "IQ", ISL: "IS",
    ISR: "IL", ITA: "IT", JAM: "JM", JEY: "JE", JOR: "JO", JPN: "JP", KAZ: "KZ", KEN: "KE", KGZ: "KG", KHM: "KH",
    KIR: "KI", KNA: "KN", KOR: "KR", KWT: "KW", LAO: "LA", LBN: "LB", LBR: "LR", LBY: "LY", LCA: "LC", LIE: "LI",
    LKA: "LK", LSO: "LS", LTU: "LT", LUX: "LU", LVA: "LV", MAC: "MO", MAF: "MF", MAR: "MA", MCO: "MC", MDA: "MD",
    MDG: "MG", MDV: "MV", MEX: "MX", MHL: "MH", MKD: "MK", MLI: "ML", MLT: "MT", MMR: "MM", MNE: "ME", MNG: "MN",
    MNP: "MP", MOZ: "MZ", MRT: "MR", MSR: "MS", MTQ: "MQ", MUS: "MU", MWI: "MW", MYS: "MY", MYT: "YT", NAM: "NA",
    NCL: "NC", NER: "NE", NFK: "NF", NGA: "NG", NIC: "NI", NIU: "NU", NLD: "NL", NOR: "NO", NPL: "NP", NRU: "NR",
    NZL: "NZ", OMN: "OM", PAK: "PK", PAN: "PA", PCN: "PN", PER: "PE", PHL: "PH", PLW: "PW", PNG: "PG", POL: "PL",
    PRI: "PR", PRK: "KP", PRT: "PT", PRY: "PY", PSE: "PS", PYF: "PF", QAT: "QA", REU: "RE", ROU: "RO", RUS: "RU",
    RWA: "RW", SAU: "SA", SDN: "SD", SEN: "SN", SGP: "SG", SGS: "GS", SHN: "SH", SJM: "SJ", SLB: "SB", SLE: "SL",
    SLV: "SV", SMR: "SM", SOM: "SO", SPM: "PM", SRB: "RS", SSD: "SS", STP: "ST", SUR: "SR", SVK: "SK", SVN: "SI",
    SWE: "SE", SWZ: "SZ", SXM: "SX", SYC: "SC", SYR: "SY", TCA: "TC", TCD: "TD", TGO: "TG", THA: "TH", TJK: "TJ",
    TKL: "TK", TKM: "TM", TLS: "TL", TON: "TO", TTO: "TT", TUN: "TN", TUR: "TR", TUV: "TV", TWN: "TW", TZA: "TZ",
    UGA: "UG", UKR: "UA", UMI: "UM", URY: "UY", USA: "US", UZB: "UZ", VAT: "VA", VCT: "VC", VEN: "VE", VGB: "VG",
    VIR: "VI", VNM: "VN", VUT: "VU", WLF: "WF", WSM: "WS", YEM: "YE", ZAF: "ZA", ZMB: "ZM", ZWE: "ZW",
    // Kosovo has no ISO code; the EU writes XKX, and 1A0 in its own country table.
    XKX: "XK",
    "1A0": "XK",
  }),
);

/** ISO 3166 alpha-3 as TED sends it to alpha-2, e.g. "DEU" -> "DE"; null when unknown. */
export function alpha3ToAlpha2(code: string | null | undefined): string | null {
  if (!code) return null;
  return ALPHA3_TO_ALPHA2.get(code.trim().toUpperCase()) ?? null;
}
